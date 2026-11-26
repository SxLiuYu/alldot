@echo off
rem dot-bridge start script (keeper may launch this via cmd.exe).
rem Args after the script name are passed to index.mjs, e.g.:
rem   start.cmd --port 8799
cd /d "%~dp0"
node index.mjs %*
