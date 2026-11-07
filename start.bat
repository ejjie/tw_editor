@echo off
chcp 65001 >nul
cd /d "%~dp0"
title TW Editor

rem Portable build: Python and all modules are in runtime\ (nothing to install).
rem Development folder (no runtime\): the Python installed on this PC, modules installed once with pip.
if exist "runtime\python.exe" goto portable

set PY=python
where py >nul 2>nul && set PY=py -3
%PY% --version >nul 2>nul || (
  echo Python not found. Install Python 3 from python.org ^(tick "Add python.exe to PATH"^),
  echo or download the portable TW Editor, which has Python inside.
  pause
  exit /b 1
)
%PY% -c "import numpy, PIL, cv2, mapbox_earcut" >nul 2>nul || (
  echo Installing quad-art modules ^(one time only^)...
  %PY% -m pip install -r requirements.txt
)
%PY% editor.py %*
if errorlevel 1 pause
exit /b

:portable
set PY=runtime\python.exe
rem a new runtime left from last time (the window was closed, or another editor window held the old one)
if exist "runtime.new\python.exe" call :swapruntime
if not exist "runtime\python.exe" (
  echo runtime\ is missing. Download the portable TW Editor again.
  pause
  exit /b 1
)
"%PY%" update.py %*
if exist "runtime.new\python.exe" call :swapruntime
rem the update brought a new start.bat: it takes over from here (cmd.exe has this line read already)
if exist "start.bat.new" ( move /y "start.bat.new" "start.bat" >nul & "%~f0" --no-update %* )
"%PY%" editor.py %*
if errorlevel 1 pause
exit /b

:swapruntime
rem Python has exited, so its files can be replaced now
echo Installing the new runtime...
rmdir /s /q "runtime.old" 2>nul
if exist "runtime" move "runtime" "runtime.old" >nul || goto swapfail
move "runtime.new" "runtime" >nul || (move "runtime.old" "runtime" >nul & goto swapfail)
rmdir /s /q "runtime.old" 2>nul
exit /b 0
:swapfail
echo Could not replace runtime\ ^(is another TW Editor window open?^). It is tried again next start.
exit /b 1
