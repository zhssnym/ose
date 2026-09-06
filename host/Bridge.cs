using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OsEditor;

/// <summary>What the bridge needs from the window. Implemented by MainForm, always on the UI thread.</summary>
internal interface IWindowHost
{
    void WinMinimize();
    void WinToggleMaximize();
    void WinClose();
    bool WinIsMaximized();
    void WinStartDrag();
    void WinStartResize(string edge);
    void WinSetTheme(string theme);
    void RunOnUi(Action action);
}

/// <summary>
/// The RPC surface. Web sends {id, cmd, args}; the host answers {id, ok, result|error}
/// and pushes {event, data} messages of its own.
/// </summary>
internal sealed class Bridge
{
    private readonly Vault _vault;
    private readonly ClaudeManager _claude;
    private readonly IWindowHost _window;
    private readonly Action<string> _post;
    private readonly Action<string> _log;

    public Bridge(Vault vault, ClaudeManager claude, IWindowHost window, Action<string> post, Action<string> log)
    {
        _vault = vault;
        _claude = claude;
        _window = window;
        _post = post;
        _log = log;
    }

    public void Handle(string messageJson)
    {
        string idRaw = "null";
        string cmd = "";
        JsonElement[] args = [];

        try
        {
            using var doc = JsonDocument.Parse(messageJson);
            var root = doc.RootElement;
            if (root.TryGetProperty("id", out var idEl)) idRaw = idEl.GetRawText();
            cmd = root.TryGetProperty("cmd", out var c) ? c.GetString() ?? "" : "";
            if (root.TryGetProperty("args", out var a) && a.ValueKind == JsonValueKind.Array)
                args = a.EnumerateArray().Select(x => x.Clone()).ToArray();
        }
        catch (JsonException ex)
        {
            _log($"rpc parse error: {ex.Message}");
            return;
        }

        if (cmd.Length == 0) { Reply(idRaw, false, "\"missing cmd\""); return; }
        _log($"rpc {cmd}");

        var capturedId = idRaw;
        var capturedCmd = cmd;
        Task.Run(() =>
        {
            try
            {
                var result = Dispatch(capturedCmd, args);
                Reply(capturedId, true, result);
            }
            catch (Exception ex)
            {
                var msg = ex is AggregateException ag ? (ag.InnerException ?? ag).Message : ex.Message;
                _log($"rpc {capturedCmd} failed: {ex.GetType().Name}: {msg}");
                Reply(capturedId, false, JsonSerializer.Serialize(msg));
            }
        });
    }

    private void Reply(string idRaw, bool ok, string payloadJson) =>
        _post(ok
            ? "{\"id\":" + idRaw + ",\"ok\":true,\"result\":" + payloadJson + "}"
            : "{\"id\":" + idRaw + ",\"ok\":false,\"error\":" + payloadJson + "}");

    // ---- argument helpers --------------------------------------------------

    private static string Str(JsonElement[] a, int i, string? fallback = null)
    {
        if (i < a.Length && a[i].ValueKind == JsonValueKind.String) return a[i].GetString()!;
        if (i < a.Length && a[i].ValueKind is JsonValueKind.Null or JsonValueKind.Undefined && fallback is not null) return fallback;
        if (fallback is not null) return fallback;
        throw new ArgumentException($"argument {i} must be a string");
    }

    private static string? StrOrNull(JsonElement[] a, int i)
        => i < a.Length && a[i].ValueKind == JsonValueKind.String ? a[i].GetString() : null;

    private static JsonElement? Opt(JsonElement[] a, int i)
        => i < a.Length && a[i].ValueKind == JsonValueKind.Object ? a[i] : null;

    private static string? OptStr(JsonElement? o, string key)
        => o is { } e && e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static int OptInt(JsonElement? o, string key, int fallback)
        => o is { } e && e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : fallback;

    private static string Ser(object? value) => JsonSerializer.Serialize(value, Vault.Json);

    private const string Void = "null";

