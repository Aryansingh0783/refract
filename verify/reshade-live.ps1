# Live ReShade verification for Refract.fx.
#   powershell -ExecutionPolicy Bypass -File verify\reshade-live.ps1
# Downloads the official ReShade build, loads it into a tiny D3D11 window as d3d11.dll,
# installs Refract through Refract's own installer code, then presses the look keys the
# same way the app does (winhelper postKey) and reads back ReShade screenshots to prove each look renders.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path $PSScriptRoot 'reshade-harness'
$run = Join-Path $work 'run'
$version = '6.8.0'
New-Item -ItemType Directory -Force $run | Out-Null
$results = [ordered]@{}

# 1. ReShade runtime (official download, extracted from the setup's embedded archive)
$setup = Join-Path $work "ReShade_Setup_$version.exe"
if (-not (Test-Path $setup)) { Invoke-WebRequest -UseBasicParsing "https://reshade.me/downloads/ReShade_Setup_$version.exe" -OutFile $setup }
Push-Location $work; tar -xf $setup ReShade64.dll; Pop-Location
Copy-Item (Join-Path $work 'ReShade64.dll') (Join-Path $run 'd3d11.dll') -Force

# 2. Harness exe
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /target:winexe /r:System.Windows.Forms.dll /r:System.Drawing.dll "/out:$run\Harness.exe" "$PSScriptRoot\Harness.cs"
if ($LASTEXITCODE -ne 0) { throw 'csc failed' }

# 3. Clean ReShade config, then Refract's installer adds its effect + preset
Remove-Item "$run\shots", "$run\ReShade.log", "$run\ReShadePreset.ini", "$run\ReShade.ini*", "$run\refract-shaders" -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$run\shots" | Out-Null
@"
[GENERAL]
EffectSearchPaths=.\
TextureSearchPaths=.\
PresetPath=.\ReShadePreset.ini
PerformanceMode=0
[INPUT]
KeyScreenshot=127,0,0,0
[OVERLAY]
TutorialProgress=4
[SCREENSHOT]
SavePath=.\shots\
FileFormat=1
"@ | Set-Content -Encoding ASCII "$run\ReShade.ini"
$ini = ("$run\ReShade.ini" -replace '\\', '/')
node -e "require('$($root -replace '\\','/')/src/core/reshade').install('$ini',{startLook:'default',transition:0}).then(s=>console.log(JSON.stringify(s)))"
$results.install = (Get-Content "$run\ReShadePreset.ini" -Raw) -match 'Refract@Refract\.fx'

# 4. Keys go through Refract's own helper (scripts/winhelper.ps1 'postKey'), the exact path the app uses.
Add-Type -AssemblyName System.Drawing
$psi = New-Object Diagnostics.ProcessStartInfo 'powershell.exe', "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$root\scripts\winhelper.ps1`""
$psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
$wh = [Diagnostics.Process]::Start($psi)
$null = $wh.StandardOutput.ReadLine()   # {"ready":true}
$script:seq = 0
function WH($cmd, $a) {
  $script:seq++
  $wh.StandardInput.WriteLine((@{ id = $script:seq; cmd = $cmd; args = $a } | ConvertTo-Json -Compress))
  return ($wh.StandardOutput.ReadLine() | ConvertFrom-Json)
}
function Key($vk) { $r = WH 'postKey' @{ vk = $vk; process = 'Harness' }; if (-not $r.ok) { throw "postKey failed: $($r.error)" } }

$p = Start-Process -FilePath "$run\Harness.exe" -ArgumentList '0.85', '70' -WorkingDirectory $run -PassThru
Start-Sleep -Seconds 10

