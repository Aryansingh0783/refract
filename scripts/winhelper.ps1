# Refract Windows helper.
# Long-lived process: reads one JSON request per line on stdin, writes one JSON reply per line.
# Handles the few things Node cannot do without a native module:
#   display modes (EnumDisplaySettings / ChangeDisplaySettingsEx), synthetic key presses,
#   foreground-window process name, process presence.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class RefractNative {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
    public int dmDisplayFlags; public int dmDisplayFrequency;
    public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType;
    public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int ChangeDisplaySettingsEx(string deviceName, ref DEVMODE devMode, IntPtr hwnd, int flags, IntPtr lParam);
  [DllImport("user32.dll")]
  static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")]
  static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

  const int ENUM_CURRENT_SETTINGS = -1;
  const int DM_PELSWIDTH = 0x80000, DM_PELSHEIGHT = 0x100000, DM_DISPLAYFREQUENCY = 0x400000;
  const int CDS_TEST = 0x2;

  static DEVMODE NewMode() { var d = new DEVMODE(); d.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE)); return d; }

  public static int[] Current() {
    var d = NewMode();
    if (!EnumDisplaySettings(null, ENUM_CURRENT_SETTINGS, ref d)) return null;
    return new int[] { d.dmPelsWidth, d.dmPelsHeight, d.dmDisplayFrequency };
  }

  public static List<int[]> Modes() {
    var list = new List<int[]>();
    var seen = new HashSet<string>();
    var d = NewMode();
    for (int i = 0; EnumDisplaySettings(null, i, ref d); i++) {
      if (d.dmBitsPerPel < 24) continue;
      string k = d.dmPelsWidth + "x" + d.dmPelsHeight + "@" + d.dmDisplayFrequency;
      if (seen.Add(k)) list.Add(new int[] { d.dmPelsWidth, d.dmPelsHeight, d.dmDisplayFrequency });
      d = NewMode();
    }
    return list;
  }

  // Dynamic change only (no CDS_UPDATEREGISTRY): Windows reverts on sign-out/reboot if we crash.
  public static int SetMode(int w, int h, int hz, bool testOnly) {
    var d = NewMode();
    EnumDisplaySettings(null, ENUM_CURRENT_SETTINGS, ref d);
    d.dmPelsWidth = w; d.dmPelsHeight = h; d.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
    if (hz > 0) { d.dmDisplayFrequency = hz; d.dmFields |= DM_DISPLAYFREQUENCY; }
    int r = ChangeDisplaySettingsEx(null, ref d, IntPtr.Zero, CDS_TEST, IntPtr.Zero);
    if (r != 0 || testOnly) return r;
    return ChangeDisplaySettingsEx(null, ref d, IntPtr.Zero, 0, IntPtr.Zero);
  }

  public static void Tap(byte vk) {
    keybd_event(vk, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    keybd_event(vk, 0, 2, UIntPtr.Zero);
  }

  [ComImport, Guid("8BA5FB08-5195-40e2-AC58-0D989C3A0102"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface ID3DBlob { [PreserveSig] IntPtr GetBufferPointer(); [PreserveSig] UIntPtr GetBufferSize(); }

  [DllImport("d3dcompiler_47.dll", CharSet = CharSet.Ansi)]
  static extern int D3DCompile([MarshalAs(UnmanagedType.LPStr)] string src, UIntPtr size, string name, IntPtr defines,
    IntPtr include, string entry, string target, uint f1, uint f2, out ID3DBlob code, out ID3DBlob errors);

  // Compiles HLSL with Windows' own compiler. Returns "" on success, else the compiler log.
  public static string CompileHlsl(string src, string entry, string target) {
    ID3DBlob code, err;
    int hr = D3DCompile(src, (UIntPtr)Encoding.ASCII.GetByteCount(src), "Refract.fx", IntPtr.Zero, IntPtr.Zero,
      entry, target, 0x800 /* D3DCOMPILE_ENABLE_STRICTNESS */, 0, out code, out err);
    string log = "";
    if (err != null) log = Marshal.PtrToStringAnsi(err.GetBufferPointer(), (int)err.GetBufferSize());
    if (hr < 0) return "FAILED 0x" + hr.ToString("X8") + " " + log;
    return "";
  }

  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);

  // Posts WM_KEYDOWN/WM_KEYUP straight into a window's queue. ReShade reads keys from the
  // game's message pump, so this reaches it without needing focus and without touching
  // whatever the user is physically holding. Target: the named process's main window,
  // else the foreground window. Returns the process name that received the key.
  public static string PostKey(uint vk, string process) {
    IntPtr h = IntPtr.Zero; string who = "";
    if (!String.IsNullOrEmpty(process)) {
      foreach (var p in Process.GetProcessesByName(process)) { if (p.MainWindowHandle != IntPtr.Zero) { h = p.MainWindowHandle; who = p.ProcessName; break; } }
    }
    if (h == IntPtr.Zero) { h = GetForegroundWindow(); who = ForegroundProcess(); }
    if (h == IntPtr.Zero) return "";
    uint sc = MapVirtualKey(vk, 0);
    PostMessage(h, 0x100, (IntPtr)vk, (IntPtr)(1 | (sc << 16)));
    System.Threading.Thread.Sleep(60);
    PostMessage(h, 0x101, (IntPtr)vk, (IntPtr)unchecked((int)(1 | (sc << 16) | (1u << 30) | (1u << 31))));
    return who;
  }

  public static string ForegroundProcess() {
    uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
  }
}
"@

function Reply($id, $ok, $payload) {
  $o = @{ id = $id; ok = $ok }
  if ($ok) { $o.result = $payload } else { $o.error = "$payload" }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    $a = $req.args
    switch ($req.cmd) {
      'ping'       { Reply $req.id $true 'pong' }
      'current'    { $c = [RefractNative]::Current(); Reply $req.id $true @{ width = $c[0]; height = $c[1]; hz = $c[2] } }
      'modes'      { $m = [RefractNative]::Modes() | ForEach-Object { @{ width = $_[0]; height = $_[1]; hz = $_[2] } }; Reply $req.id $true @($m) }
      'setMode'    { $r = [RefractNative]::SetMode([int]$a.width, [int]$a.height, [int]$a.hz, [bool]$a.test); Reply $req.id ($r -eq 0) $(if ($r -eq 0) { 'ok' } else { "ChangeDisplaySettingsEx returned $r" }) }
      'postKey'    { $w = [RefractNative]::PostKey([uint32]$a.vk, [string]$a.process); Reply $req.id ($w -ne '') $(if ($w -ne '') { $w } else { 'no target window' }) }
      'tap'        { [RefractNative]::Tap([byte]$a.vk); Reply $req.id $true 'ok' }
      'foreground' { Reply $req.id $true ([RefractNative]::ForegroundProcess()) }
      'hlsl'       { $r = [RefractNative]::CompileHlsl([string]$a.src, [string]$a.entry, [string]$a.target); Reply $req.id $true @{ ok = ($r -eq ''); log = $r } }
      'running'    { $n = [IO.Path]::GetFileNameWithoutExtension([string]$a.name); $p = @(Get-Process -Name $n -ErrorAction SilentlyContinue); Reply $req.id $true ($p.Count -gt 0) }
      default      { Reply $req.id $false "unknown command $($req.cmd)" }
    }
  } catch {
    $rid = if ($req) { $req.id } else { $null }
    Reply $rid $false $_.Exception.Message
  }
}
