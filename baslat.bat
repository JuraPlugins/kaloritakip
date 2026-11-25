@echo off
chcp 65001 > nul
title WhatsApp Diyet & Kalori Takip Botu
cd /d "%~dp0"
echo ======================================================
echo    WhatsApp Diyet & Kalori Takip Botu Baslatiliyor
echo ======================================================
echo.
npm start
pause
