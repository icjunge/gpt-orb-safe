@echo off
setlocal EnableExtensions DisableDelayedExpansion
if /I "%~1"=="--check" goto check_only
if not "%~1"=="" goto usage

echo GPT Orb - Install required Windows tools
echo Installs missing tools from the official WinGet community source.
echo Windows may ask you to approve each installer through UAC.
echo No GitHub login, signing keys, or repository changes are performed.
echo.

call :check_node
if "%errorlevel%"=="0" goto git_step
call :install OpenJS.NodeJS.LTS wix
if not "%errorlevel%"=="0" goto failed
call :check_node
if not "%errorlevel%"=="0" goto verification_failed

:git_step
call :check_git
if "%errorlevel%"=="0" goto gh_step
call :install Git.Git inno
if not "%errorlevel%"=="0" goto failed
call :check_git
if not "%errorlevel%"=="0" goto verification_failed

:gh_step
call :check_gh
if "%errorlevel%"=="0" goto success
call :install GitHub.cli wix
if not "%errorlevel%"=="0" goto failed
call :check_gh
if not "%errorlevel%"=="0" goto verification_failed

:success
echo.
echo Required tools are installed and their versions were verified.
echo Open a NEW terminal before using Node.js, npm, Git, or GitHub CLI.
echo See RELEASE.md for GitHub sign-in and release signing setup.
echo.
pause
exit /b 0

:install
where.exe winget.exe >nul 2>&1
if not "%errorlevel%"=="0" goto missing_winget
echo.
echo Installing %~1 ...
winget.exe install --id "%~1" --exact --source winget --scope machine --installer-type "%~2" --accept-package-agreements --accept-source-agreements
set "INSTALL_RC=%errorlevel%"
if "%INSTALL_RC%"=="0" exit /b 0
echo.
echo WinGet returned exit code %INSTALL_RC% for %~1.
if "%INSTALL_RC%"=="3010" echo A restart is required. Save your work, restart Windows, and run this file again.
echo The installer output above contains the original result.
echo If it requests a restart, restart Windows yourself and run this file again.
exit /b 1

:missing_winget
echo.
echo WinGet was not found. Install or update Microsoft App Installer first:
echo https://apps.microsoft.com/detail/9NBLGGH4NNS1
echo Then open a new terminal or run this file again.
exit /b 1

:verification_failed
echo.
echo The installer finished, but the required tool could not be verified.
echo Open a new terminal and try again. If Windows requested a restart,
echo save your work and restart Windows before trying again.
goto failed

:failed
echo.
echo Setup did not finish. Already installed tools have been left in place.
echo Keep the output above if you need help diagnosing the problem.
echo.
pause
exit /b 1

:check_only
set "VERIFY_RC=0"
call :check_node
if not "%errorlevel%"=="0" set "VERIFY_RC=1"
call :check_git
if not "%errorlevel%"=="0" set "VERIFY_RC=1"
call :check_gh
if not "%errorlevel%"=="0" set "VERIFY_RC=1"
exit /b %VERIFY_RC%

:check_node
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "$ErrorActionPreference='Stop'; $env:Path=$env:Path+';'+[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User'); try { $v=(& node.exe --version | Out-String).Trim(); if ($LASTEXITCODE -ne 0 -or $v -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Node version check failed.' }; if ([version]$v.Substring(1) -lt [version]'22.12.0') { throw ('Node '+$v+' is older than 22.12.0.') }; $n=(& npm.cmd --version | Out-String).Trim(); if ($LASTEXITCODE -ne 0 -or $n -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw 'npm version check failed.' }; Write-Host ('OK: Node '+$v+' / npm '+$n); exit 0 } catch { Write-Host ('Node.js 22.12+ and npm are not ready: '+$_.Exception.Message); exit 1 }"
exit /b %errorlevel%

:check_git
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "$ErrorActionPreference='Stop'; $env:Path=$env:Path+';'+[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User'); try { $v=(& git.exe --version | Out-String).Trim(); if ($LASTEXITCODE -ne 0 -or $v -notmatch '^git version [0-9]+\.[0-9]+') { throw 'Git version check failed.' }; Write-Host ('OK: '+$v); exit 0 } catch { Write-Host ('Git is not ready: '+$_.Exception.Message); exit 1 }"
exit /b %errorlevel%

:check_gh
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "$ErrorActionPreference='Stop'; $env:Path=$env:Path+';'+[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User'); try { $v=(& gh.exe --version | Out-String).Trim(); if ($LASTEXITCODE -ne 0 -or $v -notmatch '^gh version [0-9]+\.[0-9]+') { throw 'GitHub CLI version check failed.' }; Write-Host ('OK: '+($v -split '[\r\n]+')[0]); exit 0 } catch { Write-Host ('GitHub CLI is not ready: '+$_.Exception.Message); exit 1 }"
exit /b %errorlevel%

:usage
echo Usage: Install-Tools.cmd [--check]
echo --check verifies versions only; it does not install or pause.
exit /b 2
