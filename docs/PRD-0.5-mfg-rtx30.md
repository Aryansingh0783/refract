# Refract 0.5 — Multi Frame Generation on RTX 30 (and 40)

Status: **in progress.** A, B, C1–C2, D, E1–E2/E5, F1–F2/F4, G, H1/H3–H7 done (41 MFG unit
tests, 125 total, 24/24 self-test checks). Remaining: the UI, C3 restore round-trip on a real
folder, E3–E4, F3, H2, H8.

**Baseline: the v0.4.0 release, plus the self-reporting feature from 0.4.1 — and nothing else.**
That is exactly what the tree holds today: `2def46a` (0.4.0) + `126781a` (Desktop error reports on
RTX 30/40). A third commit, `f3a48af`, adds the *optional* lite-build script; it changes nothing
unless `npm run dist:lite` is used, so the default `npm run dist` output is 0.4.0 + self-reporting.

The published **v0.4.0 and v0.4.1 releases are not to be touched**. This work ships as a new
**v0.5.0**, as a full installer with everything bundled.

This is purely additive — with MFG off, every byte Refract writes into a game folder must be
identical to 0.4.0.

---

## 1. What was asked

> Add full support for MFG using OptiScaler built within the tool for use with RTX 30 series GPUs
> so that they can use 2x, 3x, 4x MFG with a ghosting removal fix applied and such that their
> latencies are as low as possible.

## 2. What is actually true (researched 2026-09-12, not assumed)

Three things differ from the request as worded. They change the design, so they are stated first.

**a. OptiScaler alone does not do MFG on Ampere.** OptiScaler is the host framework. The engine
that actually runs NVIDIA's DLSS-G pipeline on Ampere is **`dlssg_for_sm86`** (sdli1995) — a
native reimplementation bundling SM75/SM86 PTX+cubin kernels and NVIDIA's DLSS-G 310.1 model in
one DLL, so it needs no `nvngx_dlssg.dll` from a 40-series driver. The OptiScaler issue asking
for Ampere MFG is still open; a maintainer replied "I will try to port it to OptiScaler, stay
tuned" — so as of today it is not in OptiScaler itself.
→ Refract bundles **OptiScaler (already, 0.9.4) + dlssg_sm86**, which is exactly the pairing the
`dlss-unlocked` distribution ships, with `dlssg_sm86.dll` living *inside* OptiScaler's folder.

**b. There is no "ghosting removal" switch.** Nothing upstream exposes one. What does exist:
running the **native DLSS-G path rather than FSR3-FG** (OptiScaler's own docs say FSR3-FG "always
requires HUDfix", while the NVIDIA path handles UI natively), `HardwareBilinear=0` (exact output
instead of the faster approximate sampling), and a current DLSS SR runtime feeding clean motion
vectors — 310.8, which 0.4.1 already installs. Refract will set all of these and say plainly that
they reduce ghosting rather than remove it.

**c. `dlssg_sm86` has no Reflex Warp and adds no low-latency path of its own.** Frame generation
always adds latency; the levers that exist are the game's own Reflex (`Reflex=on`/`boost`), a
frame cap that keeps the GPU off its ceiling (`FramerateLimit`), and not queueing frames behind
V-Sync. Refract will set those and show the honest expectation, not promise "lowest latency".

### Verified component inventory

Pulled from `dlss-unlocked-standalone-DLSSNR-v0.7.7.zip`
(sha256 `973176777b87e84cf4dfc3106441cf89fe649b7b5d4824d37eb47cf9181a0dcc`, 461,985,518 bytes):

| File | Bytes | sha256 (first 16) | Role |
|---|---:|---|---|
| `OptiScaler/dlssg_sm86/dlssg_sm86.dll` | 15,667,520 | `c844646d835a7b88` | the Ampere/Turing MFG engine |
| `OptiScaler/dlssg_sm86/dlssg_sm86.ini` | ~1 KB | (template) | router + multiplier |
| `OptiScaler/streamline/nvngx_dlssg.dll` | 7,460,976 | `ff6e90eb78b82792` | DLSS-G runtime |
| `OptiScaler/streamline/sl.reflex.dll` | 388,736 | `0ce9725e3e03ea9e` | Reflex — the latency lever |
| `OptiScaler/streamline/sl.pcl.dll` | 360,064 | `f13d51cfa05f4cd5` | Reflex PC latency stats |
| `OptiScaler/dlssg_to_fsr3_amd_is_better.dll` | 3,038,208 | `806020c0444f7841` | FSR3-FG fallback path |

