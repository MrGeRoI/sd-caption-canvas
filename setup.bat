@echo off
setlocal
set "ROOT=%~dp0"
set "VENV_DIR=%ROOT%venv"
set "VENV_PY=%VENV_DIR%\Scripts\python.exe"

if not exist "%VENV_PY%" (
    echo Creating virtual environment in %VENV_DIR%
    python -m venv "%VENV_DIR%"
)

if not exist "%VENV_PY%" (
    echo Failed to create virtual environment. Ensure Python is installed and accessible.
    exit /b 1
)

echo Upgrading pip
call "%VENV_PY%" -m pip install --upgrade pip

echo Installing dependencies from requirements.txt
call "%VENV_PY%" -m pip install -r "%ROOT%requirements.txt"

echo Done.
