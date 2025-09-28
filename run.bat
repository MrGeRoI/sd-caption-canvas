@echo off
setlocal
set "ROOT=%~dp0"
set "PYTHON=%ROOT%venv\Scripts\python.exe"

if not exist "%PYTHON%" (
    echo Virtual environment not found. Run setup.bat first.
    exit /b 1
)

pushd "%ROOT%"
call "%PYTHON%" app.py
popd
