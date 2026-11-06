@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Can cai Node.js ^>= 18: https://nodejs.org & pause & exit /b 1)
where git >nul 2>nul || (echo Can cai Git: https://git-scm.com & pause & exit /b 1)
node src\server.js --background --open
timeout /t 5 >nul