≈26 MB added to the payload. **Not** taken from this zip: its `nvngx_dlssnr.dll` is a *different*
build (`e67dee20…`) from Refract's verified universal one (`dcc0dc24…`) despite the identical
size. Refract keeps its own. OptiScaler stays at the bundled 0.9.4.

`sdli1995/dlssg_for_sm86` publishes **no release assets** (source only), so the pinned, hash-checked
binary comes from the `dlss-unlocked` release above — the same sourcing pattern Refract already
uses for the Streamline runtimes.

### The configuration surface

`dlssg_sm86.ini`:

```ini
[Compatibility]
Router=SM86          ; SM86 = Ampere (RTX 30), SM75 = Turing (RTX 20)
KernelImage=PTX      ; PTX = driver JIT (portable); Cubin = exact GPU match; Auto
HardwareBilinear=0   ; 0 = exact output (default), 1 = approximate + faster
[FrameGeneration]
MaxGeneratedFrames=3 ; 1 = 2X, 2 = 3X, 3 = 4X — the game requests the actual multiplier
```

`nvngx.ini` (DLSS Enabler headless, the FG router):

```ini
[FrameGeneration]
Generator=auto           ; fsr3 | dlssg
Reflex=on                ; on | boost | off
ReflexEmulation=auto
FramerateLimit=off       ; off | vsync | a number, INCLUDING generated frames
FrameGenerationMode=auto ; auto | dynamic
```

Note `MaxGeneratedFrames` is a *capability ceiling*, not a forced multiplier — the game asks for
the multiplier it wants. So "give me 3x" is advertise-3x-and-let-the-game-pick, and the UI must
say that rather than implying a hard setting.

---

## 3. Goals / non-goals

**Goals**

1. RTX 30 (and RTX 40) games can run DLSS Multi Frame Generation at 2X / 3X / 4X from inside
   Refract, with everything bundled and no manual file copying.
2. Ghosting minimised by the levers that genuinely exist, each one named in the UI.
3. Latency minimised by the levers that genuinely exist (Reflex, a computed frame cap), with an
   honest statement of the cost.
4. Fully reversible: the existing manifest restores the folder byte-for-byte.
5. Zero change to RTX 50 behaviour and to every existing 0.4.1 code path when MFG is off.

**Non-goals for 0.5**

- Vulkan (dlssg_sm86 is D3D12-only), DX11 games, 32-bit games.
- Beating NVIDIA's native MFG on quality or latency.
- Claiming RTX 20 support. `Router=SM75` exists and will be wired behind the same switch, but
  upstream calls its cubin path unverified, so it ships as clearly-labelled experimental.

---

## 4. Design

### A. Payload (additive)

- New `SOURCES.dlssUnlocked` entry pinning the release URL + zip sha256.
- `scripts/fetch-payload.js` extracts only the six files above into `payload/mfg/`, asserting each
  file's sha256. Build fails loudly if any hash moves.
- New `src/core/mfgassets.js` mirroring `dlss5assets.js`: `ensureMfg(cacheRoot)`, exported
  constants, `MFG_DLL_REL` etc. **`dlss5assets.js` is not modified.**

### B. Proxy slots — ANSWERED 2026-09-12

The plan assumed OptiScaler would host `dlssg_sm86` as an FG backend. **It cannot.** Measured, not
guessed, by scanning the binaries:

| Binary | `dlssg_sm86` hits | `DLSSGMod` hits |
|---|---:|---:|
| upstream OptiScaler 0.9.4 (what Refract bundles) | **0** | 14 |
| `dlss-enabler-headless.dll` | 0 | 14 |
| dlss-unlocked's own proxy `dxgi.dll` | **8** | 0 |

That last one reports `FileDescription: OptiScaler`, `ProductVersion 0.7.7-final (e237f895)` —
it is a **fork** of OptiScaler carrying dlss-unlocked's own version stamp, not upstream. Upstream
OptiScaler has no knowledge of dlssg_sm86; its DLSSG support is `DLSSGMod`, the Nukem FSR3 path.

So hosting MFG "inside OptiScaler" would mean shipping a *second, older, forked* OptiScaler
alongside the 0.9.4 the DLSS 5 bridge route depends on. That is a bad trade.

**It is not needed.** Reading the PE export table of `dlssg_sm86.dll`:

