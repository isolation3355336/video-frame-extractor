// 视频抽帧 · 本地中枢（零依赖，只用 Node 内置模块）
// 职责：找 ffmpeg → 探测视频信息 → 调 ffmpeg 全帧导出 → 用 SSE 推进度 → 取消/打开目录
// 只监听 127.0.0.1，不对外网开放。
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, 'app');
const VERSION = '1.0.0';

// ---------- 命令行参数 ----------
const argv = process.argv.slice(2);
function argValue(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const PORT = Number(argValue('--port', '47820'));
const HOST = '127.0.0.1';
const OPEN_BROWSER = !argv.includes('--no-open');

// ---------- 找 ffmpeg / ffprobe ----------
function firstExisting(list) {
  for (const p of list) {
    if (!p) continue;
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* 忽略 */ }
  }
  return null;
}

function scanBin(dir, depth = 3) {
  const found = [];
  const walk = (d, left) => {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isFile() && /^ffmpeg(\.exe)?$/i.test(it.name)) found.push(p);
      else if (it.isDirectory() && left > 0) walk(p, left - 1);
    }
  };
  walk(dir, depth);
  return found;
}

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

function findOnPath(name) {
  const r = spawnSync(IS_WIN ? 'where' : 'which', [IS_WIN ? `${name}.exe` : name],
    { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function resolveTools() {
  const binDir = path.join(HERE, 'bin');
  const fromBin = fs.existsSync(binDir) ? scanBin(binDir) : [];
  const ffmpeg = firstExisting([
    process.env.VFE_FFMPEG,
    ...fromBin,
    ...findOnPath('ffmpeg'),
  ]) || 'ffmpeg';

  const dir = path.dirname(ffmpeg);
  const ffprobe = firstExisting([
    process.env.VFE_FFPROBE,
    path.join(dir, `ffprobe${EXE}`),
    ...scanBin(binDir, 3).map((p) => path.join(path.dirname(p), `ffprobe${EXE}`)),
    ...findOnPath('ffprobe'),
  ]) || 'ffprobe';

  return { ffmpeg, ffprobe };
}

const TOOLS = resolveTools();

function toolVersion(exe) {
  try {
    const r = spawnSync(exe, ['-version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (r.error || r.status !== 0) return null;
    const m = /version\s+(\S+)/.exec(r.stdout || '');
    return m ? m[1] : 'unknown';
  } catch { return null; }
}

const FFMPEG_VERSION = toolVersion(TOOLS.ffmpeg);
const FFPROBE_VERSION = toolVersion(TOOLS.ffprobe);
const MODERN = (() => {
  const m = /^(\d+)\.(\d+)/.exec(FFMPEG_VERSION || '');
  if (!m) return true;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 5 || (maj === 5 && min >= 1); // -fps_mode 从 5.1 起
})();

// ---------- 小工具 ----------
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 2e6) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

async function diskFree(dir) {
  try {
    const st = await fsp.statfs(dir);
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch { return { free: null, total: null }; }
}

function sanitizeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim() || 'video';
}

// ---------- PS 对话框（编码走 UTF-16LE + Base64，中文路径安全） ----------
function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    // VFE_PICK_DRYRUN=1：只做语法解析、不弹窗，供自测使用
    const dry = process.env.VFE_PICK_DRYRUN === '1';
    const inner = Buffer.from(script, 'utf16le').toString('base64');
    const code = dry
      ? `$src = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${inner}')); `
        + `$null = [ScriptBlock]::Create($src); [Console]::Out.Write('PARSE_OK')`
      : script;
    const b64 = Buffer.from(code, 'utf16le').toString('base64');
    const ps = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
      { windowsHide: true });
    let out = ''; let err = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', (d) => { err += d; });
    ps.on('error', reject);
    ps.on('close', (code) => resolve({ code, stdout: out.trim(), stderr: err.trim() }));
  });
}

