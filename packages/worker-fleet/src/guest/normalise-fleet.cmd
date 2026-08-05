rem Bring one guest to the fleet baseline. Idempotent; safe to run on any guest, any number of times.
rem Runs elevated (SYSTEM) via scripts/guest-run.mjs, which is the only channel that can do these.

rem --- Edge policy -------------------------------------------------------------
rem Measured drift: StartupBoostEnabled was 1 on two guests and 0 on a third. The VALUE matters less
rem than the CONSISTENCY -- two guests with different browser behaviour feed one corpus, which is the
rem same class of problem as the Edge 150/151 version split. Provisioning sets these; they are re-
rem asserted here because provisioning needs a full run and this does not.
>> %OUT% echo [edge policy]
reg add "HKLM\SOFTWARE\Policies\Microsoft\Edge" /v StartupBoostEnabled /t REG_DWORD /d 0 /f >nul 2>&1
reg add "HKLM\SOFTWARE\Policies\Microsoft\Edge" /v BackgroundModeEnabled /t REG_DWORD /d 0 /f >nul 2>&1
rem Autofill draws a suggestion icon INSIDE recognised inputs (name="visit-date" is enough to trigger
rem it), and NVDA announces that icon as an embedded object -- U+FFFC -- appended to the field:
rem   "Visit date, edit, \ufffc"
rem Whether it appears depends on what the durable Edge profile has learned, so it is nondeterministic
rem and it GROWS over a run: measured at 3%, then 8%, then 31% of affected captures as the profile
rem accumulated. 26 good/bad pairs in the corpus disagree about it, which pollutes the one comparison
rem the whole method rests on. Turning autofill off makes the field announcement deterministic.
reg add "HKLM\SOFTWARE\Policies\Microsoft\Edge" /v AutofillAddressEnabled /t REG_DWORD /d 0 /f >nul 2>&1
reg add "HKLM\SOFTWARE\Policies\Microsoft\Edge" /v AutofillCreditCardEnabled /t REG_DWORD /d 0 /f >nul 2>&1
reg add "HKLM\SOFTWARE\Policies\Microsoft\Edge" /v PasswordManagerEnabled /t REG_DWORD /d 0 /f >nul 2>&1
reg query "HKLM\SOFTWARE\Policies\Microsoft\Edge" /v AutofillAddressEnabled >> %OUT% 2>&1
reg query "HKLM\SOFTWARE\Policies\Microsoft\Edge" /v StartupBoostEnabled >> %OUT% 2>&1
reg query "HKLM\SOFTWARE\Policies\Microsoft\Edge" /v BackgroundModeEnabled >> %OUT% 2>&1

rem --- Windows trim ------------------------------------------------------------
rem Needs elevation, which the worker does not have: it retries at every boot, detects it is
rem unelevated, and records needsElevation. This is where it actually runs.
>> %OUT% echo [windows trim]
"C:\Program Files\nodejs\node.exe" src\capture\nvda\windows-trim.mjs C:\Users\witness\a11y-witness\.windows-trimmed >> %OUT% 2>&1

rem --- verify -------------------------------------------------------------------
>> %OUT% echo [services]
powershell -NoProfile -Command "Get-Service WSearch,wuauserv,UsoSvc,DiagTrack -ErrorAction SilentlyContinue | Select-Object Name,Status,StartType | Format-Table -AutoSize | Out-String" >> %OUT% 2>&1
