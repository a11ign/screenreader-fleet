@echo off
rem Runs from the support ISO at first logon (invoked by autounattend.xml).
rem
rem Its only job: get an ELEVATED shell without a UAC prompt, then run the worker
rem bootstrap. A UAC prompt here would be fatal -- it renders on the secure desktop,
rem which no automation can click and NVDA cannot read.
setlocal EnableDelayedExpansion
set "LOG=C:\a11y-first-boot.log"
echo [%DATE% %TIME%] first-boot starting from %~dp0 > "%LOG%"

rem The NetKVM driver was injected during windowsPE so the NIC exists, but DHCP may
rem not have finished by first logon. The bootstrap needs the network for winget.
set NET=0
for /L %%i in (1,1,60) do (
  if !NET!==0 (
    ping -n 1 -w 1000 8.8.8.8 >nul 2>&1 && set NET=1
    if !NET!==0 timeout /t 2 /nobreak >nul
  )
)
if !NET!==1 (echo [%DATE% %TIME%] network up >> "%LOG%") else (echo [%DATE% %TIME%] WARNING: no network after ~120s >> "%LOG%")

rem Copy off the read-only ISO so it survives the ISO being detached after install.
copy /y "%~dp0bootstrap-windows-worker.ps1" C:\bootstrap-windows-worker.ps1 >> "%LOG%" 2>&1

rem FirstLogonCommands usually run elevated, but that is not guaranteed. Try inline
rem first; fall back to a RunLevel Highest scheduled task, which elevates silently.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 "$e=(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator);" ^
 "if ($e) { Write-Output 'already elevated; running inline'; & powershell -NoProfile -ExecutionPolicy Bypass -File C:\bootstrap-windows-worker.ps1 }" ^
 "else { Write-Output 'not elevated; via RunLevel Highest task';" ^
 "  $a=New-ScheduledTaskAction -Execute 'powershell' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\bootstrap-windows-worker.ps1';" ^
 "  $p=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest;" ^
 "  Register-ScheduledTask -TaskName 'a11y-firstboot' -Action $a -Principal $p -Force | Out-Null;" ^
 "  Start-ScheduledTask -TaskName 'a11y-firstboot' }" >> "%LOG%" 2>&1

echo [%DATE% %TIME%] first-boot finished >> "%LOG%"
