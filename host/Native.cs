using System.Runtime.InteropServices;

namespace OsEditor;

/// <summary>Win32 interop for the frameless-but-native window.</summary>
internal static class Native
{
    public const int WM_NCCALCSIZE = 0x0083;
    public const int WM_NCHITTEST = 0x0084;
    public const int WM_NCLBUTTONDOWN = 0x00A1;
    public const int WM_GETMINMAXINFO = 0x0024;

    public const int HTCLIENT = 1;
    public const int HTCAPTION = 2;
    public const int HTLEFT = 10;
    public const int HTRIGHT = 11;
    public const int HTTOP = 12;
    public const int HTTOPLEFT = 13;
    public const int HTTOPRIGHT = 14;
    public const int HTBOTTOM = 15;
    public const int HTBOTTOMLEFT = 16;
    public const int HTBOTTOMRIGHT = 17;

    public const int MONITOR_DEFAULTTONEAREST = 2;

    public const int SM_CXFRAME = 32;
    public const int SM_CYFRAME = 33;
    public const int SM_CXPADDEDBORDER = 92;

    public const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    public const int DWMWA_BORDER_COLOR = 34;
    public const int DWMWA_CAPTION_COLOR = 35;
    public const int DWMWCP_DONOTROUND = 1;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X, Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct NCCALCSIZE_PARAMS
    {
        public RECT rgrc0, rgrc1, rgrc2;
        public IntPtr lppos;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MINMAXINFO
    {
        public POINT ptReserved, ptMaxSize, ptMaxPosition, ptMinTrackSize, ptMaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public int dwFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MARGINS
    {
        public int cxLeftWidth, cxRightWidth, cyTopHeight, cyBottomHeight;
    }

    [DllImport("user32.dll")]
    public static extern bool ReleaseCapture();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageW(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT p);

    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromWindow(IntPtr hWnd, int flags);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetricsForDpi(int index, uint dpi);

    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool GetMonitorInfoW(IntPtr hMonitor, ref MONITORINFO info);

    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hWnd, int attr, ref int value, int size);

    [DllImport("dwmapi.dll")]
    public static extern int DwmExtendFrameIntoClientArea(IntPtr hWnd, ref MARGINS margins);

    /// <summary>COLORREF is 0x00BBGGRR, the reverse of an HTML hex colour.</summary>
    public static int ToColorRef(System.Drawing.Color c) => c.R | (c.G << 8) | (c.B << 16);

    public static void SetAttr(IntPtr hWnd, int attr, int value)
    {
        if (hWnd == IntPtr.Zero) return;
        try { DwmSetWindowAttribute(hWnd, attr, ref value, sizeof(int)); }
        catch (DllNotFoundException) { /* pre-Vista shell, not a case we support */ }
        catch (EntryPointNotFoundException) { }
    }

    public static IntPtr MakeLParam(int x, int y) => (IntPtr)((y << 16) | (x & 0xFFFF));

    /// <summary>
    /// The width and height of the resize frame Windows adds around a maximised window. A
    /// maximised window rect overhangs the work area by exactly this much on every side, so a
    /// window whose client area is its whole window rect must inset by it or draw off-screen.
    /// </summary>
    public static (int X, int Y) FrameSize(IntPtr hWnd)
    {
        try
        {
            var dpi = hWnd != IntPtr.Zero ? GetDpiForWindow(hWnd) : 0u;
            if (dpi > 0)
            {
                var pad = GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
                return (GetSystemMetricsForDpi(SM_CXFRAME, dpi) + pad,
                        GetSystemMetricsForDpi(SM_CYFRAME, dpi) + pad);
            }
        }
        catch (EntryPointNotFoundException) { /* pre-1607: the system metrics below are already scaled */ }
        catch (DllNotFoundException) { }

        var p = GetSystemMetrics(SM_CXPADDEDBORDER);
        return (GetSystemMetrics(SM_CXFRAME) + p, GetSystemMetrics(SM_CYFRAME) + p);
    }
}