    /// <summary>Marshals a window call onto the UI thread and waits for it.</summary>
    private T Ui<T>(Func<T> f)
    {
        T result = default!;
        Exception? error = null;
        using var done = new ManualResetEventSlim(false);
        _window.RunOnUi(() =>
        {
            try { result = f(); }
            catch (Exception ex) { error = ex; }
            finally { done.Set(); }
        });
        if (!done.Wait(10000)) throw new TimeoutException("window did not respond");
        if (error is not null) throw error;
        return result;
    }

    private void Ui(Action a) => Ui<object?>(() => { a(); return null; });

    // ---- dispatch ----------------------------------------------------------

    private string Dispatch(string cmd, JsonElement[] a) => cmd switch
    {
        // filesystem
        "rootInfo" => Ser(_vault.RootInfo()),
        "tree" => Ser(_vault.Tree()),
        "list" => Ser(_vault.List(StrOrNull(a, 0) ?? "")),
        "stat" => Ser(_vault.Stat(Str(a, 0))),
        "exists" => Ser(_vault.Exists(Str(a, 0))),
        "readText" => Ser(_vault.ReadText(Str(a, 0))),
        "writeText" => Do(() => _vault.WriteText(Str(a, 0), Str(a, 1, ""))),
        "appendText" => Do(() => _vault.AppendText(Str(a, 0), Str(a, 1, ""))),
        "writeBinary" => Do(() => _vault.WriteBinary(Str(a, 0), Str(a, 1))),
        "mkdir" => Do(() => _vault.Mkdir(Str(a, 0))),
        "rename" => Do(() => _vault.Rename(Str(a, 0), Str(a, 1))),
        "trash" => Do(() => _vault.Trash(Str(a, 0))),
        "search" => Ser(_vault.Search(Str(a, 0), OptInt(Opt(a, 1), "limit", 200))),

        // claude
        "claudeInfo" => Ser(_claude.Info()),
        "claudeStart" => Ser(_claude.Start(
            OptStr(Opt(a, 0), "cwd"),
            OptStr(Opt(a, 0), "permissionMode"),
            OptStr(Opt(a, 0), "resume"),
            OptStr(Opt(a, 0), "model"))),
        "claudeSend" => Do(() => _claude.Send(Str(a, 0), Str(a, 1, ""))),
        "claudeInterrupt" => Do(() => _claude.Interrupt(Str(a, 0))),
        "claudeStop" => Do(() => _claude.Stop(Str(a, 0))),
        "claudeTranscript" => _claude.TranscriptJson(Str(a, 0, "")),

        // window
        "winMinimize" => Do(() => Ui(_window.WinMinimize)),
        "winMaximize" => Do(() => Ui(_window.WinToggleMaximize)),
        "winClose" => Do(() => Ui(_window.WinClose)),
        "winIsMaximized" => Ser(Ui(_window.WinIsMaximized)),
        "winStartDrag" => Do(() => Ui(_window.WinStartDrag)),
        "winStartResize" => Do(() => Ui(() => _window.WinStartResize(Str(a, 0)))),
        "winSetTheme" => Do(() => Ui(() => _window.WinSetTheme(Str(a, 0)))),

        // misc
        "openExternal" => Do(() => OpenExternal(Str(a, 0))),
        "reveal" => Do(() => Reveal(Str(a, 0))),
        "getState" => _vault.GetState().ToJsonString(),
        "setState" => Do(() => _vault.SetState(a.Length > 0 ? JsonNode.Parse(a[0].GetRawText()) : new JsonObject())),
        "log" => Do(() => _log("ui: " + Str(a, 0, ""))),

        _ => throw new NotSupportedException($"unknown command: {cmd}"),
    };

    private static string Do(Action a) { a(); return Void; }

    private static void OpenExternal(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            throw new ArgumentException($"not a url: {url}");
        if (uri.Scheme is not ("http" or "https" or "mailto"))
            throw new InvalidOperationException($"refusing to open scheme: {uri.Scheme}");
        Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }

    private void Reveal(string rel)
    {
        var full = _vault.Resolve(rel);
        if (!File.Exists(full) && !Directory.Exists(full))
            throw new FileNotFoundException($"nothing to reveal: {rel}");
        Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{full}\"") { UseShellExecute = false, CreateNoWindow = true });
    }
}
