// Minimal D3D11 window used to verify Refract.fx inside a real ReShade runtime.
// Build: C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /out:Harness.exe Harness.cs
// ReShade64.dll is placed next to Harness.exe as d3d11.dll, so the normal proxy load path is exercised.
// Clears every frame to a flat 0.85 grey; Refract's looks change that grey in predictable ways.
using System;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;

static class Harness
{
    [StructLayout(LayoutKind.Sequential)]
    struct DXGI_SWAP_CHAIN_DESC
    {
        public uint Width, Height, RefreshNum, RefreshDen, Format, ScanlineOrdering, Scaling;
        public uint SampleCount, SampleQuality;
        public uint BufferUsage, BufferCount;
        public IntPtr OutputWindow;
        public int Windowed;
        public uint SwapEffect, Flags;
    }

    [DllImport("d3d11.dll")]
    static extern int D3D11CreateDeviceAndSwapChain(IntPtr adapter, int driverType, IntPtr software, uint flags,
        IntPtr featureLevels, uint numFeatureLevels, uint sdkVersion, ref DXGI_SWAP_CHAIN_DESC desc,
        out IntPtr swapChain, out IntPtr device, out int featureLevel, out IntPtr context);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetBufferFn(IntPtr self, uint index, ref Guid riid, out IntPtr surface);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int PresentFn(IntPtr self, uint sync, uint flags);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateRtvFn(IntPtr self, IntPtr resource, IntPtr desc, out IntPtr rtv);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void OMSetRTFn(IntPtr self, uint num, ref IntPtr rtvs, IntPtr dsv);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void ClearRtvFn(IntPtr self, IntPtr rtv, float[] rgba);

    static T Slot<T>(IntPtr com, int index) where T : class
    {
        IntPtr vtbl = Marshal.ReadIntPtr(com);
        IntPtr fn = Marshal.ReadIntPtr(vtbl, index * IntPtr.Size);
        return Marshal.GetDelegateForFunctionPointer(fn, typeof(T)) as T;
    }

    [STAThread]
    static int Main(string[] args)
    {
        float v = args.Length > 0 ? float.Parse(args[0], System.Globalization.CultureInfo.InvariantCulture) : 0.85f;
        var form = new Form();
        form.Text = "Refract ReShade harness";
        form.ClientSize = new Size(960, 540);
        form.StartPosition = FormStartPosition.CenterScreen;
        form.Show();

        var desc = new DXGI_SWAP_CHAIN_DESC();
        desc.Width = 960; desc.Height = 540; desc.RefreshNum = 60; desc.RefreshDen = 1;
        desc.Format = 28;             // DXGI_FORMAT_R8G8B8A8_UNORM
        desc.SampleCount = 1;
        desc.BufferUsage = 0x20;      // DXGI_USAGE_RENDER_TARGET_OUTPUT
        desc.BufferCount = 2;
        desc.OutputWindow = form.Handle;
        desc.Windowed = 1;
        desc.SwapEffect = 4;          // DXGI_SWAP_EFFECT_FLIP_DISCARD

        IntPtr swap, device, context; int fl;
        int hr = D3D11CreateDeviceAndSwapChain(IntPtr.Zero, 1, IntPtr.Zero, 0, IntPtr.Zero, 0, 7, ref desc,
            out swap, out device, out fl, out context);
        if (hr < 0) { Console.Error.WriteLine("create failed 0x" + hr.ToString("X8")); return 2; }

        Guid texGuid = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c"); // ID3D11Texture2D
        IntPtr back;
        Slot<GetBufferFn>(swap, 9)(swap, 0, ref texGuid, out back);
        IntPtr rtv;
        Slot<CreateRtvFn>(device, 9)(device, back, IntPtr.Zero, out rtv);
        Marshal.Release(back);

        var present = Slot<PresentFn>(swap, 8);
        var setRt = Slot<OMSetRTFn>(context, 33);
        var clear = Slot<ClearRtvFn>(context, 50);
        var color = new float[] { v, v, v, 1f };

        var until = DateTime.UtcNow.AddSeconds(args.Length > 1 ? int.Parse(args[1]) : 60);
        while (form.Visible && DateTime.UtcNow < until)
        {
            setRt(context, 1, ref rtv, IntPtr.Zero);
            clear(context, rtv, color);
            present(swap, 1, 0);
            Application.DoEvents();
        }
        return 0;
    }
}
