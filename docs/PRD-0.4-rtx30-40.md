# Refract 0.4 — make DLSS 5 actually run on RTX 30 and 40

Status: draft · Owner: Aryan · Written 2026-09-12 · Target: Refract 0.4.0

## 1. Why this exists

0.3.0 shipped the universal `nvngx_dlssnr.dll` (sm_75/86/89/120, gate open for Ampere/Ada) and
assumed that was the missing piece for RTX 30. Field testing says otherwise:

| Machine | Game | What the log says |
|---|---|---|
| RTX 3060, driver 616.56 | Cyberpunk 2077 | `nvngx_dlssnr.dll was not found in D:\Steam\...\Cyberpunk 2077\bin\x64. Place NVIDIA's signed nvngx_dlssnr.dll in that folder and restart the game; NR stays off until then` — repeated. NR never ran. |
| RTX 4050 (laptop) | Death Stranding DC | Add-on loads, NGX hooks install across 2 module copies, `first NGX evaluate intercepted`, then `real DLSS/DLSSD work left host state incomplete; skipping inline NR`. NR skipped. |
| RTX 5070, driver 616.92 | Cyberpunk 2077 | Works. Heavy artifacting **while the ReShade menu is open**. |

Two different failures, and neither is the one 0.3.0 fixed:

1. **The runtime never reached the game folder on the 3060.** The kernel/gate work was necessary
   but not sufficient — the file wasn't even there. Refract's installer either skipped the step,
   failed silently, or the game had been set up by an older build and the user was never forced
   through **Repair**.
2. **On the 4050 the file placement looks fine but the add-on refuses to run the pass**, because
   the host's DLSS/DLSSD state isn't what it needs. That is a *pipeline* problem — which DLSS SR
   runtime the game ships, whether Streamline's NR plugin is present, whether the game even ran
   Ray Reconstruction, and (laptop) which GPU the game is running on.

Meanwhile `1-Click-DLSS5` v3.0.2 reportedly covers RTX 20–50 with a wider pipeline than ours. Its
engine is on disk and has been read; §4 is a straight port list.

## 2. Goals

- **G1.** A clean install on RTX 30 and RTX 40 ends with neural rendering *evaluating every frame*
  in a supported game, or with Refract saying exactly why it can't — never with a silent no-op.
- **G2.** Refract never claims success it hasn't verified. After the first run of a game it reads
  the game's own `ReShade.log` and reports the real state.
- **G3.** Route parity with 1-Click: native-DLSS games, FSR2/XeSS games (OptiScaler bridge) and
  no-upscaler games all have a path.
- **G4.** The RTX 50 path stays exactly as good as it is today.
- **G5.** No artifacting when the ReShade overlay is open.
- **G6.** Every new file is still tracked in a manifest and removable by **Restore original**.

### Non-goals

- RTX 20. Every runtime build refuses Turing (arch 0x160). It stays reported as unsupported, with
  Neural Screen offered instead.
- Beating anti-cheat. Online games stay out of scope and keep the warning.
- Rewriting NeuralScreen or RenoDX. Refract integrates; it does not fork.

## 3. What we know vs what we are guessing

| # | Claim | Confidence | How it gets settled |
|---|---|---|---|
| H1 | On the 3060, Refract never wrote `nvngx_dlssnr.dll` into `bin\x64` | **Fact** (log) | — |
| H2 | Cause of H1 is an install that predates 0.3 (or a skipped **Repair**), not a bug in `provisionNr` | Likely | Read `refract-feeder.json` on that machine: `version`, `at`, `notes`, and whether a `runtime-nr` entry exists |
| H3 | Cause of H1 is `dlss5Unlock: false` in that machine's settings | Possible | Read `%APPDATA%\Refract\refract-settings.json` |
| H4 | Cause of H1 is a failed bundled-file hash (payload damaged → fallback download failed silently) | Possible | Diagnostics bundle: bundle manifest check + install error log |
| H5 | On the 4050, NR is skipped because the game's own DLSS/Streamline stack is older than what the add-on needs (1-Click upgrades `nvngx_dlss.dll` to 310.8; Refract does not) | Likely | Install with the SR upgrade and re-read the log for `evaluation succeeded` |
| H6 | On the 4050 (hybrid laptop) the game or the NGX pass lands on the iGPU; 1-Click sets `UserGpuPreferences=GpuPreference=2` per exe | Plausible | Check the registry value and the log's adapter line |
| H7 | `EnableHooks=2` (NGX only, Streamline left unpatched) is wrong for Streamline games on 30/40; 1-Click's payload default is `1` | Plausible | A/B the two values on the same game and card |
| H8 | Menu artifacting is the NR pass running over the ImGui overlay (`NRUICorrection`) | Plausible | A/B `NRUICorrection=0/1` and the add-on's own UI-correction control on the 5070 |

