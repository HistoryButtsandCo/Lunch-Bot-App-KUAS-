@echo off
title WhatsApp Lunch Bot Relay
cd /d "%~dp0"
echo ============================================================
echo Starting WhatsApp Gateway + Discord Relay...
echo (Keep this window open or minimized while the bot is running)
echo ============================================================
call npm run start:all
pause
