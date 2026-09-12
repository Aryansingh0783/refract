# Refract 0.5 — Multi Frame Generation on RTX 30 (and 40)

Status: draft, nothing implemented yet.

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

### B. Proxy slots — the one real hazard

A game folder may already hold ReShade's proxy (`dxgi.dll`) and OptiScaler's proxy, both placed by
Refract 0.4.1. `dlssg_for_sm86`'s README is explicit: *"a single proxy entry point … arbitrary
proxy chaining is not implemented"*. A third proxy DLL in the same folder is how these installs
break.

The `dlss-unlocked` layout avoids this: `dlssg_sm86.dll` sits under `OptiScaler/dlssg_sm86/` and is
loaded **by OptiScaler as an FG backend**, not as its own proxy. Refract copies that layout.

→ **B0 is an investigation, not an assumption:** confirm from OptiScaler 0.9.4's behaviour how it
discovers `dlssg_sm86.dll` (search path, or an ini key), and prove it in a real game before any
UI is written. If OptiScaler 0.9.4 turns out not to load it, the fallback is to give dlssg_sm86 a
proxy slot from the same allocator Refract already uses, and to refuse the combination when no
free slot remains — never to silently place a second `dxgi.dll`.

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
- [ ] A1 Pin the `dlss-unlocked` release + zip sha256 in a new `SOURCES.dlssUnlocked`
- [ ] A2 `fetch-payload.js` extracts the six MFG files to `payload/mfg/`, asserting each sha256
- [ ] A3 `src/core/mfgassets.js` with `ensureMfg()` + constants; `dlss5assets.js` untouched
- [ ] A4 Lite build carries all of it (none of these are NVIDIA-unreleased binaries)
- [ ] A5 Licences/THIRD_PARTY_NOTICES copied into the payload and credited in the README

### B. Loading (do first — everything else depends on the answer)
- [ ] B0 **Establish how OptiScaler 0.9.4 discovers `dlssg_sm86.dll`.** Prove it in a real DX12
      game on the 5070 with `Router=SM86`/`SimulateAmpere` forced, reading OptiScaler's log
- [ ] B1 If it does not load: extend the proxy-slot allocator to a third slot, and refuse the
      combination (with a clear reason) when no free slot remains
- [ ] B2 Never write a second file into a slot another tool owns — regression test

### C. Install / restore
- [ ] C1 `install()` takes `mfg`; absent ⇒ byte-identical to 0.4.1 (**assert this in a test**)
- [ ] C2 Manifest v6 records every MFG file; v5 manifests still restore
- [ ] C3 Round-trip test: install with MFG → restore → folder byte-identical to before

### D. Configuration
- [ ] D1 `dlssg_sm86.ini` writer: Router / KernelImage / HardwareBilinear / MaxGeneratedFrames
- [ ] D2 `nvngx.ini` writer: Generator / Reflex / FramerateLimit / FrameGenerationMode
- [ ] D3 Cap calculator from the detected refresh rate and multiplier, unit-tested
- [ ] D4 Writers preserve any keys the user changed by hand (same rule as `feederconfig.js`)

### E. Ghosting
- [ ] E1 Force the native DLSS-G path; FSR3-FG only as an explicit fallback
- [ ] E2 `HardwareBilinear=0`
- [ ] E3 Keep 0.4.1's DLSS SR upgrade to 310.8 on (clean motion vectors)
- [ ] E4 HUDfix guidance surfaced **only** on the FSR3 fallback
- [ ] E5 UI states which of these is active — no claim that ghosting is "removed"

### F. Latency
- [ ] F1 `Reflex=on` default, `boost` behind a "lowest latency" choice
- [ ] F2 Frame cap applied by default, with the arithmetic shown
- [ ] F3 Warn when V-Sync or an external limiter (RTSS) would fight the cap
- [ ] F4 UI states the honest cost: FG adds latency; sm86 has no Reflex Warp

### G. Gating
- [ ] G1 RTX 30/40 + DX12 + 64-bit only; RTX 50 never sees it; RTX 20 experimental behind a switch
- [ ] G2 Refuse with a readable reason on DX11, Vulkan, x86

### H. Verification, tests, ship
- [ ] H1 `verify()` MFG checks (files, hashes, inis, single proxy owner)
- [ ] H2 dlssg_sm86 log parsed into verdicts
- [ ] H3 `errorreport` `mfg-*` codes + next steps
- [ ] H4 Unit tests for every writer, the cap maths, gating, manifest round-trip
- [ ] H5 Self-test check: MFG install into a fixture, verify, restore
- [ ] H6 **Full 0.4.1 regression pass** — 84 unit tests + 23 self-test checks still green
- [ ] H7 Verify on the RTX 5070 that MFG is correctly *absent*
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