const PS_PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
$owner = New-Object System.Windows.Forms.Form
$owner.Text = '视频抽帧'
$owner.FormBorderStyle = 'None'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.StartPosition = 'CenterScreen'
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Opacity = 0.01
$owner.Show()
`;

async function pickVideo(initialDir) {
  if (!IS_WIN) return { path: '', error: '文件选择框目前只支持 Windows，请直接把视频路径粘贴到输入框' };
  const init = initialDir ? `$dlg.InitialDirectory = '${String(initialDir).replace(/'/g, "''")}'` : '';
  const script = `${PS_PRELUDE}
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = '选择要抽帧的视频文件'
$dlg.Filter = '视频文件|*.mp4;*.mkv;*.mov;*.avi;*.flv;*.wmv;*.webm;*.ts;*.m2ts;*.m4v;*.mpg;*.mpeg;*.3gp;*.ogv;*.gif;*.rmvb|所有文件|*.*'
$dlg.CheckFileExists = $true
$dlg.Multiselect = $false
${init}
$r = $dlg.ShowDialog($owner)
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.FileName) }
$owner.Close()
`;
  const r = await runPowerShell(script);
  return { path: r.stdout || '', error: r.code !== 0 ? r.stderr : '' };
}

async function pickFolder(initialDir) {
  if (!IS_WIN) return { path: '', error: '文件夹选择框目前只支持 Windows，请手动输入保存路径' };
  const init = initialDir ? `$dlg.SelectedPath = '${String(initialDir).replace(/'/g, "''")}'` : '';
  const script = `${PS_PRELUDE}
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '选择导出图片保存的文件夹'
$dlg.ShowNewFolderButton = $true
${init}
$r = $dlg.ShowDialog($owner)
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }
$owner.Close()
`;
  const r = await runPowerShell(script);
  return { path: r.stdout || '', error: r.code !== 0 ? r.stderr : '' };
}

// ---------- 探测视频 ----------
const probeCache = new Map();

function parseRate(s) {
  if (!s || s === 'N/A') return 0;
  const [a, b] = String(s).split('/').map(Number);
  if (!b) return Number(a) || 0;
  return a / b;
}

function runTool(exe, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true });
    let out = ''; let err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch { /* 忽略 */ } }, timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { if (err.length < 64000) err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

async function probeFile(file) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw new Error('文件不存在，或不是一个文件');
  const cacheKey = `${file}|${st.size}|${st.mtimeMs}`;
  if (probeCache.has(cacheKey)) return probeCache.get(cacheKey);

  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
    '-select_streams', 'v:0', file];
  const r = await runTool(TOOLS.ffprobe, args);
  if (r.code !== 0) {
    const msg = (r.stderr || '').trim().split('\n').slice(-2).join(' ');
    throw new Error(`ffprobe 读取失败：${msg || '未知错误'}（文件可能损坏或不是视频）`);
  }
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { throw new Error('ffprobe 输出无法解析'); }

  const stream = (parsed.streams || [])[0];
  if (!stream) throw new Error('这个文件里没有视频画面轨道（可能是纯音频）');

  const duration = num(parsed.format?.duration) || num(stream.duration);
  const fps = parseRate(stream.avg_frame_rate) || parseRate(stream.r_frame_rate);
  let frames = num(stream.nb_frames);
  const framesExact = frames > 0;
  if (!frames) frames = duration > 0 && fps > 0 ? Math.round(duration * fps) : 0;

  let rotation = 0;
  const sd = (stream.side_data_list || []).find((d) => d.rotation !== undefined);
  if (sd) rotation = Math.round(Math.abs(num(sd.rotation)));
  else if (stream.tags?.rotate) rotation = Math.round(Math.abs(num(stream.tags.rotate)));
  const swap = rotation === 90 || rotation === 270;

  const base = path.basename(file, path.extname(file));
  const dir = path.dirname(file);
  const isTemp = dir.toLowerCase().startsWith(path.join(os.tmpdir(), 'vfe-uploads').toLowerCase());
  let suggestedOut = isTemp
    ? path.join(os.homedir(), 'Pictures', '视频抽帧', `${sanitizeName(base)}_${stamp()}`)
    : path.join(dir, `${sanitizeName(base)}_frames`);

  const info = {
    path: file,
    name: path.basename(file),
    size: st.size,
    sizeText: humanSize(st.size),
    duration,
    durationText: fmtDuration(duration),
    width: num(stream.width),
    height: num(stream.height),
    displayWidth: swap ? num(stream.height) : num(stream.width),
    displayHeight: swap ? num(stream.width) : num(stream.height),
    rotation,
    fps: Math.round(fps * 1000) / 1000,
    fpsText: fps ? (Math.abs(fps - Math.round(fps)) < 0.01 ? String(Math.round(fps)) : fps.toFixed(3)) : '未知',
    codec: stream.codec_name || '未知',
    pixFmt: stream.pix_fmt || '',
    bitrate: num(parsed.format?.bit_rate) || num(stream.bit_rate),
    frames,
    framesExact,
    container: parsed.format?.format_name || '',
    suggestedOut,
    isTempUpload: isTemp,
  };
  probeCache.set(cacheKey, info);
  if (probeCache.size > 50) probeCache.delete(probeCache.keys().next().value);
  return info;
}

