@echo off
setlocal
rem ============================================================
rem  本地回归测试（无头 Chrome + 仿真学习通页面）
rem  用法：先在另一个窗口执行   node test\server.js
rem        再双击本文件
rem ============================================================
set WS=%~dp0
set WS=%WS:~0,-1%
set CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe
set PROF=%WS%\.profile-%RANDOM%%RANDOM%
if not exist "%PROF%" mkdir "%PROF%"

call :run test/fixture.html      dom-nav.txt
call :run test/fixture-quiz.html dom-quiz.txt
echo ALLDONE
goto :eof

:run
"%CHROME%" --headless=new --no-sandbox --disable-gpu --no-first-run --no-default-browser-check ^
  --disable-extensions --disable-crash-reporter --disable-breakpad --disable-dev-shm-usage ^
  --user-data-dir="%PROF%" --window-size=1200,900 --virtual-time-budget=30000 --dump-dom ^
  "http://127.0.0.1:8731/%1" > "%WS%\%2" 2> "%WS%\%2.err"
echo   %1  EXIT=%ERRORLEVEL%
for %%A in ("%WS%\%2") do echo     DOMBYTES=%%~zA
goto :eof
