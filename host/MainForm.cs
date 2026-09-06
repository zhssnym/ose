using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace OsEditor;

/// <summary>
/// Frameless window that is still a real Win32 window: the non-client area is removed in
/// WM_NCCALCSIZE, so Aero snap, the shadow, the minimise animation and the resize borders all
/// keep working. Everything the user sees is drawn by the WebView2 child.
/// </summary>
internal sealed class MainForm : Form, IWindowHost
{
    private static readonly Color LightBg = ColorTranslator.FromHtml("#FAF9F5");
    private static readonly Color LightBorder = ColorTranslator.FromHtml("#DDD9CC");
    private static readonly Color DarkBg = ColorTranslator.FromHtml("#1A1917");
    private static readonly Color DarkBorder = ColorTranslator.FromHtml("#33312C");

    private const int ResizeEdge = 8;

    private readonly Options _opts;
    private readonly Vault _vault;
    private readonly WebView2 _web;
    private readonly System.Windows.Forms.Timer _showTimer;

    private ClaudeManager? _claude;
    private Watcher? _watcher;
    private Bridge? _bridge;

    private string _theme = "light";
    private bool _allowShow;
    private bool _shown;
    private bool _closeRequested;
    private bool _reallyClose;
    private bool _lastMaximized;
    private bool _lastFocused;

    public MainForm(Options opts, Vault vault)
    {
        _opts = opts;
        _vault = vault;

        var state = vault.GetState();
        _theme = (state["theme"]?.GetValue<string>() ?? "light") == "dark" ? "dark" : "light";

        Text = "os";
        FormBorderStyle = FormBorderStyle.Sizable;
        MinimumSize = new Size(720, 480);
        StartPosition = FormStartPosition.Manual;
        DoubleBuffered = true;
        ShowInTaskbar = true;
        BackColor = _theme == "dark" ? DarkBg : LightBg;
        try { Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath ?? Application.ExecutablePath); }
        catch (Exception) { /* keep the WinForms default */ }

        Bounds = RestoreBoundsFrom(state);
        if (state["window"]?["maximized"]?.GetValue<bool>() == true) WindowState = FormWindowState.Maximized;

