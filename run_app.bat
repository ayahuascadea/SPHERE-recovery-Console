@echo off
title Bitcoin Brute Local Node
echo Checking requirements...

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed! Please install it from https://nodejs.org/
    pause
    exit /b
)

if not exist node_modules (
    echo First time setup: Installing dependencies...
    call npm install
)

echo Starting Local Server...
echo Your app will be available at http://localhost:3000
start "" "http://localhost:3000"
npm run dev
pause