// 精确帧数（逐包统计，不解码，快但不读像素）
async function countFrames(file) {
  const r = await runTool(TOOLS.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-count_packets',
      '-show_entries', 'stream=nb_read_packets', '-print_format', 'json', file], 300000);
  if (r.code !== 0) throw new Error('统计帧数失败');
  const p = JSON.parse(r.stdout);
  return num(p.streams?.[0]?.nb_read_packets);
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------- 任务 ----------
const jobs = new Map();
let currentJob = null;

function makeJobId() { return crypto.randomBytes(6).toString('hex'); }

function broadcast(job) {
  const payload = `data: ${JSON.stringify(snapshot(job))}\n\n`;
  for (const res of job.clients) {
    try { res.write(payload); } catch { /* 断开的连接忽略 */ }
  }
}

function snapshot(job) {
  return {
    id: job.id,
    state: job.state,
    input: job.cfg.input,
    inputName: job.cfg.inputName,
    outDir: job.outDir,
    format: job.cfg.format,
    mode: job.cfg.mode,
    expected: job.expected,
    expectedExact: job.expectedExact,
    done: job.done,
    fps: job.speedFps,
    percent: job.expected > 0 ? clamp((job.done / job.expected) * 100, 0, 99.9) : (job.state === 'done' ? 100 : 0),
    elapsed: job.startedAt ? (job.endedAt || Date.now()) - job.startedAt : 0,
    eta: job.eta,
    files: job.files,
    totalBytes: job.totalBytes,
    error: job.error,
    logTail: job.logTail.slice(-8),
    startedAt: job.startedAt,
    endedAt: job.endedAt,
  };
}

function buildArgs(cfg, job) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats',
    '-progress', 'pipe:1', '-y'];

  // 输入侧定位（先 -ss 再 -i 走关键帧快速定位，转码时 ffmpeg 会自动精确到帧）
  if (cfg.start > 0) args.push('-ss', String(cfg.start));
  args.push('-i', cfg.input);
  if (cfg.end > cfg.start) args.push('-t', String(+(cfg.end - cfg.start).toFixed(3)));

  args.push('-map', '0:v:0', '-an', '-sn', '-dn');

  const vf = [];
  if (cfg.mode === 'every') vf.push(`select=not(mod(n\\,${cfg.step}))`);
  else if (cfg.mode === 'fps') vf.push(`fps=${cfg.fps}`);
  if (cfg.scaleWidth > 0) vf.push(`scale=${cfg.scaleWidth}:-2:flags=lanczos`);
  if (vf.length) args.push('-vf', vf.join(','));

  // 逐帧输出：不做重复/丢弃，保证「所有帧」就是所有帧
  args.push(...(MODERN ? ['-fps_mode', 'passthrough'] : ['-vsync', '0']));

  if (cfg.format === 'jpg') args.push('-q:v', String(clamp(cfg.quality, 1, 31)));
  else if (cfg.format === 'webp') {
    // .webp 默认会走「动图」封装器（只出一个文件），必须显式指定静态编码器 + image2
    args.push('-c:v', 'libwebp', '-quality', String(clamp(cfg.quality, 1, 100)));
  } else if (cfg.format === 'png') args.push('-compression_level', '3');

  args.push('-f', 'image2', '-start_number', String(cfg.startNumber));
  args.push(path.join(job.outDir, `${cfg.prefix}_%06d.${cfg.format}`));
  return args;
}

function expectedFrames(info, cfg) {
  const totalAll = info.frames || 0;
  let total = totalAll;
  if (cfg.end > cfg.start && info.duration > 0) {
    const dur = Math.min(cfg.end, info.duration) - cfg.start;
    total = info.framesExact
      ? Math.round((totalAll * dur) / info.duration)
      : Math.round(dur * info.fps);
  }
  if (cfg.mode === 'every') return { n: Math.max(1, Math.ceil(total / cfg.step)), exact: info.framesExact };
  if (cfg.mode === 'fps') {
    const dur = cfg.end > cfg.start ? Math.min(cfg.end, info.duration) - cfg.start : info.duration;
    return { n: Math.max(1, Math.round(dur * cfg.fps)), exact: true };
  }
  return { n: total, exact: info.framesExact };
}

