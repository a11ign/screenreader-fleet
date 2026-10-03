# @a11ign/screenreader-fleet

## 0.1.0

### Minor Changes

- af96c33: **An enrolled worker can be declared out of the capture set, so five cold-profile boxes do not stop the ten (#2660, #2654).** An inventory host that carries `a11y_capture: false` stays in the fleet (`fleet:env --list`, `doctor`, `worker:code`, `fleet:status` and the deploy tooling still name it) and is left out of `A11Y_WORKERS`, so `capture-fleet-guard` no longer refuses every default run the day the fifteen-entry inventory arrives. A host that declares nothing is in, so the ten need no edit. `fleet:env` names each host it leaves out on stderr with its address and the declaration that did it; a value other than `true`/`false`, a declaration on a group, and a capture set with every host excluded are refused rather than read as "in". `workersFromInventory` takes `scope: "fleet" | "capture"` (default `"fleet"`, so no existing reader changes).
- dcf4386: The first published version of `@a11ign/worker-fleet`. Everything below landed before it: the rename first, then oldest first.
  
  - The product is renamed: formerly a11y-witness, now a11ign. The npm scope, the unscoped CLI package, the
    binary names and every cross-package import specifier change with it (issue #66). Nothing had been
    published under the old name, so this is a rename landing in the tree before the transfer to the
    `a11ign` GitHub organisation, not a migration for existing consumers.
  
  - `doctor` (shipped as `a11ign-doctor` in this package's `bin`) now resolves the exact specifier
    `@a11ign/judge/rules` at runtime to report whose `dist` a cross-package import actually comes from,
    and whether that `dist` is stale relative to its own source. Advisory only — it never changes `doctor`'s
    exit code.
  
    This makes `@a11ign/judge` a genuine new runtime dependency of this package, declared in
    `dependencies` and in `tsconfig.json`'s `references` for correct build ordering.
  
  - #168: removed each package's own `"prepare": "tsc --build"`. Nothing a consumer installing the published
    package observes -- `prepare` never ran for a registry install in the first place (only `prepack`, which
    still runs `tsc --build` unchanged, ships the tarball). This only affects `npm ci` inside this monorepo:
    three packages' own `tsconfig.json` reference the same `evidence` project, so npm firing all five
    workspaces' `prepare` scripts concurrently could start several independent `tsc --build` processes writing
    to `packages/evidence/dist/*` at once -- a real file-write race, source of the intermittent `ci/ts`
    failures. The root's own `prepare` now runs `npm run build` once, coordinating the same dependency graph
    through a single `tsc --build` invocation instead.
  
  - #453: `stripComments` (`@a11ign/evidence/source-text`) no longer corrupts a template literal whose
    interpolation contains ANOTHER template literal with an odd total backtick count — a real bug, not a
    hypothetical one: it silently swallowed a whole function body (including a real `refuseUnknownFlags(`
    call) in `scripts/select-changed-tests.mjs`, and a guard reading the stripped output reported an
    already-guarded file as unguarded. `skipInterpolation` now walks a `${...}` interpolation as real code
    (nested strings, templates and comments included) so the true end of the outer literal is always found,
    regardless of what its interpolation contains. The existing, documented limitation — a comment *inside* an
    interpolation is not itself stripped — is unchanged.
  
    `@a11ign/worker-fleet` adds `command-line-census.mjs`: the tree-walk that discovers every argv-reading
    `.mjs` under this repo's known CLI roots, extracted from `cli-flags.test.ts`'s own census so a second
    consumer asking a different question about the same file population (which scripts declare a runnable
    entry-point, say) can reuse the walk without re-deriving it. `cli-flags.test.ts` itself is unchanged in
    behaviour: it now imports the walk instead of defining it locally, and its long-standing hand-typed
    `GUARDED` registry is replaced by deriving "guarded" from each file's own source (does it call
    `refuseUnknownFlags(`) — a new guarded CLI registers itself by calling the guard, with no census file to
    edit. `UNGUARDED` remains the one hand-typed list, for genuine, reasoned exemptions.
  
  - #515: `doctor`'s control-plane-isolation check reads the fleet SSH key back at the filename it had before
    the rename (#66). That rename moved the string in the tree; it did not rename the file on anybody's
    machine, so the check was looking for a path that does not exist and reporting the control plane
    COMPLIANT with the key sitting there under its old name. `A11Y_SSH_KEY` still overrides and is
    unaffected — set it if your key is named something else, which is what that variable has always been for.
  
    The filenames are deliberately not written out here: `tracked-prose-leak-guard.test.ts` refuses a named
    SSH key path in tracked prose, and a changeset is published prose.
  
  - #526: the control plane's checkout directory is named correctly again in the bootstrap systemd unit and
    in `control-plane-isolation`'s reported inventory. The rename (#66) moved the string in the tree; it did
    not move the directory on the machine, so the unit's `ExecStart` pointed at a path that does not exist
    and the isolation report named one nobody could act on.
  
  - The Windows worker's checkout, its shared `ProgramData` directory and Edge's capture profile are named
    again as they are on the machines. The rename (#66) moved the strings in the tree; it did not move the
    directories on the guests, so the worker's profile resolution and every provisioning script pointed at
    paths that do not exist — and a successful deploy would have created a fresh, unwarmed browser profile
    beside the real one. `A11Y_REPO_PATH`, `A11Y_EDGE_PROFILE` and `A11Y_BROWSER_PROFILE` still override and
    are unaffected.
  
  - The browser profile a capture ran against is now part of the capture cache key and a fleet-consistency
    field. A cold profile and a warm one are different evidence — a fresh user-data-dir shows the browser's
    first-run surface, which the screen reader can record as page content, and a learning profile changes
    what form fields announce. Existing profiles are ADOPTED rather than treated as changed, so no cached
    capture is invalidated by this shipping; only a genuinely new or wiped profile moves the key.
  
  - The local-VM scripts (`worker-ctl.sh`, `fetch-windows-iso.sh`, `build-vm.sh`, `clone-worker.sh`,
    `create-utm-vm.sh`) now refuse to run (exit 1) unless `A11Y_LOCAL_VM=1` is set in the environment, instead
    of printing a deprecation warning and continuing. Capture on the bare-metal fleet (`npm run fleet:status`,
    `npm run fleet:deploy`) instead; set `A11Y_LOCAL_VM=1` to keep using a local UTM VM.
  
  - `doctor --json`'s `next_command` is now a runnable command or `null`, never an English sentence — and a
    check that has advice a shell cannot run carries it in a new `note` field instead.
  
    **This can change what your automation reads.** `next_command` was always a string, and could be prose:
    a failing `worker` check on a Mac emitted *"unlock the Mac if it is locked, then re-run …/worker-ctl.sh
    pool"*, which nothing can execute — and, on a machine where the local-VM path is deprecated, running it
    reproduced the refusal it was offered for. **Anything that executed `next_command` looped.** It is `null`
    now when no command can be constructed, so a consumer can tell "there is nothing to run, read the checks"
    from "here is what to run". If you interpolate `next_command` into a shell line, handle `null`.
  
    The remedy for a deprecated local-VM refusal is now `npm run fleet:status` — the command the refusal
    itself names — rather than the script that just refused.
  
  - `doctor`'s `ready` is now computed over the checks a capture run actually needs, rather than over every
    check — so a freshly cloned checkout with a worker configured reads **READY** instead of NOT READY.
  
    **What changes for a consumer.** `doctor --json`'s `ready` was `checks.every(c => c.ok)`. It no longer is:
    a failing `dataset` check (no training corpus generated) reports its FAIL with its fix and does **not**
    make the verdict NOT READY. Every other check still decides, so a failing `worker`, `judge`, `pages`,
    `run`, `contention`, `isolation` or `dist-*` still reads NOT READY. **If you reconstructed `ready`
    yourself from the `checks` array, your copy and `doctor`'s now disagree** — read the `ready` field.
  
    Each check declares whether it gates, and adding one without declaring is refused rather than defaulted.
  
  - **`doctor --json` now emits a JSON document when it CANNOT produce one.**
  
    A check that threw used to exit 1 with **zero bytes on stdout** and the failure on stderr — where a
    `--json` consumer never looks. For a caller, **"could not ask" and "no output" are different facts and
    only the first is actionable**: the second is indistinguishable from a command that was never run.
  
    On a throw, `--json` now writes to stdout and still exits non-zero:
  
    ```json
    { "ready": false, "error": "<the real failure text>", "checks": [] }
    ```
  
    **`error` is present only in this document**, so its presence is the signal that no verdict exists. A
    successful run is byte-for-byte what it was: `ready`, `next_command`, `checks`, no `error` key. **Read
    `error` before `ready`** — a consumer that reads only `ready` sees `false` and cannot tell a
    NOT-READY checkout from a run that died.
  
    **`checks` is present and EMPTY rather than absent or partial.** Absent crashes a consumer reading
    `.checks[]`. Partial would be worse: it reads exactly like a complete verdict, and nothing in it
    distinguishes a check missing because it passed from one missing because the run died under it.
  
    `2>&1` is not a substitute and would be actively harmful here: stdout is a parsed format, so redirecting
    stderr into it produces invalid JSON — worse than nothing, because a consumer that parses gets a syntax
    error instead of a document.
  
    The human (non-`--json`) output is unchanged and keeps the full stack trace.
  
  - The Homepage link on each package's npm page now points at the project's repository rather than at `a11ign.com`, which does not resolve. Clicking it from npm previously went nowhere; it now reaches the source, the README and the issue tracker.
  
  - `npm ci`, `fleet:deploy` and every other place this package resolves npm's own CLI script now also find it through the `npx`/`npm` executable on `PATH`, symlinks resolved. Debian and Ubuntu package npm at `/usr/share/nodejs/npm`, a layout the two fixed candidates (Windows, upstream tarball) never named, so on a machine whose Node came from apt the resolver refused and nothing that spawns npm could run (#1268).
- 7042ef8: **`fleetConsistency` now reports how many guests reported each field, not only whether any did (#2019).**
  `fields.compared`/`fields.unchecked` is a partition on "did anybody report it", so a `MUST_MATCH` field one
  guest of ten reported was indistinguishable from one all ten agreed on — and a consumer reading that
  partition called the fleet interchangeable on the strength of a single reading. The return value gains
  `fields.coverage`: one `{field, reported, asked}` per field any guest was asked about. `asked` counts the
  guests that carried the BLOCK, so a caller that never collects `policy` does not see a permanent gap, and
  `reported` is counted on the guest rather than read off the values map, whose keys collapse when a caller
  omits `worker`. `compared`/`unchecked` are unchanged: a field at 0 sends a reader to the field, a field at
  k sends them to the boxes, and both are still the lists to act on.
- 50d52e7: **A fleet field can now be COMPARED AND REPORTED without gating a capture, and Node is pinned in git (#2063).**
  `fleetConsistency` gains a third channel beside `MUST_MATCH`: `REPORTED_ONLY` fields are compared exactly
  as the gating ones are and named on the verdict with each guest's value, but they enter neither
  `mismatches` nor `fields.coverage` — the only two things `capture-fleet-guard` reads — so a fleet differing
  on one is `consistent: true` and no run is refused. The return value gains `reportedOnly`: one
  `{field, why, values, reported, asked, state}` per field that has something to say, where `drifted` is the
  guests giving more than one value and `unreported` is some or all of them giving none; a field every guest
  agrees on yields nothing. `describeReportedOnly` renders them. `fleet:status`'s headline over such a fleet
  no longer reads `these workers are interchangeable for capture` — that sentence is replaced rather than
  appended to, and the state is untouched, because a drift that cannot refuse a capture through the guard
  must not refuse it through the operator either.
  
  `nodeVersion` and `displayAdapter` are the first two, by `ceo`'s ruling of 2026-09-23: report it, pin
  provisioning so the fleet converges, and only then may it gate. The fleet was measured that morning running
  v24.19.0 on workers 2-6 and v24.20.0 on 7-11 with every other reported field identical, and
  `fleet:status` called it interchangeable. The worker's `/health` now also reports `displayAdapter` — the
  adapter NAME, which is what decides whether a pinned display mode can be held at all, and a different field
  from the driver version #1567 ruled on. It reads `unknown` on every guest until this worker is deployed,
  which is visible in the report and refuses nothing.
- cd13d9b: **`nodeVersion` is a fleet consistency GATE, not just a reported field (#2170).** Step 3 of `ceo`'s ruling
  on #2063 — report it, pin provisioning so the fleet converges, and only then may it join `MUST_MATCH`. It
  moves out of `REPORTED_ONLY` and into `MUST_MATCH`, so a fleet whose guests run different Node builds is
  now `consistent: false` with a located `nodeVersion` mismatch, and `capture-fleet-guard` exits 3 rather
  than writing two runtimes into one corpus. Joining the gating channel also brings #2047's second refusal:
  a guest that stops reporting the field is a coverage gap at ANY count, so 1 of 2 refuses as surely as 0 of
  2.
  
  The field is in exactly one list: the two lists are the gate and the not-gate, and a field in both would
  be refused and exempted at once. `REPORTED_ONLY` keeps `displayAdapter`, which cannot graduate the same
  way — its values differ by HARDWARE (`Intel(R) UHD Graphics 630` on nine guests, `Intel(R) HD Graphics
  630` on the tenth), so no provisioning run converges it and a gate would refuse that guest for ever. Its
  `why` said "no deployed worker reports it yet"; 10 of 10 report it as of 2026-09-23T18:02Z, so that
  sentence is replaced by what is actually true.
  
  The precondition this waited on, posted by `orchestrator` on #2170: all ten guests reporting one
  `nodeVersion` (`v24.20.0`), read off their own `/health` rather than off `provisionRevision`, against the
  5/5 split measured at 06:55Z the same morning. The reading is stricter than "the pin was installed" and
  that is the point — at 17:57Z, after a clean provision, three of five upgraded guests still reported
  `v24.19.0`, because `/health` reports the runtime of the RUNNING worker process and only the deploy's
  restart moved them. The value this field compares is written into every corpus record by that running
  process.
- 2f052b3: **`@a11ign/worker-fleet` is now `@a11ign/screenreader-fleet` (#2887, #69, the split's R2).** ADR 0036 named the new name and it was never carried out on the registry. npm cannot rename a package, so this release publishes the new name as a FIRST publish and the old name is deprecated afterwards with a pointer here (an owner action: the trusted publisher cannot deprecate). Every importer in the workspace (`cli`, `lab`, the root manifest) and every non-document file naming the old package now names the new one; the package's directory is still `packages/worker-fleet/`, which is M2's (#2702). Pinned by `package-rename-worker-fleet.test.ts`.

### Patch Changes

- 5d3ed42: **`witness`, `worker:compare` and `auth:leak-check` say "did not answer within 12 s", never "down" or "unreachable", and wait long enough for the slowest healthy box (#2683).** Each probed `/health` with its own number (5 s, 8 s, 10 s) and reported a timeout in words that called a slow box gone. A new `@a11ign/worker-fleet/probe-outcome` reads a probe as ready, busy, not-ready, refused or no-answer; a refusal and the box's own `ready:false` say the box is up, and silence names `npm run fleet:wake -- <name>`. The shared timeout is 12 s: the loaded ceiling (about 10 s) plus 2 s, against a slowest healthy first-after-idle answer of 3.09 s (`orchestrator`'s readings on #2671, not measured by this change). `worker:compare` also now says why a worker has no vitals instead of leaving the column blank.
- a5a4167: **The shipped bare-metal `autounattend.xml` now stops the worker account's blank password from expiring, and the file is now well-formed XML.**
  
  **Why.** Windows expires every password after 42 days by default, and a blank one is no exception. If the password expires before provisioning sets `PasswordNeverExpires`, auto-logon fails. The box then stops at "Your password has expired", and SSH provisioning never reaches it (#1933). A second problem was in the file itself: a comment contained a bare `--`. XML forbids that, so a strict parser rejected the whole answer file.
  
  **What changes.**
  - The `specialize` pass now runs `net accounts /maxpwage:unlimited`, which sets the policy before the account exists.
  - It also clears the Winlogon `PasswordExpiryWarning` value.
  - The comment's `--` is now an em dash.
  
  **What does not.** The account, its blank password, and the auto-logon and bootstrap steps are all unchanged. The PXE answer file is unchanged too.
- 63704c7: **The capture window is pinned to 1024x768, and the width it was pinned to is part of the capture cache
  key (#1561).** Captures launched the browser with `--start-maximized` and no window size, so the CSS width
  the page under test was read at was a property of whichever box ran the capture. Responsive pages show
  different content either side of a breakpoint: two captures of `caselaw` matched a `<768px` layout and a
  `>=992px` layout and yielded different findings (#1043), and weather.metoffice.gov.uk's CSS hides its `h1`
  below 1280px (#1522). #1513 made the width visible by recording it; this makes it the same on every guest.
  
  **What changes.**
  - Every browser now launches with `--window-size=1024,768` instead of `--start-maximized`. The two are not
    combined: Chromium's resolution of one against the other under `--app` is undocumented and was never
    measured on this fleet, and an unsettled precedence is the variable this removes.
  - `/health`'s `environment` and every `CaptureResult.environment` carry `windowSize`, the size the worker
    asks the browser for, as `"<width>x<height>"`.
  - `environmentKey` hashes `windowSize`, so a pinned capture and a maximized one cannot share a cache entry.
    An absent value reads as `"maximized"`, which is what every capture taken before this is.
  - `fleet-consistency`'s `MUST_MATCH` compares it, so a half-deployed fleet reads INCONSISTENT instead of
    blending two populations. `captureProtocol` cannot do that job here: a guest still on the pre-pin worker
    code reports the same protocol as a pinned one.
  
  **The value is 1024x768 because that is what the fleet's displays hold.** Provisioning sets one display
  mode on all ten guests (#1567) and all ten report `displayMode: 1024x768`. A Windows browser window is
  clamped to the display work area, so asking for more than the desktop holds yields the desktop; a wider pin
  is a fleet change first, not a flag change.
  
  **The cost: every cached capture misses once.** Adding a field to the cache key re-keys the whole corpus,
  and that is the intended effect rather than a side effect — evidence taken at an unpinned width is not
  evidence taken at a pinned one. There is no CDP emulation here: whether
  `Emulation.setDeviceMetricsOverride` changes what UIA or IAccessible2 report has never been measured, and
  NVDA reads the accessibility tree.
  
  **What does not change.** `CAPTURE_PROTOCOL_VERSION` is untouched — the bump that carries this meaning
  change is #1573's 18->19, which names this row. `innerWidth`/`innerHeight`/`devicePixelRatio` (#1513) stay
  recorded and unkeyed: they are what the page was actually read at, which is the outcome of the request
  rather than something a cache lookup can know in advance. `displayMode` (#1953) stays unkeyed too.
- 4db3248: `bootstrap-control-plane.sh` now provisions `gh` (GitHub CLI) on the control role, idempotently,
  following GitHub's own apt repository since Debian ships no `gh` package. `fleet-playbook.mjs`'s
  fleet-hold check (#1839/#1841) needs `gh` on whatever host runs `fleet:deploy`, and the durable
  pipeline-dispatch host had none -- it was ENOENTing instead of naming a real hold or saying "may
  proceed" (#1870).
- d69faba: **The two deploy refusals stop printing a recapture cost that was more than 2x wrong (#2244).** `protocol-guard.mjs` and `deploy-worker.mjs` told an operator deciding whether to spend a full recapture that it was "2,122 captures, about four hours of fleet time"; the corpus is 1,715 cases and 4,500 captures on disk (`orchestrator`, 2026-09-23T14:26Z). Both now print one shared `RECAPTURE_COST`: what a full re-run produces, `manifest.json`'s cases times two captures each (3,430), with the reading's date and no wall-clock, because the fleet's size is not something the guard can read. Eight files join `corpus-size-figures.test.ts`'s guarded list, each with its reason, and a control drives the scan over their real text at `a4eba30ed`. Two quotations of `capture-cache.mjs` that its rewording in #2242 had left in quotation marks now quote what it says.
- 97f964e: **`displayAdapter`'s operator-facing text now says what is true, dates every hardware reading, and is pinned (#2211).** #2246 had already replaced "no deployed worker reports it yet" in `fleet-consistency`'s exemption, but pinned only the field's behaviour and none of its text, so the correction held at one commit with nothing keeping it there. The exemption now dates the 640x480 fallback (2026-09-22, #1955) and the `UHD`/`HD` reading (2026-09-23); the worker's own `displayAdapter` comment no longer says the fleet reads the field as `unknown` "until this code is deployed" (deployed 2026-09-23T18:02Z) and dates its 640x480 clause. Three tests in `fleet-consistency.test.ts` hold this: neither text may claim the field is unreported, the exemption must state that 10 of 10 guests report it, and each hardware reading must sit beside a date. Each carries a positive control that the old sentence is caught. Comment-only in `server.mjs`: no behaviour, `CAPTURE_PROTOCOL_VERSION`, `provisionRevision` or `environmentKey` moved.
- 116bc2b: Fixes provisioning against the real fleet: the display-mode step (`packages/control/ansible/roles/worker/tasks/display.yml`)
  used to call `EnumDisplaySettings`/`ChangeDisplaySettings` directly over the SSH connection Ansible uses,
  which failed on every worker with "EnumDisplaySettings could not read the current display mode" (#1567) --
  an SSH-spawned PowerShell process does not attach to the interactive window station those GDI calls need,
  regardless of which account runs it. The P/Invoke logic now lives in a new shipped script,
  `src/provisioning/set-display-mode.ps1`, invoked through the same interactive-scheduled-task mechanism
  `provision.yml` already uses for `provision-nvda-worker.ps1`. `worker_display_mode` (width/height) is
  unchanged; anyone driving fleet provisioning through this package gets the working display-mode step
  instead of one that fails on first contact with a real worker.
- 11fab84: **The worker reports the screen it captures on, and `MUST_MATCH` compares it (#1953).** `fleet:status`
  printed "fleet CONSISTENT across 10 of 10 -- these workers are interchangeable for capture" at
  2026-09-22T18:21Z over a fleet running 1024x768 on five guests and 640x480 on the other five. That was a
  uniformity claim over a property nothing checked: `MUST_MATCH` had nine fields and none was the display,
  and it could not have had one -- `/health`'s `environment` reported the browser, the screen reader, the
  OS, the architecture, the protocol, the profile, the settings and the provision stamp, and nothing about
  the screen. `provisionRevision` does not cover it: the provisioning script writes that stamp itself, so
  it records which provisioning RAN rather than what it achieved, and a guest whose display-driver install
  failed still gets the new stamp.
  
  `displayMode` is read from the worker's own process (`SystemInformation.PrimaryMonitorSize`, which is
  `GetSystemMetrics(SM_CXSCREEN/SM_CYSCREEN)`), because that is the only place it can be read honestly: a
  display call over the fleet's SSH path lands in session 0, which has no interactive window station and
  answers for no desktop (#1955), while the `a11ysrv` task runs with `logon_type: interactive_token`. It is
  not memoised -- the display changes under a running worker, and noticing that is the point.
  
  **NOT a capture-cache-key input, deliberately.** `environmentKey` is an allowlist and this field is not on
  it, so **no cached capture is invalidated and no recapture is owed**. Whether the display belongs in the
  key is a question this raises and does not answer; #1561 pins the capture WINDOW and carries its own
  protocol bump for that reason.
- 0c4f39b: **`set-display-mode.ps1` now names the display device on every GDI call instead of asking Windows to
  pick the default one, and reports enough on failure to tell three causes apart.**
  
  **Why.** Provisioning failed the display-mode step on 10 of 10 workers (#1955). The call that failed was
  `EnumDisplaySettings($null, ...)` -- and PowerShell binds `$null` to a `string` parameter as
  `[string]::Empty`, so what Windows was actually asked for was a display device NAMED `""`. No machine has
  one. That is the whole of the ten-host failure: a PowerShell binding trap, not a property of these
  workers. The script also wrote one sentence when it failed, so the outcome could not be told apart from
  landing in session 0 or on a non-interactive desktop.
  
  **What changes.**
  - The primary display is resolved through `MonitorFromPoint` + `GetMonitorInfoW`, and that device name
    is passed to `EnumDisplaySettingsW`. Measured on a real worker: the mode then reads.
  - `ChangeDisplaySettings` becomes `ChangeDisplaySettingsEx`, the form that can take a device name.
  - Where the script means a NULL device it now passes `[NullString]::Value`, the only value that reaches
    a `string` parameter as a genuine NULL.
  - On failure the script reports the session id, the window station and desktop names, the
    `EnumDisplayDevices` enumeration and `GetSystemMetrics`. The Win32 error is printed and explicitly
    marked unreliable, because none of these functions is documented to set one.
  - An empty `EnumDisplayDevices` enumeration is reported beside a same-API positive control -- the same
    function asked again with the resolved device name -- so "no display devices" and "this API refuses
    nameless calls here" are distinguishable in the transcript rather than conflated.
  
  **What does not.** `worker_display_mode` (width/height) is unchanged, and so is the interactive
  scheduled-task route #1833 introduced -- this changes which arguments the script passes, not how it runs.
- 7aa52f7: **`doctor`'s fleet line no longer states agreement about a field one guest of three reported (#2034).**
  `fleetAgreementLine` derived its "guests agree on" list from `fields.compared`, which is true-if-anybody,
  so a field at 1 of 3 was NAMED inside the agreement — worse than a count, because the naming is what
  #1997 added to make the sentence actionable, and the reporter count contradicting it was in the same
  return value. The list is now derived from `fields.coverage` (#2019) and holds only the fields every
  compared guest reported; a partly-reported field is reported in its own clause with its `k of N`, never
  silently dropped, since a field missing from the list reads as one that was not compared at all — the
  third fact, which is #1997's clause. `fleet:status` was ruled this way in #2019 and the two commands now
  describe one fleet in the same words. Never a FAIL in either direction: this changes what the line says,
  not whether `doctor` passes.
- e1e44bf: **`fleetConsistency` now says WHICH fields it compared, and a field no guest reports is no longer agreement (#1997).** The returned value carries `fields.compared` and `fields.unchecked`: a `MUST_MATCH` entry that drew a value from nobody used to contribute no values, so there was nothing to disagree about and the fleet read as consistent about it — measured on a ten-guest fleet where `displayMode` was compared on 0 of 10 while the headline said CONSISTENT. `doctor`'s agreement line now derives the field names from `MUST_MATCH` instead of naming four of ten by hand, and names any field nobody reported. The absent-skip rule is unchanged: a guest missing a field others report is still not a mismatch.
- b2c65a8: **`/health` no longer runs `powershell.exe` for `windowsVersion`, `screenReaderVersion` or `browserVersion` either (#2684) -- the #2673 stall again, for the three reads #2678 left.** `runtimeEnvironment`'s 5 s rebuild called `bootConstant`/`fileProductVersion` for these three straight from `/health`'s request path, and neither memoises a failure: a version that had not yet been read, or a binary that had changed on disk, re-ran `powershell.exe` SYNCHRONOUSLY on every rebuild for as long as it could not answer, blocking Node's event loop for the whole call on every route. The three facts are now sampled by a timer (`createVersionSampler`, `file-version.mjs`) with ASYNCHRONOUS PowerShell, so they are still re-read under a running worker and a change stays visible, and a request only reads the last sample. **The sample carries its age:** `environment.versionsSampledMsAgo`, computed at read time. The version-changed warning, the fields' meaning and their `"unknown"` fallback are unchanged; the capture cache key is unchanged. It is worker code, so it reaches the boxes with `fleet:deploy`.
  
  `@a11ign/worker-fleet`'s `fleet-consistency.test.ts` is a no-op for a consumer: its own `workerReportedFieldsSource` helper, which scans `nvda-worker`'s source for the field names `/health` sends, now also reads `file-version.mjs`'s `current()` block, since the three fields above moved out of the block it already read.
- e5140e9: **A freshly provisioned lab or worker installs with pnpm, and `doctor` tells an operator `pnpm run` (#2890, row 3 of 10 of #57).** `bootstrap-control-plane.sh` and `provision-nvda-worker.ps1` ran `npm install`, so a box provisioned after #57 got an npm-shaped `node_modules` and, with `package-lock.json` gone, versions the lockfile never named. Both now run `corepack pnpm install --frozen-lockfile` (the spelling `roles/worker/tasks/nvda.yml` uses), removing an npm-made `node_modules` once first. `A11Y_SKIP_NPM_INSTALL` is now `A11Y_SKIP_INSTALL`. `doctor.mjs` spawns pnpm through `pnpmCliInvocation` (now copied into the package's `npm-cli-executable.mjs`, pinned equal to the root's) and prints `pnpm run ...` remedies; `diagnose-nvda-worker.ps1` names the frozen pnpm install.
- d5cfa6f: Documentation-only: `src/provisioning/README.md` now names which of the four provisioning paths
  (PXE bare-metal, the `scp`+`ssh` script, the self-contained Windows bootstrap script, and the GitHub
  Action) an outside contributor without this project's own infrastructure can actually follow, and
  `src/provisioning/bare-metal/README.md` states plainly that the bare-metal path assumes infrastructure
  (a Proxmox PXE server, the fleet-control container) a stranger does not have (#41).
  
  No code, wire protocol, or capture behaviour changed.
- 556b95f: **`run-job.yml` now says, where it writes the commit stamp, that a released unit reads as a success (#2232).** After "Release the unit", `systemctl show` answers `Result=success`, `ExecMainStatus=0` and `Description=<unit NAME>` for a job that ran and for a name that never existed alike (measured on the lab, 2026-09-23: a `train` that exited 0 after 4m12s against an invented name, byte-identical). The header gains point 4 and the `--description=` site a pointer to it; `lab-job.test.ts` pins the relationship on the parsed playbook, keyed on the release task existing. No behaviour of the launcher changes.
- 3112a28: **`npx a11ign` on a machine with no worker and no UTM VM no longer prints a notice about a UTM VM.** The run printed `DEPRECATED: this run (no worker named, no fleet configured) manages a local UTM worker VM`, and pointed at a `CLAUDE.md` that is not in the install, before it had looked for a VM; nothing was managed, and the run went on to the same "No capture worker answered" refusal. The notice is now printed only when a local VM is found, so a Mac that still has a UTM guest is still told.
- Updated dependencies [e7db7fd]
- Updated dependencies [eaa8ae3]
- Updated dependencies [4dd7dcc]
- Updated dependencies [5c4020b]
- Updated dependencies [84eedd3]
- Updated dependencies [29fb2cf]
- Updated dependencies [7055253]
- Updated dependencies [66a48a3]
- Updated dependencies [8535de1]
- Updated dependencies [63704c7]
- Updated dependencies [2af1cf0]
- Updated dependencies [7463670]
- Updated dependencies [643df20]
- Updated dependencies [97f964e]
- Updated dependencies [11fab84]
- Updated dependencies [dcf4386]
- Updated dependencies [dcf4386]
- Updated dependencies [8545734]
- Updated dependencies [ccc8f9c]
- Updated dependencies [d176f14]
- Updated dependencies [e2eef75]
- Updated dependencies [3480015]
- Updated dependencies [6e9886e]
- Updated dependencies [b2c65a8]
- Updated dependencies [aa8118a]
- Updated dependencies [27d9f66]
- Updated dependencies [51640ea]
- Updated dependencies [51cf542]
- Updated dependencies [50d52e7]
- Updated dependencies [81ca765]
- Updated dependencies [b05d4b3]
- Updated dependencies [035bd3c]
- Updated dependencies [f22ae6e]
- Updated dependencies [b05a296]
- Updated dependencies [56a3b75]
- Updated dependencies [dc52dc0]
- Updated dependencies [3af2fa0]
- Updated dependencies [276ef9b]
- Updated dependencies [a301ca0]
- Updated dependencies [c66ee39]
- Updated dependencies [84c2ea2]
- Updated dependencies [37e540a]
- Updated dependencies [ffb874f]
- Updated dependencies [6345c3f]
- Updated dependencies [b53527b]
- Updated dependencies [a929e85]
- Updated dependencies [af3ca61]
- Updated dependencies [3a8ee20]
- Updated dependencies [c9d0609]
- Updated dependencies [982b71a]
  - @a11ign/judge@0.2.0
  - @a11ign/screenreader-worker@0.1.0
