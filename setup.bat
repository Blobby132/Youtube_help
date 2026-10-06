@echo off
rem One-time install. Needs Node.js and Python - see README.md.
cd /d "%~dp0"
call npm run setup
pause