async function startJob(cfg) {
  if (currentJob && ['running', 'canceling'].includes(currentJob.state)) {
    throw new Error('已有一个导出任务在运行，请先等它完成或点取消');
  }
  const info = await probeFile(cfg.input);
  if (!finalFfmpegOk()) throw new Error('找不到可用的 ffmpeg，请把 ffmpeg.exe 放进 bin\\ 目录，或用 VFE_FFMPEG 指定路径');

  const format = ['png', 'jpg', 'webp', 'bmp', 'tiff'].includes(cfg.format) ? cfg.format : 'png';
  const start = clamp(num(cfg.start), 0, info.duration || 0);
  const end = cfg.end === null || cfg.end === '' || cfg.end === undefined
    ? (info.duration || 0)
    : clamp(num(cfg.end), 0, info.duration || 0);
  const cleanCfg = {
    input: cfg.input,
    inputName: info.name,
    format,
    mode: ['all', 'every', 'fps'].includes(cfg.mode) ? cfg.mode : 'all',
    step: clamp(Math.round(num(cfg.step, 1)), 1, 100000),
    fps: clamp(num(cfg.fps, 1), 0.01, 240),
    start,
    end,
    scaleWidth: clamp(Math.round(num(cfg.scaleWidth, 0)), 0, 16384),
    quality: clamp(Math.round(num(cfg.quality, 2)), 1, 100),
    prefix: sanitizeName(cfg.prefix || 'frame').replace(/\s+/g, '_').slice(0, 40),
    startNumber: clamp(Math.round(num(cfg.startNumber, 1)), 0, 999999),
  };

  let outDir = cfg.outDir && String(cfg.outDir).trim() ? String(cfg.outDir).trim() : info.suggestedOut;
  outDir = path.resolve(outDir);
  // 输出目录不能是视频所在目录本身，否则会把图片混进原文件夹
  if (outDir.toLowerCase() === path.dirname(cleanCfg.input).toLowerCase()) {
    outDir = path.join(outDir, `${sanitizeName(path.basename(cleanCfg.input, path.extname(cleanCfg.input)))}_frames`);
  }
  await fsp.mkdir(outDir, { recursive: true });

  const existing = (await fsp.readdir(outDir)).filter((f) =>
    f.startsWith(`${cleanCfg.prefix}_`) && f.endsWith(`.${cleanCfg.format}`));
  if (existing.length > 0 && !cfg.allowExisting) {
    throw new Error(`输出目录里已有 ${existing.length} 张同名图片（${cleanCfg.prefix}_*.${cleanCfg.format}），会被覆盖。`
      + '请换个输出文件夹或改名前缀，确认覆盖请勾选「允许覆盖已有文件」');
  }

  const exp = expectedFrames(info, cleanCfg);
  const job = {
    id: makeJobId(),
    state: 'running',
    cfg: cleanCfg,
    outDir,
    expected: exp.n,
    expectedExact: exp.exact,
    done: 0,
    speedFps: 0,
    eta: null,
    files: 0,
    totalBytes: 0,
    error: '',
    logTail: [],
    clients: new Set(),
    child: null,
    startedAt: Date.now(),
    endedAt: null,
    canceled: false,
    info,
  };
  jobs.set(job.id, job);
  currentJob = job;

  const args = buildArgs(cleanCfg, job);
  const child = spawn(TOOLS.ffmpeg, args, { windowsHide: true });
  job.child = child;

  let buf = '';
  const handleLine = (line) => {
    const eq = line.indexOf('=');
    if (eq <= 0) return;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k === 'frame') {
      const n = Number(v);
      if (Number.isFinite(n)) {
        job.done = n;
        const elapsed = (Date.now() - job.startedAt) / 1000;
        job.speedFps = elapsed > 0.2 ? n / elapsed : 0;
        const left = job.expected - n;
        job.eta = job.speedFps > 0.1 && left > 0 ? left / job.speedFps : null;
        broadcast(job);
      }
    } else if (k === 'fps' && !Number.isFinite(Number(v))) {
      // 保留
    } else if (k === 'speed') {
      job.speedText = v;
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const t = line.trim();
      if (t) {
        job.logTail.push(t);
        if (job.logTail.length > 60) job.logTail.shift();
      }
    }
    if (job.logTail.length) broadcast(job);
  });

  const finish = async (code, spawnErr) => {
    job.endedAt = Date.now();
    job.child = null;
    if (spawnErr) {
      job.state = 'error';
      job.error = `无法启动 ffmpeg：${spawnErr.message}`;
    } else if (job.canceled) {
      job.state = 'canceled';
    } else if (code === 0) {
      const counted = await countOutputs(job);
      job.files = counted.files;
      job.totalBytes = counted.bytes;
      if (counted.files === 0) {
        job.state = 'error';
        job.error = 'ffmpeg 正常退出但一张图都没产出。常见原因：时间范围超出了视频长度，或抽样间隔大于总帧数。';
      } else {
        job.state = 'done';
        job.done = counted.files;
      }
    } else {
      job.state = 'error';
      const tail = job.logTail.slice(-3).join(' ');
      job.error = tail || `ffmpeg 异常退出（退出码 ${code}）`;
    }
    if (currentJob === job) currentJob = null;
    broadcast(job);
    for (const res of job.clients) { try { res.end(); } catch { /* 忽略 */ } }
    job.clients.clear();
  };

  child.on('error', (e) => finish(-1, e));
  child.on('close', (code) => finish(code, null));

  return { id: job.id, expected: job.expected, expectedExact: job.expectedExact, outDir, framesOfVideo: info.frames };
}