Nothing in §4 that depends on H5–H8 ships as a silent default until the A/B is run on real hardware.

## 4. What 1-Click does that Refract doesn't

Read from `core/engine/DLSS5-Pipeline.ps1` and `DLSS5-Detection.ps1` (v3.0.2 payload 2.5.3):

**Route selection** — by *upscaler*, not just by API: `nvngx_dlss*.dll` (ignoring `_dlssnr`),
`sl.interposer.dll` or `_nvngx.dll` → **DIRECT**; any `*fsr2*.dll` → **OPTISCALER**;
`libxess.dll` → **OPTISCALER**; nothing → **FEEDER**; any 32-bit exe → **FEEDER**.

**DIRECT (native DLSS)**
1. Deletes a stale `sl.dlss_nr.dll` from the game folder.
2. Compares the game's `nvngx_dlss.dll` (recursive, depth 4) with the payload's 310.8 build and
   **upgrades it when the payload is newer**; if the game has none, drops one in.
3. Copies `nvngx_dlssnr.dll` **unconditionally**.
4. Copies `renodx-dlss5.addon64`.
5. Installs the ReShade add-on build under the right proxy name (`dxgi.dll`, `d3d9.dll`,
   `opengl32.dll`), keeping an existing add-on-capable ReShade.
6. Wipes `reshade-shaders\` and `ReShadePreset.ini` (clean slate), writes a tuned `ReShade.ini`.
7. Sets the exe to **High performance GPU** in `HKCU\Software\Microsoft\DirectX\UserGpuPreferences`.

**OPTISCALER (FSR2/XeSS games)** — OptiScaler v0.9.4 as `dxgi.dll` (or `winmm.dll` on Vulkan),
`OptiScaler.ini` (`Dx12Upscaler=dlss`, all FSR/XeSS/FFX inputs hooked, `HookSL=true`, its own
menu off so ReShade's overlay owns the UI), `libxess.dll`, plus `nvngx_dlssnr.dll` written twice —
also as `nvngx.dll_dlssnr.dll`.

**FEEDER** — feed add-on + RenoDX + `nvngx_dlssnr.dll` + `nvngx_dlss.dll`, Lumenite shaders and
textures into `reshade-shaders\`, `dlss5-feed.cfg` (`preset=6`, DLAA 1.0x, `mode=2`),
`DLSS5_MV_PROVIDER=3`, proxy per API, **dgVoodoo** for D3D8/D3D9 (translates to D3D11 so ReShade
and compute shaders work), and for 32-bit games a `host64\` IPC bridge running the 64-bit
add-on + runtimes out of process. A Vulkan layer (`VkLayer_feed_vk`) ships for Vulkan titles.

**Config** — payload `ReShade.ini` uses `EnableHooks=1`, `SkipLoadingDisabledEffects=1`,
`AddonPath=.\`, `ForceShortcutModifiers=1`, `[renodx] SettingsMode=0`, and a preset that lists the
Lumenite + Feed techniques explicitly.

Refract today has DIRECT (partial) and FEEDER (partial), no OPTISCALER, no SR upgrade, no GPU
preference, no dgVoodoo/32-bit/Vulkan paths, and `EnableHooks=2`.

## 5. Requirements

### R1 — The runtime is there, or the install fails loudly *(fixes H1)*
- R1.1 After every install/repair, re-read the game folder and assert: proxy DLL present and is
  the add-on build; add-on file present; `nvngx_dlssnr.dll` present **and** hash-equal to the
  universal build (or the user's own file); `ReShade.ini` contains the DLSS 5 section.
- R1.2 If any assertion fails, the install is reported as failed with the specific missing item
  and a **Fix this** button. No "installed" badge without a passing check.
- R1.3 `nrNeeded()` is evaluated on every status read (already true) *and* on app start for every
  installed game; games needing repair are surfaced in the library, not only inside the game card.
- R1.4 The 158 MB copy reports progress and is verified after copying (size + hash), with a clear
  error when the target drive is full or the file is locked.
- R1.5 Installing while the game is running is refused with a plain message (1-Click's
  `Assert-GameClosedSafetyCheck`).

### R2 — Route parity: add the OptiScaler bridge *(new Mode 2)*
- R2.1 Detection: classify each game as `native-dlss`, `fsr2`, `xess`, `none`, `unsupported` using
  1-Click's file signatures plus Refract's existing PE/API detection.
- R2.2 For `fsr2`/`xess` on a 64-bit DX12 game, install OptiScaler as the proxy with the tuned
  `OptiScaler.ini`, `libxess.dll`, and the NR runtime under both names.
- R2.3 The route is shown in the UI with a one-line explanation and is overridable by the user
  (Auto / Direct / Bridge / Feeder), because detection will be wrong sometimes.
- R2.4 Everything OptiScaler writes is manifest-tracked and removed by Restore original.

### R3 — DLSS pipeline hygiene *(tests H5)*
- R3.1 Bundle NVIDIA's `nvngx_dlss.dll` 310.8 and `sl.dlss_nr.dll` from the same source set.
- R3.2 On the DIRECT route, compare versions (`VS_FIXEDFILEINFO`, we already read these) and
  upgrade the game's `nvngx_dlss.dll` only when ours is newer, backing up the original.
- R3.3 Remove a stale `sl.dlss_nr.dll`, or install it, per the rule the A/B in §7 settles.
- R3.4 Leave every other Streamline DLL untouched (the Witcher 3 crash in 0.1 came from
  overwriting version-matched Streamline files — that discipline stays).
- R3.5 A per-game "DLSS runtime" panel shows what's installed vs what Refract can provide.

### R4 — Laptops and hybrid graphics *(tests H6)*
- R4.1 Set `HKCU\Software\Microsoft\DirectX\UserGpuPreferences` → `GpuPreference=2;` for the
  game exe on install (tracked; removed on restore).
- R4.2 Detect hybrid systems (iGPU + dGPU via `nvidia-smi` + WMI) and warn when the game's last
  run reported a non-NVIDIA adapter in `ReShade.log` (`Running on <adapter>` is logged already).
- R4.3 Add mobile GPUs to the tier table explicitly (`RTX 4050 Laptop` parses as series 40 today —
  keep it, but show the mobile name and the lower VRAM budget in the warning copy).

### R5 — Config and the overlay artifacting *(tests H7, H8)*
- R5.1 Make `EnableHooks` a per-game setting (2 = NGX only, 1 = also Streamline), default chosen
  per route after the A/B, with a UI toggle labelled in plain words.
- R5.2 Add the ini keys 1-Click sets and we don't: `AddonPath=.\`,
  `SkipLoadingDisabledEffects=1`, `ForceShortcutModifiers=1`, `[renodx] SettingsMode=0`.
- R5.3 Fix or document the menu artifacting: A/B `NRUICorrection`, the add-on's UI-correction
  control and RenoDX build versions; if a config fixes it, ship it as the default and note it; if
  it's an upstream bug, put a one-line hint in the app ("artifacts while the menu is open are
  cosmetic and disappear when you close it") and file it upstream.
- R5.4 Re-check the newest RenoDX DLSS 5 build (clshortfuse/renodx releases and the RankFTW
  mirror) before shipping; pin whichever build passes §7 on all three cards.

### R6 — Diagnostics: "why is neural rendering off?" *(makes G2 real)*
- R6.1 After a session ends, parse the game's `ReShade.log` and classify: `evaluating`,
  `runtime missing`, `host state incomplete`, `add-on not loaded`, `limited ReShade build`,
  `arch refused`, `no DLSS in game`, `unknown`.
- R6.2 Show the verdict on the game card with the exact log line and a matching action
  (Repair, Upgrade DLSS runtime, Switch route, Turn DLSS on in the game, Use Neural Screen).
- R6.3 **Export diagnostics** button: zips `ReShade.log`, `refract-feeder.json`, the payload
  manifest check, `refract-settings.json` (redacted paths), GPU/driver, Windows build and the
  game's file inventory. This is what a remote 3060/4050 sends back instead of a photo of a screen.
- R6.4 Log every install step to `%APPDATA%\Refract\install.log` with the manifest that resulted.

### R7 — Safety rails that must not regress
- R7.1 Additive installs, manifest-tracked, exact restore (keep; do **not** copy 1-Click's habit of
  wiping `reshade-shaders\` and `ReShadePreset.ini` — offer it as an explicit "clean ReShade
  config" checkbox instead, defaulted off, and back up what it removes).
- R7.2 Never overwrite the game's Streamline set (R3.4).
- R7.3 Everything new in this PRD is covered by unit tests and by the self-test where it can be.
- R7.4 Anti-cheat warning stays on every route; OptiScaler and the feeder get the same warning.

### R8 — Honest support matrix
- R8.1 Per-card status in the UI and README derived from what has actually been verified, with a
  "verified on this machine" marker vs "expected to work".
- R8.2 When a route can't work (Turing, 32-bit with no host bridge, Vulkan without the layer),
  say so and offer Neural Screen, which already works on 30/40/50.

## 6. Success criteria

| Criterion | Measure |
|---|---|
| S1 | On the RTX 3060, one clean install of a native-DLSS game (Cyberpunk 2077) yields `inline feature 18 evaluation succeeded (count>60)` in `ReShade.log`, and a visible difference with F5 A/B |
| S2 | On the RTX 4050, the same, in Death Stranding DC — or a precise verdict naming the blocker |
| S3 | On the RTX 5070, the same games behave no worse than 0.3.0 (same or better FPS, no new errors) |
| S4 | Zero "installed" badges that don't survive R1.1's verification, across a 10-game sweep |
| S5 | Menu-open artifacting is gone, or documented with a reproduction and an upstream issue link |
| S6 | Restore original returns every test folder to a byte-identical state (hash the folder before/after) |
| S7 | A failing machine can produce a diagnostics zip in one click, and that zip alone is enough to classify the failure |

## 7. Test plan

**Hardware:** RTX 5070 (dev), RTX 3060 (remote), RTX 4050 laptop (remote). Driver 616.56 on both
remotes, 616.92 on dev — pin the driver in every report; upgrade the remotes to 616.92 for one run
to rule the driver in or out.

**Per card, per route:**

| Route | Game | Assertions in `ReShade.log` |
|---|---|---|
| Direct | Cyberpunk 2077 | add-on registered · `signed NR runtime … pre-loaded` · `feature 18 created` · `evaluation succeeded (count≥60)` · no `was not found` |
| Direct + SR upgrade | Death Stranding DC | as above, plus the DLSS version line moves to 310.8 |
| Bridge | a FSR2-only title | OptiScaler loads · DLSS path chosen · NR evaluates |
| Feeder | a no-DLSS DX11 title | feed add-on loads · Lumenite compiles · NR evaluates |
| Neural Screen | any | `[arch]` line · `NR ON \| FPS` lines |

**A/B matrix (one game, one card, one change at a time):** `EnableHooks` 1 vs 2 ·
`nvngx_dlss.dll` upgraded vs stock · `sl.dlss_nr.dll` present vs absent · `NRUICorrection` 0 vs 1 ·
GPU preference set vs unset (laptop only). Record FPS and the log verdict for each cell.

**Regression:** the existing 49 unit tests plus new ones (§8), the 21-check self-test, and a
byte-level restore check on every route.

## 8. Milestones

| Milestone | Contents | Exit |
|---|---|---|
| **0.4.0-alpha** | R1 (verification + loud failures), R6 (log verdicts + diagnostics zip), R4.1 | The 3060 either works or produces a zip that names the blocker |
| **0.4.0-beta** | R3 (SR upgrade + Streamline hygiene), R5 (config + hooks toggle + artifacting), route override UI | S1/S2 pass on at least one remote card |
| **0.4.0** | R2 (OptiScaler bridge), R7/R8, README + support matrix update, installer | S1–S7 |
| **0.5 (later)** | 32-bit host bridge, dgVoodoo D3D8/9, Vulkan layer | — |

## 9. Risks

| Risk | Mitigation |
|---|---|
| The 30/40 failure is upstream (RenoDX/runtime), not ours | R6 makes that visible instead of guessing; Neural Screen already covers those cards |
| Bundling more NVIDIA binaries (`nvngx_dlss.dll` 310.8, ~59 MB; `sl.dlss_nr.dll`) | Installer grows ~60 MB; releases stay private; sources pinned and hash-checked |
| OptiScaler as `dxgi.dll` collides with ReShade's proxy | One proxy per folder: the bridge route uses OptiScaler as the proxy and RenoDX loads through it; detection must refuse to install both |
| Upstream churn (RenoDX/OptiScaler/NeuralScreen versions) | Everything pinned by version + SHA-256 in `dlss5assets.js`; upgrades are deliberate |
| Remote testing latency (two machines, not mine) | Diagnostics zip + a scripted "test run" that produces one file per A/B cell |
| Laptop VRAM (4050 has 6 GB) | Warn before install; recommend Neural Screen's reduced-resolution mode |

## 10. Open questions

1. Which Refract version actually installed DLSS 5 on the 3060 — and is there a `refract-feeder.json`
   in that folder? (Settles H2 vs H3/H4.)
2. Does the 4050 log show `nvngx_dlssnr.dll` present (the visible portion doesn't say)?
3. Are both remote machines on 616.56, and does 616.92 change anything?
4. Does the 3060 machine have the game on a drive where the 158 MB copy could have failed
   (space, permissions, Steam verifying files)?

---

# Checklist

Legend: `[ ]` to do · **(V)** needs verification on real hardware · **(T)** needs a test.

## A. Diagnose before building (do first)

- [ ] A1 Collect from the 3060 machine: `refract-feeder.json`, `%APPDATA%\Refract\refract-settings.json`,
      the full `ReShade.log`, and a directory listing of `Cyberpunk 2077\bin\x64` **(V)**
- [ ] A2 Same three files from the 4050 machine + Death Stranding folder listing **(V)**
- [ ] A3 Confirm which Refract version is installed on each (`Refract.exe` file version)
- [ ] A4 From A1–A3, mark H2/H3/H4 true or false and write the answer into this PRD
- [ ] A5 Reproduce the 3060 failure locally by installing 0.3.0 into a *fresh copy* of a game folder
      with an old 0.2-style manifest, confirming whether Repair is required and silent

## B. R1 — install verification and loud failures

- [ ] B1 `verifyInstall(exeDir, {gpu, unlock})` in `src/core/feeder.js`: returns per-item pass/fail
      (proxy is add-on build, add-on present, NR runtime present + hash, ini section present) **(T)**
- [ ] B2 `install()` runs it at the end and throws a structured error naming the first failure **(T)**
- [ ] B3 UI: install result shows the checklist; failure renders **Fix this** wired to repair
- [ ] B4 App start: scan installed games, badge any needing repair in the library shelf **(T)**
- [ ] B5 Copy progress + post-copy hash for the 158 MB runtime; explicit disk-full / file-locked errors **(T)**
- [ ] B6 Refuse to install while the game process is running, with a clear message **(T)**
- [ ] B7 `%APPDATA%\Refract\install.log`: one entry per install with the resulting manifest

## C. R6 — log-based verdicts and diagnostics

- [ ] C1 `src/core/reshadelog.js`: parse a game's `ReShade.log` into
      `{addonLoaded, runtimeLoaded, featureCreated, evaluations, lastError, adapter, driver, verdict}` **(T)**
- [ ] C2 Fixtures from the three real logs (5070 working, 3060 "was not found", 4050 "host state
      incomplete") as test cases **(T)**
- [ ] C3 Game card shows the verdict after a session, with the exact log line
- [ ] C4 Verdict → action mapping (Repair / Upgrade DLSS / Switch route / Turn DLSS on / Neural Screen)
- [ ] C5 **Export diagnostics** → `refract-diagnostics-<game>-<date>.zip` (logs, manifests, payload
      check, GPU/driver, Windows build, folder inventory; user paths redacted) **(T)**
- [ ] C6 Self-test check: the parser classifies all three fixtures correctly

## D. R3 — DLSS runtime pipeline

- [ ] D1 Add `nvngx_dlss.dll` 310.8 and `sl.dlss_nr.dll` to the payload catalog with pinned SHA-256
- [ ] D2 `payload/manifest.json` + bundle wiring + selftest "bundled payload" covers them **(T)**
- [ ] D3 DIRECT route: version-compare and upgrade the game's `nvngx_dlss.dll` (recursive, depth 4),
      backing up the original, manifest-tracked **(T)**
- [ ] D4 Stale `sl.dlss_nr.dll` handling per the A/B result **(V)** **(T)**
- [ ] D5 Never touch other `sl.*.dll` files; regression test that asserts it **(T)**
- [ ] D6 "DLSS runtimes" panel per game: what's there, what Refract can install, one-click upgrade

## E. R4 — laptops and hybrid graphics

- [ ] E1 Set `UserGpuPreferences` for the game exe on install; remove it on restore **(T)**
- [ ] E2 Hybrid detection + warning when the log's adapter isn't the NVIDIA card **(V)**
- [ ] E3 Mobile GPU naming and a VRAM-budget warning under 8 GB

## F. R5 — configuration and the overlay artifacting

- [ ] F1 Per-game `EnableHooks` setting (1 or 2) with plain-language UI; default per route **(V)**
- [ ] F2 Add `AddonPath`, `SkipLoadingDisabledEffects`, `ForceShortcutModifiers`,
      `[renodx] SettingsMode=0` to the written ini **(T)**
- [ ] F3 A/B `NRUICorrection` and the add-on's UI-correction control on the 5070; ship the fix or
      document the bug and file it upstream **(V)**
- [ ] F4 Re-evaluate the RenoDX build (clshortfuse/renodx releases vs the pinned RankFTW 4.70);
      pin whichever passes §7 **(V)**

## G. R2 — OptiScaler bridge (Mode 2)

- [ ] G1 Upscaler classification (`native-dlss` / `fsr2` / `xess` / `none`) with 1-Click's
      signatures, layered on the existing API detection **(T)**
- [ ] G2 Bundle OptiScaler 0.9.4 + `libxess.dll` + the tuned ini, pinned and hash-checked
- [ ] G3 Bridge install: proxy choice (`dxgi.dll`, `winmm.dll` on Vulkan), ini, `libxess.dll`,
      NR runtime under both names; refuse when a ReShade proxy already occupies the slot **(T)**
- [ ] G4 Manifest + exact restore for the bridge route **(T)**
- [ ] G5 Route override in the UI (Auto / Direct / Bridge / Feeder / Neural Screen)
- [ ] G6 Verify on one FSR2-only game per card **(V)**

## H. Ship

- [ ] H1 Update the support matrix in the app and README from verified results only
- [ ] H2 Version 0.4.0, full unit + self-test pass, packaged and installed self-test pass
- [ ] H3 Byte-level restore check on every route before release **(T)**
- [ ] H4 Private draft release with the installer; commit and push the source
- [ ] H5 Write the results of every A/B cell back into this PRD so the next person sees the evidence

## Later (0.5)

- [ ] I1 32-bit games via the `host64` IPC bridge
- [ ] I2 dgVoodoo D3D8/D3D9 translation path
- [ ] I3 Vulkan layer route
- [ ] I4 Per-game profiles shared as presets
