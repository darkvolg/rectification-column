@echo off
rem Ручной запуск (обычно не нужен: программа стартует сама из автозагрузки)
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kolonna_watch.ps1"
