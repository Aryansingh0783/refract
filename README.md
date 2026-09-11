# Refract

A DLSS 5 companion for Windows. Refract finds your games across every launcher, works out which DLSS 5 route each one can actually use, installs it without touching the game's own files, and lets you undo all of it in one click. It also governs output resolution to claw back the performance DLSS 5 costs, and adds a glass in-game overlay with three looks: **Default**, **Cinematic** and **Natural Lighting**.

Built and verified on GeForce driver **616.92** with an RTX 5070. DLSS 5 neural rendering was confirmed running live in Cyberpunk 2077 (`DLSS5 Generic: inline feature 18 evaluation succeeded`).

## Install

Download `Refract-Setup-x.y.z.exe` from [Releases](../../releases) and run it. It installs per-user with Start-menu and desktop shortcuts and a normal uninstall entry.

## What it does

**DLSS 5, routed per game.** Refract detects each game's render API and what it already ships, then picks the route that can work:

| Game | Route | What Refract adds |
|---|---|---|
| DirectX 12, ships DLSS | **native** | ReShade add-on build + `renodx-dlss5.addon64` (hooks the game's own NGX calls) |
| DirectX 11, ships DLSS | **native + bridge** | the above + `dlss5-bridge.addon64` (forwards D3D11 DLSS calls to D3D12) |
| DirectX 11/12, no DLSS | **feeder** | `dlss5-feed` add-on + `DLSS5_Feed.fx`, with LumeniteFX generating motion vectors, plus the NGX runtime |
| Vulkan, 32-bit, DX9 and older | not attempted | explained in the app instead of silently doing nothing |

Render-API detection doesn't rely on the import table, because modern games load Direct3D at runtime. It checks imports, then the D3D12 Agility SDK marker, then engine DLLs beside the exe, then a bounded scan of the binary for `d3d12.dll` / `d3d11.dll` / `vulkan-1.dll`.

**RTX 20 / 30 / 40 support.** NVIDIA ships DLSS 5 neural rendering on RTX 50 only. Refract reads your GPU (for example `RTX 3060 → Ampere`) and, on pre-Blackwell cards, offers an **RTX 20/30/40 unlock** toggle. It either fetches the community "Universal RTX 20/30/40/50 DLSS-NR" runtime or uses a patched `nvngx_dlssnr.dll` you supply. Expect a large frame-rate cost compared with RTX 50. See the notice below.

**Installs that don't break games.**
- Never overwrites a game's own Streamline/NGX DLLs. They're a version-matched set, and mixing releases crashes the game before ReShade loads.
- Never removes or replaces an add-on you already have, and never clobbers an existing `ReShade.ini`.
- Detects a *limited* ReShade build, which logs "Searching for add-ons" and then refuses to load any, and upgrades it to the add-on build.
- Flags competing DLSS add-ons in one folder, which unload each other and fight over the same NGX hooks.
- Every added or replaced file is tracked in `refract-feeder.json`, so **Remove** restores the folder exactly.

**Library.** Steam (with Steam's cached key art), Epic, GOG and Ubisoft Connect, plus a scan of well-known game roots on every drive (XboxGames, EA Games, Origin, Battle.net, GOG Games, `Games\`). For each game it shows the real DLSS runtime versions, swaps a DLL you supply (backing up the original once) and restores it.

**Performance.** DLSS 5 cost follows the *output* resolution, and it pins cards at their power limit. Refract shows live board power against your limit (via `nvidia-smi`), flags when you're power-bound, and drops the desktop output resolution (Balanced / Performance) for borderless games, restoring native when the game exits.

**Looks and overlay.** `Refract.fx` is added to the game's ReShade preset with three looks, switched live in game with smooth transitions. Default skips the grade pass, so it costs nothing. A glass HUD over borderless games (Alt+Shift+R) covers look, output tier and GPU power/load/temperature, and never takes focus from the game. The UI is built from the Prism Kit.

## Build from source

```powershell
npm install
npm start          # run the app
npm test           # unit tests
npm run selftest   # end-to-end on this PC; writes screenshots + report.json
npm run dist       # build the NSIS installer into dist\
```

Requirements: Windows 10/11, Node 20+, an NVIDIA driver (it ships `nvidia-smi`).

`selftest` changes nothing permanent. Display modes are validated with `CDS_TEST`, and every install/restore runs on temp copies.

## Third-party components

Refract's repository contains **no** third-party binaries. Components are downloaded on first use, checked against pinned SHA-256 hashes, and cached in `%APPDATA%\Refract`.

| Component | Version | Source |
|---|---|---|
| ReShade (add-on build) | 6.8.0 | [reshade.me](https://reshade.me) |
| RenoDX DLSS 5 add-on | 4.70 | [RankFTW/rhi-repo](https://github.com/RankFTW/rhi-repo) |
| DX11 bridge | 1.4.12 | [NIGos/dlss5-dx11-bridge](https://github.com/NIGos/dlss5-dx11-bridge) |
| DLSS5-Feeder | 0.15.1 | [jlrouzies-fr/DLSS5-Feeder](https://github.com/jlrouzies-fr/DLSS5-Feeder) |
| LumeniteFX | mainline | [umar-afzaal/LumeniteFX](https://github.com/umar-afzaal/LumeniteFX) |
| Streamline / NGX runtime | 2.13 / 310.8 | [yumlevi/renodx-dlss-installer](https://github.com/yumlevi/renodx-dlss-installer) |
| RTX 20/30/40 DLSS-NR runtime (opt-in) | 310.8.0.0, patched | [reiluisii/1-Click-DLSS5](https://github.com/reiluisii/1-Click-DLSS5) |

## Notice

- Refract is not affiliated with or endorsed by NVIDIA. DLSS, GeForce and RTX are NVIDIA trademarks.
- The RTX 20/30/40 unlock uses a **modified NVIDIA binary** from a third-party release. It is off by default, only downloads when you switch it on, and is used at your own risk.
- ReShade and DLL injection can trigger anti-cheat. **Don't use Refract in online or anti-cheat-protected games.**
- The overlay and resolution switching need borderless/windowed mode. Exclusive fullscreen covers any desktop window.
- Set NVIDIA Control Panel "Perform scaling on: GPU" so lower output resolutions fill the panel cleanly.

## Project layout

```
src/main.js              Electron main process + IPC
src/core/feeder.js       DLSS 5 routing, additive install, exact restore
src/core/dlss5assets.js  pinned download catalog (hash-verified, cached)
src/core/peimports.js    PE parsing + deep render-API detection
src/core/nvidia.js       GPU tier detection + nvidia-smi telemetry
src/core/library.js      multi-launcher game discovery
src/core/reshade*.js     ReShade runtime + looks installer
src/renderer/            UI (Prism Kit glass)
shaders/Refract.fx       the three looks
test/                    node --test unit tests
verify/                  live ReShade + display harness sources
```

## License

MIT for Refract's own code. See [LICENSE](LICENSE).
