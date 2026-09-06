using System.Text;

namespace OsEditor;

internal sealed class Options
{
    public string? DevUrl;
    public string? Root;
    public string? LogPath;
    public bool SelfTest;

    public static Options Parse(string[] args)
    {
        var o = new Options();
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--dev" when i + 1 < args.Length: o.DevUrl = args[++i]; break;
                case "--root" when i + 1 < args.Length: o.Root = args[++i]; break;
                case "--log" when i + 1 < args.Length: o.LogPath = args[++i]; break;
                case "--selftest": o.SelfTest = true; break;
            }
        }
        return o;
    }
}

internal static class Program
{
    private static readonly object LogGate = new();
    private static string? _logPath;

    [STAThread]
    private static void Main(string[] args)
    {
        var opts = Options.Parse(args);
        _logPath = opts.LogPath;
        Log($"os editor starting: {string.Join(' ', args)}");

        ApplicationConfiguration.Initialize();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => Log($"unhandled ui exception: {e.Exception}");
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log($"unhandled exception: {e.ExceptionObject}");

        var root = ResolveRoot(opts);
        if (root is null) { Log("no vault root chosen; exiting"); return; }
        Log($"vault root: {root}");

        var vault = new Vault(root);
        using var form = new MainForm(opts, vault);
        Application.Run(form);
        Log("os editor exited");
    }

    /// <summary>
    /// --root wins when given. Otherwise: the exe's folder if it looks like the vault,
    /// then each ancestor, then ask.
    /// </summary>
    private static string? ResolveRoot(Options opts)
    {
        if (opts.Root is { Length: > 0 } r)
        {
            var full = Path.GetFullPath(r);
            if (Directory.Exists(full)) return full;
            Log($"--root {full} does not exist; falling back to detection");
        }

        var exeDir = Path.GetDirectoryName(Environment.ProcessPath ?? Application.ExecutablePath);
        var dir = exeDir is null ? null : new DirectoryInfo(exeDir);
        while (dir is not null)
        {
            if (LooksLikeVault(dir.FullName)) return dir.FullName;
            dir = dir.Parent;
        }

        using var dlg = new FolderBrowserDialog
        {
            Description = "Choose the vault folder (it must contain CLAUDE.md and Inbox.md)",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = false,
        };
        return dlg.ShowDialog() == DialogResult.OK ? dlg.SelectedPath : null;
    }

    private static bool LooksLikeVault(string dir) =>
        File.Exists(Path.Combine(dir, "CLAUDE.md")) && File.Exists(Path.Combine(dir, "Inbox.md"));

    public static void Log(string text)
    {
        var path = _logPath;
        if (string.IsNullOrEmpty(path)) return;
        var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}  {text}{Environment.NewLine}";
        try
        {
            lock (LogGate)
            {
                var dir = Path.GetDirectoryName(Path.GetFullPath(path));
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                File.AppendAllText(path, line, new UTF8Encoding(false));
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
