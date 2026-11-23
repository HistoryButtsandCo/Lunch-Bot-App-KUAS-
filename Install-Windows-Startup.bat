@echo off
title Install WhatsApp Lunch Bot to Windows Startup & Desktop
cd /d "%~dp0"

set "TARGET_BAT=%~dp0Start-Lunch-Relay.bat"
set "DESKTOP_LNK=%USERPROFILE%\Desktop\WhatsApp Lunch Relay.lnk"
set "STARTUP_LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\WhatsApp Lunch Relay.lnk"

echo Creating Desktop shortcut...
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%DESKTOP_LNK%'); $s.TargetPath = '%TARGET_BAT%'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = 'shell32.dll,24'; $s.Save()"

echo Creating Windows Startup shortcut (auto-start on boot/login)...
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%STARTUP_LNK%'); $s.TargetPath = '%TARGET_BAT%'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = 'shell32.dll,24'; $s.Save()"

echo.
echo ============================================================
echo Done!
echo 1. A "WhatsApp Lunch Relay" shortcut is now on your Desktop.
echo 2. It has also been added to your Windows Startup programs,
echo    so it will start automatically whenever you turn on your PC!
echo ============================================================
pause