        _web = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = BackColor,
            AllowExternalDrop = false,
            CreationProperties = new CoreWebView2CreationProperties
            {
                UserDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "os-editor", "webview"),
            },
        };
        Controls.Add(_web);

        _showTimer = new System.Windows.Forms.Timer { Interval = 2000 };
        _showTimer.Tick += (_, _) => RevealWindow();
    }

    // ---- startup -----------------------------------------------------------

    private static Rectangle RestoreBoundsFrom(JsonObject state)
    {
        var def = DefaultBounds();
        if (state["window"] is not JsonObject w) return def;
        try
        {
            var r = new Rectangle(
                w["x"]?.GetValue<int>() ?? def.X,
                w["y"]?.GetValue<int>() ?? def.Y,
                w["w"]?.GetValue<int>() ?? def.Width,
                w["h"]?.GetValue<int>() ?? def.Height);
            if (r.Width < 720 || r.Height < 480) return def;
            foreach (var screen in Screen.AllScreens)
            {
                var i = Rectangle.Intersect(screen.WorkingArea, r);
                if (i.Width >= 120 && i.Height >= 60) return r;
            }
            return def;
        }
        catch (Exception) { return def; }
    }

    private static Rectangle DefaultBounds()
    {
        var wa = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
        var w = Math.Min(1280, wa.Width);
        var h = Math.Min(800, wa.Height);
        return new Rectangle(wa.X + (wa.Width - w) / 2, wa.Y + (wa.Height - h) / 2, w, h);
    }

    protected override void SetVisibleCore(bool value)
    {
        // Stay hidden until the first navigation completes, so there is never a white flash.
        if (!_allowShow)
        {
            if (!IsHandleCreated) CreateHandle();
            value = false;
        }
        base.SetVisibleCore(value);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ApplyFrame();
        _showTimer.Start();
        _ = InitAsync();
    }

    private async Task InitAsync()
    {
        try
        {
            await _web.EnsureCoreWebView2Async();
            var core = _web.CoreWebView2;

            var s = core.Settings;
            s.AreDefaultContextMenusEnabled = false;
            s.AreDevToolsEnabled = true;
            s.IsZoomControlEnabled = false;
            s.IsStatusBarEnabled = false;
            s.AreBrowserAcceleratorKeysEnabled = false; // F12 is re-added below
            s.IsGeneralAutofillEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            s.IsSwipeNavigationEnabled = false;
            s.IsPinchZoomEnabled = false;

            core.SetVirtualHostNameToFolderMapping("vault.os", _vault.Root, CoreWebView2HostResourceAccessKind.Allow);
            core.AddWebResourceRequestedFilter("https://app.os/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += OnWebResourceRequested;
            core.WebMessageReceived += OnWebMessage;
            core.NavigationCompleted += OnNavigationCompleted;
            core.NavigationStarting += OnNavigationStarting;
            core.NewWindowRequested += OnNewWindowRequested;
            core.ProcessFailed += (_, ev) => Program.Log($"webview process failed: {ev.ProcessFailedKind}");
            core.WindowCloseRequested += (_, _) => WinClose();

            // The WinForms control does not surface CoreWebView2Controller.AcceleratorKeyPressed,
            // so with browser accelerators disabled F12 and Ctrl+Shift+I are re-added from the
            // page side over a reserved internal command.
            await core.AddScriptToExecuteOnDocumentCreatedAsync(DevToolsHookScript);

            _claude = new ClaudeManager(_vault, Post, Program.Log);
            _bridge = new Bridge(_vault, _claude, this, Post, Program.Log);
            _watcher = new Watcher(_vault, Post, Program.Log);

            var url = _opts.SelfTest ? "https://app.os/selftest.html"
                    : _opts.DevUrl is { Length: > 0 } dev ? dev
                    : "https://app.os/";
            Program.Log($"navigating to {url} (embedded ui files: {EmbeddedUi.Count})");
            core.Navigate(url);
        }
        catch (Exception ex)
        {
            Program.Log($"webview init failed: {ex}");
            MessageBox.Show($"WebView2 failed to start.\n\n{ex.Message}", "os", MessageBoxButtons.OK, MessageBoxIcon.Error);
            RevealWindow();
        }
    }

    private const string DevToolsHookScript =
        "window.addEventListener('keydown', function (e) {" +
        "  if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i'))) {" +
        "    e.preventDefault();" +
        "    window.chrome.webview.postMessage({ id: 0, cmd: '__devtools', args: [] });" +
        "  }" +
        "}, true);";

    private void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var env = _web.CoreWebView2?.Environment;
        if (env is null) return;
        if (!Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var uri)) return;
        if (!uri.Host.Equals("app.os", StringComparison.OrdinalIgnoreCase)) return;

        var path = Uri.UnescapeDataString(uri.AbsolutePath);
        var bytes = EmbeddedUi.Get(path, out var mime);
        if (bytes is null)
        {
            e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "Content-Type: text/plain; charset=utf-8");
            return;
        }
        e.Response = env.CreateWebResourceResponse(
            new MemoryStream(bytes), 200, "OK",
            $"Content-Type: {mime}\r\nCache-Control: no-cache, no-store, must-revalidate");
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri)) return;
        if (uri.Scheme is "devtools" or "about" or "data" or "blob") return;
        if (uri.Host.Equals("app.os", StringComparison.OrdinalIgnoreCase)) return;
        if (_opts.DevUrl is { Length: > 0 } dev && e.Uri.StartsWith(dev, StringComparison.OrdinalIgnoreCase)) return;
        if (uri.IsLoopback) return;

        e.Cancel = true;
        if (uri.Scheme is "http" or "https" or "mailto")
            try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(e.Uri) { UseShellExecute = true }); }
            catch (Exception ex) { Program.Log($"openExternal failed: {ex.Message}"); }
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
            try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(e.Uri) { UseShellExecute = true }); }
            catch (Exception ex) { Program.Log($"openExternal failed: {ex.Message}"); }
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess) Program.Log($"navigation failed: {e.WebErrorStatus}");
        RevealWindow();
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string json;
        try { json = e.WebMessageAsJson; }
        catch (ArgumentException) { return; }
        if (json.Contains("\"__devtools\"", StringComparison.Ordinal))
        {
            _web.CoreWebView2?.OpenDevToolsWindow();
            return;
        }
        _bridge?.Handle(json);
    }

    private void RevealWindow()
    {
        if (_shown) return;
        _shown = true;
        _showTimer.Stop();
        _allowShow = true;
        Show();
        Activate();
        PostWindowState();
    }

    /// <summary>Posts a host to web message. Safe from any thread.</summary>
    public void Post(string json)
    {
        if (IsDisposed || !IsHandleCreated) return;
        try
        {
            BeginInvoke(() =>
            {
                try { _web.CoreWebView2?.PostWebMessageAsJson(json); }
                catch (ObjectDisposedException) { }
                catch (InvalidOperationException) { }
            });
        }
        catch (ObjectDisposedException) { }
        catch (InvalidOperationException) { }
    }

    // ---- frame -------------------------------------------------------------

    private void ApplyFrame()
    {
        if (!IsHandleCreated) return;
        var dark = _theme == "dark";
        var bg = dark ? DarkBg : LightBg;
        var border = dark ? DarkBorder : LightBorder;

        Native.SetAttr(Handle, Native.DWMWA_USE_IMMERSIVE_DARK_MODE, dark ? 1 : 0);
        Native.SetAttr(Handle, Native.DWMWA_WINDOW_CORNER_PREFERENCE, Native.DWMWCP_DONOTROUND);
        Native.SetAttr(Handle, Native.DWMWA_BORDER_COLOR, Native.ToColorRef(border));
        Native.SetAttr(Handle, Native.DWMWA_CAPTION_COLOR, Native.ToColorRef(bg));

        // A 1px extended frame is what makes DWM keep drawing the drop shadow for a window
        // whose non-client area we removed.
        var margins = new Native.MARGINS { cxLeftWidth = 1, cxRightWidth = 1, cyTopHeight = 1, cyBottomHeight = 1 };
        try { Native.DwmExtendFrameIntoClientArea(Handle, ref margins); } catch (DllNotFoundException) { }
    }

    protected override void WndProc(ref Message m)
    {
        switch (m.Msg)
        {
            // Client area == window rect: no caption, no borders, but the window still has
            // WS_THICKFRAME so snapping, resizing and the shadow behave natively. Maximised is
            // the exception: Windows makes the window rect overhang the work area by the resize
            // frame on every side, so the client rect is inset by exactly that much or the
            // sidebar and the window buttons would be drawn off-screen.
            case Native.WM_NCCALCSIZE when m.WParam != IntPtr.Zero:
            {
                if (WindowState == FormWindowState.Maximized)
                {
                    var p = Marshal.PtrToStructure<Native.NCCALCSIZE_PARAMS>(m.LParam);
                    var (fx, fy) = Native.FrameSize(Handle);
                    p.rgrc0.Left += fx;
                    p.rgrc0.Right -= fx;
                    p.rgrc0.Top += fy;
                    p.rgrc0.Bottom -= fy;
                    Marshal.StructureToPtr(p, m.LParam, false);
                }
                m.Result = IntPtr.Zero;
                return;
            }

            // Without a caption Windows would maximise over the taskbar, so pin the maximised
            // rectangle to the current monitor's work area.
            case Native.WM_GETMINMAXINFO:
            {
                var mmi = Marshal.PtrToStructure<Native.MINMAXINFO>(m.LParam);
                var mon = Native.MonitorFromWindow(Handle, Native.MONITOR_DEFAULTTONEAREST);
                var info = new Native.MONITORINFO { cbSize = Marshal.SizeOf<Native.MONITORINFO>() };
                if (mon != IntPtr.Zero && Native.GetMonitorInfoW(mon, ref info))
                {
                    mmi.ptMaxPosition.X = info.rcWork.Left - info.rcMonitor.Left;
                    mmi.ptMaxPosition.Y = info.rcWork.Top - info.rcMonitor.Top;
                    mmi.ptMaxSize.X = info.rcWork.Right - info.rcWork.Left;
                    mmi.ptMaxSize.Y = info.rcWork.Bottom - info.rcWork.Top;
                    mmi.ptMinTrackSize.X = MinimumSize.Width;
                    mmi.ptMinTrackSize.Y = MinimumSize.Height;
                    Marshal.StructureToPtr(mmi, m.LParam, false);
                    m.Result = IntPtr.Zero;
                    return;
                }
                break;
            }

            case Native.WM_NCHITTEST:
            {
                m.Result = (IntPtr)HitTest(m.LParam);
                return;
            }
        }
        base.WndProc(ref m);
    }

    private int HitTest(IntPtr lParam)
    {
        if (WindowState == FormWindowState.Maximized) return Native.HTCLIENT;
        var x = unchecked((short)(long)lParam);
        var y = unchecked((short)((long)lParam >> 16));
        var b = Bounds;
        var left = x < b.Left + ResizeEdge;
        var right = x >= b.Right - ResizeEdge;
        var top = y < b.Top + ResizeEdge;
        var bottom = y >= b.Bottom - ResizeEdge;
        if (top && left) return Native.HTTOPLEFT;
        if (top && right) return Native.HTTOPRIGHT;
        if (bottom && left) return Native.HTBOTTOMLEFT;
        if (bottom && right) return Native.HTBOTTOMRIGHT;
        if (left) return Native.HTLEFT;
        if (right) return Native.HTRIGHT;
        if (top) return Native.HTTOP;
        if (bottom) return Native.HTBOTTOM;
        return Native.HTCLIENT;
    }

    // ---- IWindowHost -------------------------------------------------------

    public void RunOnUi(Action action)
    {
        if (IsDisposed) { action(); return; }
        if (InvokeRequired) BeginInvoke(action);
        else action();
    }

    public void WinMinimize() => WindowState = FormWindowState.Minimized;

    public void WinToggleMaximize() =>
        WindowState = WindowState == FormWindowState.Maximized
            ? FormWindowState.Normal
            : FormWindowState.Maximized;

    public void WinClose() => Close();

    public bool WinIsMaximized() => WindowState == FormWindowState.Maximized;

    public void WinStartDrag() => BeginNonClientDrag(Native.HTCAPTION);

    public void WinStartResize(string edge) => BeginNonClientDrag(edge?.ToLowerInvariant() switch
    {
        "left" => Native.HTLEFT,
        "right" => Native.HTRIGHT,
        "top" => Native.HTTOP,
        "bottom" => Native.HTBOTTOM,
        "topleft" => Native.HTTOPLEFT,
        "topright" => Native.HTTOPRIGHT,
        "bottomleft" => Native.HTBOTTOMLEFT,
        "bottomright" => Native.HTBOTTOMRIGHT,
        _ => throw new ArgumentException($"unknown resize edge: {edge}"),
    });

    /// <summary>
    /// The WebView child holds the mouse capture, so hand the gesture to the window manager:
    /// release capture on this thread, then let DefWindowProc run its modal move/size loop.
    /// </summary>
    private void BeginNonClientDrag(int hit)
    {
        if (hit == Native.HTCAPTION && WindowState == FormWindowState.Maximized)
        {
            // Native behaviour: dragging a maximised window restores it under the cursor.
            var before = RestoreBounds;
            Native.GetCursorPos(out var cur);
            WindowState = FormWindowState.Normal;
            Location = new Point(cur.X - before.Width / 2, cur.Y - 16);
        }
        Native.ReleaseCapture();
        Native.GetCursorPos(out var p);
        Native.SendMessageW(Handle, Native.WM_NCLBUTTONDOWN, (IntPtr)hit, Native.MakeLParam(p.X, p.Y));
    }

    public void WinSetTheme(string theme)
    {
        _theme = theme == "dark" ? "dark" : "light";
        BackColor = _theme == "dark" ? DarkBg : LightBg;
        try { _web.DefaultBackgroundColor = BackColor; } catch (InvalidOperationException) { }
        ApplyFrame();
        try { _vault.PatchState("theme", JsonValue.Create(_theme)); }
        catch (IOException ex) { Program.Log($"theme persist failed: {ex.Message}"); }
    }

    // ---- window state events ----------------------------------------------

    private void PostWindowState()
    {
        if (!_shown) return;
        var max = WindowState == FormWindowState.Maximized;
        var focused = Form.ActiveForm == this;
        if (max == _lastMaximized && focused == _lastFocused) return;
        _lastMaximized = max;
        _lastFocused = focused;
        Post("{\"event\":\"window\",\"data\":{\"maximized\":" + (max ? "true" : "false") +
             ",\"focused\":" + (focused ? "true" : "false") + "}}");
    }

    protected override void OnResize(EventArgs e) { base.OnResize(e); PostWindowState(); }
    protected override void OnActivated(EventArgs e) { base.OnActivated(e); PostWindowState(); }
    protected override void OnDeactivate(EventArgs e) { base.OnDeactivate(e); PostWindowState(); }

    protected override void OnDpiChanged(DpiChangedEventArgs e) { base.OnDpiChanged(e); ApplyFrame(); }

    // ---- closing -----------------------------------------------------------

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_reallyClose)
        {
            e.Cancel = true;
            if (_closeRequested) return; // already counting down
            _closeRequested = true;
            Post("{\"event\":\"window\",\"data\":{\"closing\":true}}");
            var t = new System.Windows.Forms.Timer { Interval = 400 };
            t.Tick += (_, _) =>
            {
                t.Stop();
                t.Dispose();
                _reallyClose = true;
                Close();
            };
            t.Start();
            return;
        }

        SaveWindowState();
        _watcher?.Dispose();
        _claude?.Dispose();
        base.OnFormClosing(e);
    }

    private void SaveWindowState()
    {
        try
        {
            var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            _vault.PatchState("window", new JsonObject
            {
                ["x"] = b.X, ["y"] = b.Y, ["w"] = b.Width, ["h"] = b.Height,
                ["maximized"] = WindowState == FormWindowState.Maximized,
            });
        }
        catch (Exception ex) { Program.Log($"window state save failed: {ex.Message}"); }
    }
}
