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

rem The operator's PUBLIC SSH key, if one was staged beside this file. This is what turns
rem "one console visit per box" into "none": bootstrap installs it into
rem administrators_authorized_keys with the ACL sshd insists on, and the machine is then
rem reachable by Ansible from the moment it finishes.
rem
rem Staged at ISO-build time rather than committed. A public key is not a secret, but it IS
rem specific to whoever runs this fleet, and a checked-in one would silently grant access to
rem whoever happened to be in the repo -- which is a worse default than asking.
rem
rem Copied to a FILE rather than exported as an environment variable. The fallback path below runs
rem the bootstrap through a scheduled task, which starts a fresh session and inherits nothing from
rem here -- so an exported variable would work on the elevated path and silently vanish on the other,
rem which is the kind of "works when I tested it" difference this project keeps paying for.
if exist "%~dp0operator-key.pub" (
  if not exist "C:\ProgramData\a11y-witness" mkdir "C:\ProgramData\a11y-witness" >> "%LOG%" 2>&1
  copy /y "%~dp0operator-key.pub" "C:\ProgramData\a11y-witness\operator-key.pub" >> "%LOG%" 2>&1
  echo [%DATE% %TIME%] operator key staged from the install media >> "%LOG%"
) else (
  echo [%DATE% %TIME%] no operator-key.pub beside this script; this box will need one console >> "%LOG%"
  echo [%DATE% %TIME%]   visit, or "ansible-playbook ssh-key.yml" once it is reachable >> "%LOG%"
)

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
