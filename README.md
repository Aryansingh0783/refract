# Refract

A DLSS 5 companion for Windows and GeForce RTX 30/40/50 GPUs. It was built and verified on GeForce driver **616.92** (RTX 5070).

Everything ships inside the installer: ReShade (add-on build), RenoDX DLSS 5, the DX11 bridge, the DLSS5 Feeder, the shaders, the neural-rendering runtime and the NeuralScreen engine. Installing DLSS 5 into a game doesn't download anything, and every change can be undone.

**Two engines.** *In-game* puts DLSS 5 into the game through ReShade and RenoDX. *Neural Screen* (the bundled [NeuralScreen](https://github.com/perseval-BLR/DLSS5-NeuralScreen) 1.6.0, MIT) runs the same neural renderer on what is on screen, outside the game. It covers the games the in-game route can't take (Vulkan, 32-bit, no DLSS) and changes nothing in the game folder.

- **DLSS 5.** One click installs DLSS 5 neural rendering into a game. Refract detects the game's render API (DX12, DX11, Vulkan or legacy) and picks a route:
  - **Native:** the game has its own DLSS (DX12). RenoDX runs on top of it.
  - **Native + bridge:** a DX11 game with DLSS.
  - **Feeder:** the game has no DLSS. DLSS5 Feeder and LumeniteFX supply it.
  - **Unsupported:** Vulkan, 32-bit and legacy APIs are reported as unsupported.
- **RTX 30, 40 and 50.** The in-game route installs the universal `nvngx_dlssnr.dll` 310.8 runtime (from NeuralScreen). It carries sm_86/sm_89/sm_120 kernels, and its architecture gate accepts Ampere, Ada and Blackwell. On RTX 50, a runtime the game already ships is kept. On RTX 30/40, a stock runtime is replaced, and the original is backed up. This includes the Ada-only build Refract 0.2 shipped, which refuses Ampere; those games show **Repair**. You can switch this off or point Refract at your own file.
- **RTX 20 isn't supported.** Every available runtime refuses the Turing architecture (0x160), so Refract says so instead of installing something that stays off.
- **Neural Screen.** Start it from a game's Setup tab, or tick "Start it automatically" so it starts when the game window appears and stops when you quit. Choose the strength (Faithful, Natural, Strong, Extreme) and a faster reduced-resolution mode. In game, with Num Lock on: `Num2` opens the menu, `Num1` toggles NR, `Num5` processes only the window under the cursor, and `Ctrl+Alt+Q` quits. Refract runs a working copy in `%APPDATA%\Refract\neuralscreen`; its config, log and recordings live there. It needs borderless or windowed mode and an SDR display, and adds about 40–60 ms of latency.
- **Undo.** Each install is recorded in a manifest (`refract-feeder.json`, `refract-reshade.json`) with backups. There are three ways to undo:
  - **Restore original** on a game removes exactly what Refract added and puts back what it replaced.
  - **Settings → Restore all** does the same for every game.
  - The uninstaller offers to do the same before it removes the app.
- **Library.** A shelf built from your Steam, Epic, GOG, Ubisoft, EA, Xbox and Battle.net installs. For each game it shows the real DLSS runtime versions. It can swap and restore DLLs, and it launches the game.
- **Sessions.** Refract tracks the game's process and its visible window. "Running" clears when you quit, even if the game lingers in the background. You can also clear it by hand.
- **Performance.** DLSS 5 cost follows the *output* resolution. Refract shows live board power against your limit and can drop the desktop output resolution (Balanced / Performance) for borderless games, then restore native resolution when the game exits.
- **Looks.** `Refract.fx` has three looks, Default, Cinematic and Natural Lighting, switched live in game.
- **Overlay.** Press **Ctrl+Alt+R** in a borderless game to open a glass panel. It covers looks, output tier and GPU rings. Press **Esc** or the hotkey again to close it and hand focus back to the game. **Pin as HUD** keeps it on screen and lets clicks pass through. Alt+Shift combinations are avoided because Windows uses them to switch keyboard layouts. If the hotkey is taken, Refract falls back to another one and shows which.
- **First-run guide.** A short walkthrough opens on first launch. The **?** button reopens it.

## Install

Run `Refract-Setup-0.3.0.exe`. After installing DLSS 5 into a game:

1. In the game, set **Display mode: Borderless** (or windowed).
2. Turn **DLSS Super Resolution or DLAA on**. DLSS 5 runs on top of it and stays idle with FSR/XeSS or DLSS off.
3. Press **Home** for ReShade → **Add-ons** → RenoDX to tune it. **F6** toggles NR and **F5** shows an A/B split.

Neural rendering needs extra VRAM and system memory. If a game crashes with *out of memory*, close browsers and other heavy apps, and lower Path Tracing and Frame Generation first.

## Build

```powershell
npm install
npm run payload   # fetch + hash-verify every bundled component into payload/ (cached; NeuralScreen is 224 MB)
npm run dist      # payload + NSIS installer in dist/
```

The payload is not committed (`payload/` is ignored). `scripts/fetch-payload.js` downloads pinned, SHA-256-checked releases and writes `payload/manifest.json`. At runtime `src/core/bundle.js` only uses a bundled file whose hash matches that manifest.

## Verify

```powershell
npm test          # unit tests: routes, installs/restores, RTX 30/50 runtime rules, repair, sessions, helper
npm run selftest  # end-to-end on this PC (temp copies only), writes screenshots + report.json
```

## Limits

- The overlay and resolution switching need **borderless / windowed** mode.
- The installer contains third-party and NVIDIA-derived binaries, including a modified `nvngx_dlssnr.dll`. Keep builds private and don't redistribute them.
- On RTX 30/40, DLSS 5 depends on community tooling, not an official NVIDIA path. Results vary by game, and the frame-rate cost is higher than on RTX 50.
- Neural Screen (a screen overlay plus an `nvngx.dll` worker process) must not be used in online games with anti-cheat.
- In online games, check the game's anti-cheat policy before using ReShade.
