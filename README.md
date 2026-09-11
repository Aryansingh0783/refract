# Refract

A DLSS 5 companion for Windows and GeForce RTX 20/30/40/50 GPUs. It was built and verified on GeForce driver **616.92** (RTX 5070).

Version 0.2 ships everything it needs inside the installer: ReShade (add-on build), RenoDX DLSS 5, the DX11 bridge, the DLSS5 Feeder, the shaders and the neural-rendering runtime. Installing DLSS 5 into a game doesn't download anything, and every change can be undone.

- **DLSS 5.** One click installs DLSS 5 neural rendering into a game. Refract detects the game's render API (DX12, DX11, Vulkan or legacy) and picks a route:
  - **Native:** the game has its own DLSS (DX12). RenoDX runs on top of it.
  - **Native + bridge:** a DX11 game with DLSS.
  - **Feeder:** the game has no DLSS. DLSS5 Feeder and LumeniteFX supply it.
  - **Unsupported:** Vulkan, 32-bit and legacy APIs are reported as unsupported.
- **Every RTX card.** Every card gets the universal `nvngx_dlssnr.dll` runtime (310.8), which is the same file for RTX 20/30/40/50. On RTX 50, a runtime the game already ships is kept. On RTX 20–40, a stock runtime is replaced, and the original is backed up. You can switch this off in Settings or point Refract at your own file.
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

Run `Refract-Setup-0.2.0.exe`. After installing DLSS 5 into a game:

1. In the game, set **Display mode: Borderless** (or windowed).
2. Turn **DLSS Super Resolution or DLAA on**. DLSS 5 runs on top of it and stays idle with FSR/XeSS or DLSS off.
3. Press **Home** for ReShade → **Add-ons** → RenoDX to tune it. **F6** toggles NR and **F5** shows an A/B split.

Neural rendering needs extra VRAM and system memory. If a game crashes with *out of memory*, close browsers and other heavy apps, and lower Path Tracing and Frame Generation first.

## Build

```powershell
npm install
npm run payload   # fetch + hash-verify every bundled component into payload/ (cached)
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
- On RTX 20–40, DLSS 5 depends on community tooling, not an official NVIDIA path. Results vary by game.
- In online games, check the game's anti-cheat policy before using ReShade.
