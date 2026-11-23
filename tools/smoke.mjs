// 视频抽帧 · 冒烟自测（零依赖）
// 流程：造测试视频 → 起服务 → 逐个接口验证 → 数帧、验格式、验采样/截段/缩放/覆盖保护/取消
// 运行：node tools/smoke.mjs
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 47891;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${expected}，实际 ${actual}`);
}

function findFfmpeg() {
  const bin = path.join(ROOT, 'bin');
  const hits = [];
  const walk = (d, depth) => {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isFile() && /^ffmpeg\.exe$/i.test(it.name)) hits.push(p);
      else if (it.isDirectory() && depth > 0) walk(p, depth - 1);
    }
  };
  if (fs.existsSync(bin)) walk(bin, 3);
  return hits[0] || process.env.VFE_FFMPEG || 'ffmpeg';
}

const FFMPEG = findFfmpeg();

function run(exe, args) {
  return new Promise((resolve) => {
    const p = spawn(exe, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, err }));
    p.on('error', (e) => resolve({ code: -1, err: e.message }));
  });
}

async function getJson(url, body) {
  const opt = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const r = await fetch(url, opt);
  return r.json();
}

async function waitJob(id, timeoutMs = 90000) {
  const t0 = Date.now();
  for (;;) {
    const r = await getJson(`${BASE}/api/job?id=${id}`);
    if (!r.ok) throw new Error('任务查询失败：' + (r.error || '?'));
    if (['done', 'error', 'canceled'].includes(r.job.state)) return r.job;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待任务超时');
    await new Promise((res) => setTimeout(res, 150));
  }
}

async function listImages(dir, prefix, ext) {
  const names = (await fsp.readdir(dir)).filter((n) => n.startsWith(prefix + '_') && n.endsWith('.' + ext)).sort();
  return names;
}

async function main() {
  console.log('\n视频抽帧 · 冒烟自测');
  console.log('ffmpeg:', FFMPEG);

  // 注意：在 DSH 的受限 shell 里 %TEMP% 是沙箱目录，子进程无写权限，
  // 所以测试工作目录放在项目内，跑完即删。
  const workRoot = path.join(ROOT, '.smoke-tmp');
  await fsp.mkdir(workRoot, { recursive: true });
  const work = await fsp.mkdtemp(path.join(workRoot, 'vfe-smoke-中文-'));
  const video = path.join(work, '测试视频.mp4');
  const outRoot = path.join(work, '输出');

  console.log('\n[0] 造测试视频（320×180 / 25fps / 4 秒 = 100 帧）');
  const gen = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '4',
    '-pix_fmt', 'yuv420p', video]);
  ok('生成测试视频', gen.code === 0 && fs.existsSync(video), gen.err.slice(-300));
  if (gen.code !== 0) { console.log('\n无法生成测试视频，终止'); process.exit(1); }

  console.log('\n[1] 起服务');
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(PORT), '--no-open'],
    { cwd: ROOT, windowsHide: true, env: { ...process.env, VFE_PICK_DRYRUN: '1' } });
  let srvLog = '';
  srv.stdout.on('data', (d) => { srvLog += d; });
  srv.stderr.on('data', (d) => { srvLog += d; });

  let env = null;
  for (let i = 0; i < 100; i++) {
    try { env = await getJson(`${BASE}/api/env`); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  ok('服务已就绪', Boolean(env?.ok), srvLog.slice(-400));
  if (!env?.ok) { srv.kill(); process.exit(1); }
  ok('ffmpeg 可执行', Boolean(env.ffmpegVersion), String(env.ffmpegVersion));
  ok('ffprobe 可执行', Boolean(env.ffprobeVersion), String(env.ffprobeVersion));
  console.log(`     FFmpeg ${env.ffmpegVersion} | ${env.ffmpeg}`);

  console.log('\n[2] 识别视频信息');
  const p1 = await getJson(`${BASE}/api/probe`, { path: video });
  ok('probe 成功', p1.ok === true, p1.error || '');
  eq('宽度', p1.info.width, 320);
  eq('高度', p1.info.height, 180);
  eq('帧率', p1.info.fps, 25);
  ok('时长≈4s', Math.abs(p1.info.duration - 4) < 0.15, String(p1.info.duration));
  ok('编码 h264', p1.info.codec === 'h264', p1.info.codec);
  ok('帧数 100', p1.info.frames === 100, String(p1.info.frames));

  console.log('\n[3] 全帧导出 PNG');
  const dir1 = path.join(outRoot, 'png');
  const j1 = await getJson(`${BASE}/api/start`, { input: video, outDir: dir1, format: 'png', mode: 'all', prefix: 'frame' });
  ok('任务已启动', j1.ok === true, j1.error || '');
  const d1 = await waitJob(j1.id);
  eq('任务状态 done', d1.state, 'done');
  const imgs1 = await listImages(dir1, 'frame', 'png');
  eq('PNG 张数', imgs1.length, 100);
  eq('首帧名', imgs1[0], 'frame_000001.png');
  eq('末帧名', imgs1[imgs1.length - 1], 'frame_000100.png');
  const head1 = await fsp.readFile(path.join(dir1, imgs1[0]));
  ok('是合法 PNG', head1[0] === 0x89 && head1[1] === 0x50 && head1[2] === 0x4e && head1[3] === 0x47);
  ok('统计到体积', d1.totalBytes > 0, String(d1.totalBytes));

  console.log('\n[4] 覆盖保护');
  const again = await getJson(`${BASE}/api/start`, { input: video, outDir: dir1, format: 'png', mode: 'all', prefix: 'frame' });
  ok('同名文件被拦下', again.ok === false && /已有/.test(again.error || ''), again.error || '');

  console.log('\n[5] 每 2 帧取 1 张 → JPG');
  const dir2 = path.join(outRoot, 'jpg');
  const j2 = await getJson(`${BASE}/api/start`, { input: video, outDir: dir2, format: 'jpg', mode: 'every', step: 2, quality: 3, prefix: 'f' });
  const d2 = await waitJob(j2.id);
  eq('任务状态 done', d2.state, 'done');
  const imgs2 = await listImages(dir2, 'f', 'jpg');
  eq('JPG 张数', imgs2.length, 50);
  const head2 = await fsp.readFile(path.join(dir2, imgs2[0]));
  ok('是合法 JPEG', head2[0] === 0xff && head2[1] === 0xd8 && head2[2] === 0xff);

  console.log('\n[6] 每秒 5 张 → 20 张');
  const dir3 = path.join(outRoot, 'fps');
  const j3 = await getJson(`${BASE}/api/start`, { input: video, outDir: dir3, format: 'png', mode: 'fps', fps: 5, prefix: 's' });
  const d3 = await waitJob(j3.id);
  eq('任务状态 done', d3.state, 'done');
  eq('张数', (await listImages(dir3, 's', 'png')).length, 20);

  console.log('\n[6b] WebP（每秒 2 张 → 8 张）');
  const dirW = path.join(outRoot, 'webp');
  const jw = await getJson(`${BASE}/api/start`, {
    input: video, outDir: dirW, format: 'webp', mode: 'fps', fps: 2, quality: 85, prefix: 'w',
  });
  const dw = await waitJob(jw.id);
  eq('任务状态 done', dw.state, 'done');
  const imgsW = await listImages(dirW, 'w', 'webp');
  eq('WebP 张数', imgsW.length, 8);
  const headW = await fsp.readFile(path.join(dirW, imgsW[0]));
  ok('是合法 WebP', headW.toString('ascii', 0, 4) === 'RIFF' && headW.toString('ascii', 8, 12) === 'WEBP');

  console.log('\n[7] 截取 1s–2s 全帧 → 25 张');
  const dir4 = path.join(outRoot, 'trim');
  const j4 = await getJson(`${BASE}/api/start`, { input: video, outDir: dir4, format: 'png', mode: 'all', start: 1, end: 2, prefix: 't' });
  const d4 = await waitJob(j4.id);
  eq('任务状态 done', d4.state, 'done');
  const n4 = (await listImages(dir4, 't', 'png')).length;
  ok('张数 24–26', n4 >= 24 && n4 <= 26, String(n4));

  console.log('\n[8] 缩放到宽 160');
  const dir5 = path.join(outRoot, 'scale');
  const j5 = await getJson(`${BASE}/api/start`, { input: video, outDir: dir5, format: 'png', mode: 'fps', fps: 1, scaleWidth: 160, prefix: 'z' });
  const d5 = await waitJob(j5.id);
  eq('任务状态 done', d5.state, 'done');
  const wh = await new Promise((resolve) => {
    const p = spawn(env.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(dir5, 'z_000001.png')], { windowsHide: true });
    let o = '';
    p.stdout.on('data', (d) => { o += d; });
    p.on('close', () => resolve(o.trim()));
  });
  ok('输出宽度为 160', /^160,/.test(wh), wh || '(空)');

  console.log('\n[9] 中文输出目录 + 取消');
  const dir6 = path.join(work, '中文目录', '子目录');
  const j6 = await getJson(`${BASE}/api/start`, { input: video, outDir: dir6, format: 'png', mode: 'all', prefix: 'c' });
  const d6 = await waitJob(j6.id);
  eq('中文路径导出成功', d6.state, 'done');
  ok('中文路径有文件', d6.files === 100, String(d6.files));

  const longVideo = path.join(work, '长视频.mp4');
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=25', '-t', '20', '-pix_fmt', 'yuv420p', longVideo]);
  const dir7 = path.join(outRoot, 'cancel');
  const j7 = await getJson(`${BASE}/api/start`, { input: longVideo, outDir: dir7, format: 'png', mode: 'all', prefix: 'x' });
  await getJson(`${BASE}/api/cancel`, { id: j7.id, clean: false });
  const d7 = await waitJob(j7.id, 30000);
  eq('取消后状态 canceled', d7.state, 'canceled');
  ok('取消后不再产出', d7.state === 'canceled', d7.state);

  console.log('\n[10] 拖拽上传接口');
  const buf = await fsp.readFile(video);
  const up = await fetch(`${BASE}/api/upload?name=${encodeURIComponent('上传测试.mp4')}`, {
    method: 'POST', body: buf, headers: { 'Content-Type': 'application/octet-stream' },
  }).then((r) => r.json());
  ok('上传成功', up.ok === true && fs.existsSync(up.path), up.error || '');
  if (up.ok) {
    const pu = await getJson(`${BASE}/api/probe`, { path: up.path });
    ok('上传文件可识别', pu.ok && pu.info.frames === 100, pu.error || String(pu.info?.frames));
    ok('上传文件默认输出到图片库', /Pictures/.test(pu.info.suggestedOut), pu.info?.suggestedOut);
    await fsp.rm(up.path, { force: true });
  }

  console.log('\n[11] 选择框脚本语法（dry-run，不弹窗）');
  const pk = await getJson(`${BASE}/api/pick`, { kind: 'video' });
  ok('视频选择框脚本可解析', pk.ok === true && pk.path === 'PARSE_OK', pk.error || String(pk.path));
  const pd = await getJson(`${BASE}/api/pick`, { kind: 'dir' });
  ok('文件夹选择框脚本可解析', pd.ok === true && pd.path === 'PARSE_OK', pd.error || String(pd.path));

  srv.kill();
  await new Promise((r) => setTimeout(r, 300));
  await fsp.rm(work, { recursive: true, force: true });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('全部通过 ✓\n');
}

main().catch((e) => {
  console.error('\n自测异常：', e);
  process.exit(1);
});