- internal name **`version.dll`**, exporting the full `GetFileVersionInfoA/W/Ex/Size/ByHandle` set
  — it *is* the standalone proxy build, merely renamed inside dlss-unlocked's tree
- it also exports the NGX provider API (`NVSDK_NGX_D3D12_*`, `NVSDK_NGX_D3D11_*`,
  `NVSDK_NGX_CUDA_*`), which is how it serves DLSS-G to the game

This matches dlssg_for_sm86's own documented use: *"Place `version.dll` and `dlssg_sm86.ini`
beside the game's rendering executable."* No OptiScaler involvement at all.

**Decision.** Refract installs `dlssg_sm86.dll` **as its own proxy DLL**, taking one slot from the
existing allocator, and leaves upstream OptiScaler 0.9.4 exactly as it is. Consequences:

1. The slot allocator must now serve three consumers — ReShade, OptiScaler, dlssg_sm86 — and
   `version.dll` is already in its candidate list, so reservation has to be explicit.
2. MFG works with or without the OptiScaler bridge route; they are independent.
3. If no free slot remains, MFG is refused with a readable reason. Never a second file in a slot
   another tool owns.
4. The user asked for "MFG using OptiScaler". The honest answer is that upstream OptiScaler does
   not do Ampere MFG, and the engine that does needs no host. If the exact dlss-unlocked stack is
   wanted later, bundling their fork stays possible — but not by default.

### C. Install route

MFG is a **modifier on the existing OptiScaler route**, not a new route. `feeder.install()` gains
an `mfg` option; when absent, the 0.4.1 code path runs unchanged. Every added file goes into the
existing `refract-feeder.json` manifest (bump to v6, readable by the v5 restore path).

### D. Settings written

Per game, from one `mfg` object `{ enabled, multiplier, reflex, cap, fallback }`:

- `dlssg_sm86.ini` — `Router` from the detected card (30→SM86, 40→SM86, 20→SM75),
  `KernelImage=PTX` (portable; `Auto` only once cubin is verified on the exact card),
  `HardwareBilinear=0` (ghosting), `MaxGeneratedFrames` from the multiplier.
- `nvngx.ini` — `Generator=dlssg`, `Reflex=on` (`boost` when the user picks lowest-latency),
  `FramerateLimit` = computed cap, `FrameGenerationMode=auto`.
- Cap rule: default to the display's refresh minus a small margin, since the limit counts
  *generated* frames; a 165 Hz panel at 3X wants a cap near 160, giving a real-frame rate near 53.
  Show the arithmetic in the UI so the number is not magic.

### E. UI

- **Cards → RTX 30 / RTX 40 tabs**: an MFG block — off / 2X / 3X / 4X, a Reflex choice, the frame
  cap with its computed default, and one line each on the ghosting and latency trade-off.
- **Game card**: MFG state, and the same control for that game.
- Hidden entirely on RTX 50 (native MFG) and on GTX. Shown disabled with the reason on DX11/Vulkan.

### F. Verification & self-reporting

- `feeder.verify()` gains MFG checks: the DLL is present and hash-correct, both inis carry the
  intended keys, exactly one proxy owns the slot.
- `reshadelog`/log parsing learns dlssg_sm86's own log (`dlssg_sm86\logs`, `Level=1`) so a failed
  MFG run has a verdict.
- `errorreport` gains `mfg-*` codes with next steps, so an RTX 30 machine that cannot run MFG
  writes the Desktop report 0.4.1 already ships.

---

## 5. Checklist

### A. Source and bundle
- [x] A1 Pinned in `src/core/mfgassets.js` (`SOURCE`, sha256 `973176777b87e84c…`)
- [x] A2 `fetch-payload.js` extracts the six files to `payload/mfg/`; **built: 1378 files, 620.6 MB** (was 1372 / 595) and all five DLL hashes matched
- [x] A3 `mfgassets.js` with `ensureMfg()`/`extractFrom()`; `dlss5assets.js` untouched
- [ ] A4 Lite build carries all of it (none of these are NVIDIA-unreleased binaries)
- [ ] A5 Licences/THIRD_PARTY_NOTICES copied into the payload and credited in the README

### B. Loading (do first — everything else depends on the answer)
- [x] B0 **Answered: it does not.** Upstream 0.9.4 has zero `dlssg_sm86` references; the loader
      in dlss-unlocked is a *fork*. `dlssg_sm86.dll` is itself a `version.dll` proxy, so it needs
      no host — see section B