$log = Get-Content "$run\ReShade.log" -Raw -ErrorAction SilentlyContinue
$results.reshadeLoaded = [bool]$log
$results.compiled = $log -match "Successfully compiled '.*Refract\.fx'" -or $log -match "Refract\.fx.*succeeded" -or ($log -match 'Refract\.fx' -and $log -notmatch 'Refract\.fx.*(error|failed)')
$results.compileErrors = ([regex]::Matches($log, '(?im)^.*Refract\.fx.*(error|warning|failed).*$') | ForEach-Object { $_.Value }) -join "`n"

function Shot($label) {
  $before = @(Get-ChildItem "$run\shots" -Filter *.png -ErrorAction SilentlyContinue).Count
  Key 0x7F   # F16 = ReShade screenshot key set above
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 200; if (@(Get-ChildItem "$run\shots" -Filter *.png -ErrorAction SilentlyContinue).Count -gt $before) { break } }
  Start-Sleep -Milliseconds 400
  $f = Get-ChildItem "$run\shots" -Filter *.png | Sort-Object LastWriteTime | Select-Object -Last 1
  if (-not $f -or @(Get-ChildItem "$run\shots" -Filter *.png).Count -le $before) { return $null }
  $dst = Join-Path $run "look-$label.png"; Copy-Item $f.FullName $dst -Force
  $bmp = [Drawing.Bitmap]::FromFile($dst)
  $c = $bmp.GetPixel([int]($bmp.Width / 2), [int]($bmp.Height / 2)); $k = $bmp.GetPixel(4, 4)
  $o = [ordered]@{ center = @($c.R, $c.G, $c.B); corner = @($k.R, $k.G, $k.B); size = "$($bmp.Width)x$($bmp.Height)" }
  $bmp.Dispose(); return $o
}
function Look($vk, $label) { Key $vk; Start-Sleep -Milliseconds 700; return Shot $label }

$results.default0  = Shot 'default-start'
$results.cinematic = Look 0x7D 'cinematic'   # F14
$results.natural   = Look 0x7E 'natural'     # F15
$results.default1  = Look 0x7C 'default'     # F13
if (-not $p.HasExited) { $p.Kill() }
$wh.StandardInput.Close(); if (-not $wh.WaitForExit(3000)) { $wh.Kill() }

# 5. Expectations on a flat 0.85 grey (217): Default leaves it alone; Cinematic lifts the
#    centre (S-curve) and darkens corners (vignette); Natural pulls the centre down (rolloff).
$d0 = $results.default0; $ci = $results.cinematic; $na = $results.natural; $d1 = $results.default1
$checks = [ordered]@{
  'ReShade loaded'                 = $results.reshadeLoaded
  'Refract installed into preset'  = $results.install
  'Refract.fx compiled'            = [bool]$results.compiled -and -not $results.compileErrors
  'Default is pass-through'        = $d0 -and [Math]::Abs($d0.center[0] - 217) -le 2 -and [Math]::Abs($d0.corner[0] - 217) -le 2
  'Cinematic: centre lifted'       = $ci -and $ci.center[1] -ge $d0.center[1] + 2
  'Cinematic: vignette on corners' = $ci -and $ci.corner[1] -le $d0.corner[1] - 25
  'Natural: highlights rolled off' = $na -and $na.center[1] -le $d0.center[1] - 3 -and [Math]::Abs($na.corner[1] - $na.center[1]) -le 3
  'F13 returns to Default'         = $d1 -and [Math]::Abs($d1.center[0] - $d0.center[0]) -le 1 -and [Math]::Abs($d1.corner[0] - $d0.corner[0]) -le 1
}
$report = [ordered]@{ reshade = $version; samples = $results; checks = $checks; pass = -not ($checks.Values -contains $false) }
$report | ConvertTo-Json -Depth 6 | Set-Content "$work\report.json"
$checks.GetEnumerator() | ForEach-Object { '{0}  {1}' -f ($(if ($_.Value) { 'PASS' } else { 'FAIL' })), $_.Key }
if ($report.pass) { 'ALL RESHADE CHECKS PASSED' } else { 'SOME RESHADE CHECKS FAILED'; exit 1 }
