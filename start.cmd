@echo off
rem Windows wrapper (docs/architecture.md Phase 7). It exists only to check for Node: every real step
rem is in scripts\start.mjs, so the three OSes behave identically. Run it from cmd or PowerShell.
where node >nul 2>nul
if errorlevel 1 (
	echo flypi: Node 22.19+ is required and was not found on PATH - get it from https://nodejs.org 1>&2
	exit /b 1
)
node "%~dp0scripts\start.mjs" %*