- [x] B1 `mfginstall.slotFor()` + an additive `reserved` argument on `optiProxyFor()`. **The
      engine's export table carries only version.dll's 17 entries — no winmm/dinput8/dxgi — so
      `version.dll` is its one possible name.** OptiScaler steps aside when it is reserved
- [x] B2 A stranger on version.dll is refused and left byte-identical (unit test + self-test)

### C. Install / restore
- [x] C1 `install()` takes `mfg`; `null` on every pre-0.5 call and `reservedFor({})` is `[]`, so
      the allocator picks exactly what it always did (asserted)
- [x] C2 Manifest records `mfg` + `mfgProxy`; every file goes through the existing `track()`
- [ ] C3 Round-trip test: install with MFG → restore → folder byte-identical to before

### D. Configuration
- [x] D1 `mfgconfig.engineIni()`: Router / KernelImage / HardwareBilinear / MaxGeneratedFrames
- [x] D2 `mfgconfig.routerIni()`: Generator / Reflex / FramerateLimit / FrameGenerationMode
- [x] D3 `mfgconfig.frameCap()` + `plan()`, unit-tested (165 Hz @ 3X → 162 cap, ~54 real fps)
- [x] D4 Writers preserve untouched keys, sections and comments; idempotent on a second write

### E. Ghosting
- [x] E1 `Generator=dlssg` by default; FSR3 only when explicitly chosen
- [x] E2 `HardwareBilinear=0` (exact sampling) unless opted out
- [ ] E3 Keep 0.4.1's DLSS SR upgrade to 310.8 on (clean motion vectors)
- [ ] E4 HUDfix guidance surfaced **only** on the FSR3 fallback
- [x] E5 `plan().ghosting` carries the wording; a test asserts it never claims removal

### F. Latency
- [x] F1 `Reflex=on` default, `boost` selectable, `off` called out as worse
- [x] F2 Cap applied by default; `capWhy` shows the arithmetic
- [ ] F3 Warn when V-Sync or an external limiter (RTSS) would fight the cap
- [x] F4 `plan().latency` says it, and a test forbids "zero latency" wording

### G. Gating
- [x] G1 `src/core/mfg.js` `eligible()`: RTX 30/40 + DX12 + x64; RTX 50 refused; RTX 20 behind
      an experimental switch
- [x] G2 Readable refusal reasons for DX11 / Vulkan / x86 / non-Windows

### H. Verification, tests, ship
- [x] H1 `verify()` gains mfg-engine / mfg-runtime / mfg-reflex / mfg-config, **only when the
      manifest says MFG is installed** (asserted: a non-MFG game gains no checks)
- [ ] H2 dlssg_sm86 log parsed into verdicts
- [x] H3 Four `mfg-*` codes with next steps; RTX 50 still never reported
- [x] H4 41 MFG unit tests; 125 in total, all passing
- [x] H5 Self-test check 12/24: payload hashes, gating, slot allocation, stranger refusal
- [x] H6 Regression pass: 125 unit tests, 24/24 self-test checks green
- [x] H7 Verified on the 5070: refused with "This card has NVIDIA's own Multi Frame Generation"
- [ ] H8 Cannot verify on real Ampere here — ship with the Desktop error report as the feedback path

---

## 6. Open questions

1. **B0 is the gate.** If OptiScaler 0.9.4 cannot host `dlssg_sm86`, this becomes a three-proxy
   problem and the design changes. Answer it before writing any UI.
2. Does `Generator=dlssg` in `nvngx.ini` route to dlssg_sm86 on a card whose driver refuses DLSS-G,
   or is a spoof also needed? Read OptiScaler's log on a forced-Ampere run.
3. `KernelImage=PTX` vs `Auto` — JIT costs a first-run compile; cubin needs an exact match. PTX
   until measured on real hardware.
4. Interaction with the DLSS 5 neural-rendering add-on in the *same* folder: both hook NGX.
   Test NR + MFG together before offering the combination.

## 7. Sources

- OptiScaler MFG-on-Ampere request — https://github.com/optiscaler/OptiScaler/discussions/1146
- `dlssg_for_sm86` — https://github.com/sdli1995/dlssg_for_sm86
- `dlss-unlocked` (the pinned distribution) — https://github.com/ShyVortex/dlss-unlocked
- OptiScaler FG options wiki — https://github.com/optiscaler/OptiScaler/wiki/Frame-Generation-Options
