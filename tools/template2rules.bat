@echo off
rem Drag a designed template .map onto this file. Extra options can follow, e.g. --symmetry
cd /d "%~dp0"
if "%~1"=="" (
  echo Drag your designed template .map onto this file.
  pause
  exit /b
)
python template2rules.py %*
pause
