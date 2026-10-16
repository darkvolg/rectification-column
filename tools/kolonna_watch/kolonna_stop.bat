@echo off
chcp 65001 >nul
rem Остановить невидимую программу уведомлений колонны
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -match 'kolonna_watch.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Уведомления колонны остановлены. Запустить снова: kolonna_watch.bat
timeout /t 4 >nul