function finalFfmpegOk() {
  return Boolean(FFMPEG_VERSION);
}

async function countOutputs(job) {
  let names = [];
  try { names = await fsp.readdir(job.outDir); } catch { return { files: 0, bytes: 0 }; }
  const re = new RegExp(`^${job.cfg.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+)\\.${job.cfg.format}$`);
  let files = 0; let bytes = 0;
  for (const n of names) {
    if (!re.test(n)) continue;
    files++;
    try { bytes += (await fsp.stat(path.join(job.outDir, n))).size; } catch { /* 忽略 */ }
  }
  return { files, bytes };
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

async function serveStatic(res, rel) {
  const file = path.join(APP_DIR, rel === '/' ? 'index.html' : rel.replace(/^\/+/, ''));
  if (!file.startsWith(APP_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 找不到页面');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  // 只接受本机访问
  const remote = req.socket.remoteAddress || '';
  if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
    res.writeHead(403); return res.end('local only');
  }

  try {
    if (p === '/api/env' && req.method === 'GET') {
      const free = await diskFree(os.homedir());
      return json(res, 200, {
        ok: finalFfmpegOk(),
        version: VERSION,
        ffmpeg: TOOLS.ffmpeg,
        ffmpegVersion: FFMPEG_VERSION,
        ffprobe: TOOLS.ffprobe,
        ffprobeVersion: FFPROBE_VERSION,
        modern: MODERN,
        home: os.homedir(),
        pictures: path.join(os.homedir(), 'Pictures'),
        freeSpace: free.free,
        busy: Boolean(currentJob && ['running', 'canceling'].includes(currentJob.state)),
      });
    }

    if (p === '/api/probe' && req.method === 'POST') {
      const body = await readJson(req);
      const file = String(body.path || '').trim().replace(/^"|"$/g, '');
      if (!file) return json(res, 400, { ok: false, error: '请先给出视频路径' });
      const info = await probeFile(file);
      return json(res, 200, { ok: true, info });
    }

    if (p === '/api/count' && req.method === 'POST') {
      const body = await readJson(req);
      const info = await probeFile(String(body.path || ''));
      const n = await countFrames(info.path);
      if (!n) return json(res, 400, { ok: false, error: '统计不到帧数' });
      info.frames = n; info.framesExact = true;
      return json(res, 200, { ok: true, frames: n });
    }

    if (p === '/api/pick' && req.method === 'POST') {
      const body = await readJson(req);
      const kind = body.kind === 'dir' ? 'dir' : 'video';
      const r = kind === 'dir' ? await pickFolder(body.initial) : await pickVideo(body.initial);
      if (!r.path && r.error) return json(res, 500, { ok: false, error: r.error });
      return json(res, 200, { ok: true, path: r.path });
    }

    if (p === '/api/start' && req.method === 'POST') {
      const body = await readJson(req);
      const started = await startJob(body);
      return json(res, 200, { ok: true, ...started });
    }

    if (p === '/api/cancel' && req.method === 'POST') {
      const body = await readJson(req);
      const job = jobs.get(String(body.id || '')) || currentJob;
      if (!job || !job.child) return json(res, 400, { ok: false, error: '没有正在运行的任务' });
      job.canceled = true;
      job.state = 'canceling';
      broadcast(job);
      try { job.child.kill(); } catch { /* 忽略 */ }
      if (body.clean) {
        setTimeout(async () => {
          await removeOutputs(job).catch(() => {});
        }, 800);
      }
      return json(res, 200, { ok: true });
    }

    if (p === '/api/job' && req.method === 'GET') {
      const job = jobs.get(String(url.searchParams.get('id') || ''));
      if (!job) return json(res, 404, { ok: false, error: '任务不存在' });
      return json(res, 200, { ok: true, job: snapshot(job) });
    }

    if (p === '/api/events' && req.method === 'GET') {
      const job = jobs.get(String(url.searchParams.get('id') || ''));
      if (!job) { res.writeHead(404); return res.end('no such job'); }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(snapshot(job))}\n\n`);
      if (['done', 'error', 'canceled'].includes(job.state)) return res.end();
      job.clients.add(res);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* 忽略 */ } }, 15000);
      req.on('close', () => { clearInterval(hb); job.clients.delete(res); });
      return;
    }

    if (p === '/api/reveal' && req.method === 'POST') {
      const body = await readJson(req);
      const target = path.resolve(String(body.path || ''));
      const select = Boolean(body.select);
      if (!fs.existsSync(target)) return json(res, 400, { ok: false, error: '路径不存在' });
      const isDir = fs.statSync(target).isDirectory();
      if (IS_WIN) {
        spawn('explorer.exe', [select && !isDir ? `/select,${target}` : target],
          { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', select && !isDir ? ['-R', target] : [target], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [isDir ? target : path.dirname(target)], { detached: true, stdio: 'ignore' }).unref();
      }
      return json(res, 200, { ok: true });
    }

    if (p === '/api/upload' && (req.method === 'POST' || req.method === 'PUT')) {
      const raw = url.searchParams.get('name') || 'video';
      const safe = sanitizeName(path.basename(raw)).slice(-80);
      const dir = path.join(os.tmpdir(), 'vfe-uploads');
      await fsp.mkdir(dir, { recursive: true });
      const dest = path.join(dir, `${stamp()}-${crypto.randomBytes(3).toString('hex')}-${safe}`);
      const ws = fs.createWriteStream(dest);
      let bytes = 0;
      req.on('data', (d) => { bytes += d.length; });
      req.pipe(ws);
      await new Promise((resolve, reject) => {
        ws.on('finish', resolve);
        ws.on('error', reject);
        req.on('error', reject);
        req.on('aborted', () => reject(new Error('上传中断')));
      });
      return json(res, 200, { ok: true, path: dest, size: bytes });
    }

    if (p === '/api/space' && req.method === 'POST') {
      const body = await readJson(req);
      let dir = String(body.path || '').trim();
      if (!dir) dir = os.homedir();
      while (dir && !fs.existsSync(dir)) dir = path.dirname(dir);
      const free = await diskFree(dir || os.homedir());
      return json(res, 200, { ok: true, ...free });
    }

    if (p.startsWith('/api/')) return json(res, 404, { ok: false, error: '接口不存在' });

    return serveStatic(res, p);
  } catch (e) {
    return json(res, 400, { ok: false, error: e?.message || String(e) });
  }
});

async function removeOutputs(job) {
  let names = [];
  try { names = await fsp.readdir(job.outDir); } catch { return; }
  const re = new RegExp(`^${job.cfg.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+)\\.${job.cfg.format}$`);
  for (const n of names) {
    if (re.test(n)) await fsp.unlink(path.join(job.outDir, n)).catch(() => {});
  }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。换一个端口再试：node server.mjs --port 47821`);
    process.exit(1);
  }
  console.error('服务启动失败：', e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  视频抽帧 已启动');
  console.log(`  地址    ${url}`);
  console.log(`  引擎    ${FFMPEG_VERSION ? `FFmpeg ${FFMPEG_VERSION} (${MODERN ? 'fps_mode' : 'vsync'})` : '未找到 ffmpeg'}`);
  console.log(`  路径    ${TOOLS.ffmpeg}`);
  if (!FFMPEG_VERSION) console.log('  ⚠ 未检测到 ffmpeg，导出会失败：请把 ffmpeg.exe 放进 bin\\ 目录');
  console.log('');
  console.log('  关闭这个窗口即停止服务。');
  console.log('');
  if (OPEN_BROWSER) {
    if (IS_WIN) {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  }
});

process.on('SIGINT', () => {
  if (currentJob?.child) { try { currentJob.child.kill(); } catch { /* 忽略 */ } }
  process.exit(0);
});
