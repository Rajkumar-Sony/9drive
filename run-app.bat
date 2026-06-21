@echo off
cd /d "E:\AUTO KLIK\oneconnect"
echo Starting oneconnect Gateway...
echo Opening dashboard at http://localhost:5173
start http://localhost:5173
npm run dev
pause
