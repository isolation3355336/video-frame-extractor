#Requires -Version 5.1
<#
.SYNOPSIS
  Download a static FFmpeg build and install ffmpeg.exe + ffprobe.exe into bin\ffmpeg\.

.DESCRIPTION
  The binaries are large (~170 MB unpacked) and are intentionally not committed to
  the repository. Run this once after cloning, or drop your own builds into
  bin\ffmpeg\ manually.

.PARAMETER Url
  Zip archive to download. Default: gyan.dev "essentials" release build (Windows x64).
  Alternatives:
    https://github.com/BtbN/FFmpeg-Builds/releases/latest   (pick *-win64-gpl.zip)

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\fetch-ffmpeg.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\fetch-ffmpeg.ps1 -Url https://example.com/ffmpeg.zip
#>
param(
  [string]$Url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root 'bin\ffmpeg'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$tmpZip = Join-Path $env:TEMP ('ffmpeg-' + [guid]::NewGuid().ToString('N') + '.zip')
$tmpDir = Join-Path $env:TEMP ('ffmpeg-x-' + [guid]::NewGuid().ToString('N'))

try {
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $tmpZip -UseBasicParsing
  $mb = (Get-Item $tmpZip).Length / 1MB
  Write-Host ("Downloaded {0:N1} MB" -f $mb)

  Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force

  $ff = Get-ChildItem -Path $tmpDir -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
  $fp = Get-ChildItem -Path $tmpDir -Recurse -Filter 'ffprobe.exe' | Select-Object -First 1
  if (-not $ff) { throw 'ffmpeg.exe was not found inside the archive.' }

  Copy-Item $ff.FullName (Join-Path $dest 'ffmpeg.exe') -Force
  if ($fp) { Copy-Item $fp.FullName (Join-Path $dest 'ffprobe.exe') -Force }

  Write-Host ''
  Write-Host "Installed into $dest"
  & (Join-Path $dest 'ffmpeg.exe') -hide_banner -version | Select-Object -First 1
  if (-not $fp) { Write-Warning 'ffprobe.exe was not found in this build; frame counting will be less accurate.' }
  Write-Host 'Done. Now run start.cmd'
}
finally {
  Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
  Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
