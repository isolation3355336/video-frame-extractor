@echo off
rem Video Frame Extractor - launcher
rem Keep this file ASCII-only: .cmd files are read with the system code page.
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Node.js was not found on PATH.
  echo     Install Node.js 18 or newer from https://nodejs.org/ and run this file again.
  echo     If Node is installed but not on PATH, run manually:
  echo         "C:\Program Files\nodejs\node.exe" server.mjs
  pause
  exit /b 1
)

node server.mjs %*
if errorlevel 1 (
  echo.
  echo [!] Server stopped with an error. Read the message above.
  pause
)
