using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace OsEditor;

/// <summary>
/// Claude Code CLI sessions. Each session is one long-lived process in stream-json mode;
/// every stdout line is forwarded to the web side untouched.
/// </summary>
internal sealed class ClaudeManager : IDisposable
{
    private sealed class Session
    {
        public required string Id;
        public required Process Proc;
        public readonly object WriteGate = new();
        public volatile bool Exited;
    }

    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    private readonly ConcurrentDictionary<string, Session> _sessions = new();
    private readonly Vault _vault;
    private readonly Action<string> _postJson;
    private readonly Action<string> _log;

    private string? _cliPath;
    private string? _cliVersion;
    private bool _cliProbed;

    public ClaudeManager(Vault vault, Action<string> postJson, Action<string> log)
    {
        _vault = vault;
        _postJson = postJson;
        _log = log;
    }

    // ---- discovery ---------------------------------------------------------

    private static string? RunCapture(string exe, string args, int timeoutMs)
    {
        try
        {
            using var p = new Process();
            p.StartInfo = new ProcessStartInfo(exe, args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Utf8NoBom,
            };
            if (!p.Start()) return null;
            var stdout = p.StandardOutput.ReadToEnd();
            if (!p.WaitForExit(timeoutMs)) { try { p.Kill(true); } catch (InvalidOperationException) { } return null; }
            return p.ExitCode == 0 ? stdout : null;
        }
        catch (Exception) { return null; }
    }

    private void Probe()
    {
        if (_cliProbed) return;
        _cliProbed = true;

        var found = RunCapture("where.exe", "claude", 8000);
        if (found is not null)
        {
            var lines = found.Split('\n', StringSplitOptions.RemoveEmptyEntries)
                             .Select(l => l.Trim()).Where(l => l.Length > 0).ToList();
            _cliPath = lines.FirstOrDefault(l => l.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                       ?? lines.FirstOrDefault();
        }
        if (_cliPath is null || !File.Exists(_cliPath))
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var candidate = Path.Combine(home, ".local", "bin", "claude.exe");
            _cliPath = File.Exists(candidate) ? candidate : null;
        }
        if (_cliPath is not null)
        {
            var v = RunCapture(_cliPath, "--version", 30000);
            _cliVersion = v?.Trim();
        }
        _log($"claude cli: {_cliPath ?? "(not found)"} {_cliVersion ?? ""}");
    }

    public object Info()
    {
        Probe();
        return _cliPath is null ? new { path = (string?)null, version = (string?)null }
                                : new { path = (string?)_cliPath, version = _cliVersion };
    }

    // ---- transcripts -------------------------------------------------------

    /// <summary>
    /// The session log Claude Code keeps at
    /// %USERPROFILE%\.claude\projects\&lt;cwd with every non-alphanumeric character replaced by '-'&gt;\&lt;id&gt;.jsonl.
    /// Returns the raw `user` and `assistant` lines as one JSON array, in file order; an unknown
    /// session or a missing file is an empty array, never an error.
    /// </summary>
    public string TranscriptJson(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId) || !sessionId.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))
            return "[]";

        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var encoded = string.Concat(_vault.Root.Select(c => char.IsAsciiLetterOrDigit(c) ? c : '-'));
        var file = Path.Combine(home, ".claude", "projects", encoded, sessionId + ".jsonl");
        if (!File.Exists(file)) return "[]";

        var sb = new StringBuilder("[");
        var first = true;
        try
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream, Utf8NoBom);
            string? line;
            while ((line = reader.ReadLine()) is not null)
            {
                if (line.Length == 0 || !LooksLikeJson(line)) continue;
                string? type;
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    type = doc.RootElement.ValueKind == JsonValueKind.Object
                        && doc.RootElement.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String
                        ? t.GetString() : null;
                }
                catch (JsonException) { continue; }
                if (type is not ("user" or "assistant")) continue;
                if (!first) sb.Append(',');
                sb.Append(line);
                first = false;
            }
        }
        catch (IOException ex) { _log($"transcript read failed: {ex.Message}"); return "[]"; }
        catch (UnauthorizedAccessException ex) { _log($"transcript read failed: {ex.Message}"); return "[]"; }
        return sb.Append(']').ToString();
    }

    // ---- lifecycle ---------------------------------------------------------

    public object Start(string? cwd, string? permissionMode, string? resume, string? model)
    {
        Probe();
        if (_cliPath is null) throw new FileNotFoundException("Claude Code CLI not found on PATH or in ~/.local/bin");

        var workdir = _vault.Resolve(cwd);
        if (!Directory.Exists(workdir)) workdir = _vault.Root;

        var mode = string.IsNullOrWhiteSpace(permissionMode) ? "default" : permissionMode;
        var id = Guid.NewGuid().ToString("N")[..12];

        var psi = new ProcessStartInfo
        {
            FileName = _cliPath,
            WorkingDirectory = workdir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = Utf8NoBom,
            StandardOutputEncoding = Utf8NoBom,
            StandardErrorEncoding = Utf8NoBom,
        };
        foreach (var a in new[] { "-p", "--output-format", "stream-json", "--input-format", "stream-json",
                                  "--verbose", "--include-partial-messages", "--permission-mode", mode })
            psi.ArgumentList.Add(a);
        if (!string.IsNullOrWhiteSpace(resume)) { psi.ArgumentList.Add("--resume"); psi.ArgumentList.Add(resume); }
        if (!string.IsNullOrWhiteSpace(model)) { psi.ArgumentList.Add("--model"); psi.ArgumentList.Add(model); }

        var proc = new Process { StartInfo = psi };
        if (!proc.Start()) throw new InvalidOperationException("failed to start the Claude Code CLI");

        var session = new Session { Id = id, Proc = proc };
        _sessions[id] = session;
        _log($"claude start {id}: {string.Join(' ', psi.ArgumentList)} (cwd {workdir})");

        StartReader(session, proc.StandardOutput, isStdErr: false);
        StartReader(session, proc.StandardError, isStdErr: true);

        return new { id };
    }

    private void StartReader(Session s, StreamReader reader, bool isStdErr)
    {
        var t = new Thread(() =>
        {
            try
            {
                string? line;
                while ((line = reader.ReadLine()) is not null)
                {
                    if (line.Length == 0) continue;
                    if (!isStdErr && LooksLikeJson(line) && IsValidJson(line)) ForwardRaw(s.Id, line);
                    else ForwardRaw(s.Id, "{\"type\":\"stderr\",\"text\":" + JsonSerializer.Serialize(line) + "}");
                }
            }
            catch (IOException) { }
            catch (ObjectDisposedException) { }

            if (isStdErr) return;
            // stdout closed: the process is finished or finishing.
            try { s.Proc.WaitForExit(10000); } catch (SystemException) { }
            if (s.Exited) return;
            s.Exited = true;
            int code;
            try { code = s.Proc.HasExited ? s.Proc.ExitCode : -1; } catch (SystemException) { code = -1; }
            _log($"claude exit {s.Id}: {code}");
            ForwardRaw(s.Id, "{\"type\":\"exit\",\"code\":" + code + "}");
            _sessions.TryRemove(s.Id, out _);
        })
        { IsBackground = true, Name = isStdErr ? "claude-stderr" : "claude-stdout" };
        t.Start();
    }

    private static bool LooksLikeJson(string line)
    {
        var c = line.TrimStart();
        return c.Length > 0 && (c[0] == '{' || c[0] == '[');
    }

    private static bool IsValidJson(string line)
    {
        try { using var _ = JsonDocument.Parse(line); return true; }
        catch (JsonException) { return false; }
    }

    /// <summary>Concatenated so the CLI's own JSON is never re-serialised.</summary>
    private void ForwardRaw(string id, string rawEventJson) =>
        _postJson("{\"event\":\"claude\",\"data\":{\"id\":" + JsonSerializer.Serialize(id) +
                  ",\"event\":" + rawEventJson + "}}");

    private Session Get(string id) =>
        _sessions.TryGetValue(id, out var s) ? s : throw new KeyNotFoundException($"no claude session {id}");

    private void WriteLine(Session s, string json)
    {
        lock (s.WriteGate)
        {
            var w = s.Proc.StandardInput;
            w.Write(json);
            w.Write('\n');
            w.Flush();
        }
    }

    public void Send(string id, string text)
    {
        var s = Get(id);
        var msg = new
        {
            type = "user",
            message = new { role = "user", content = new[] { new { type = "text", text } } },
        };
        WriteLine(s, JsonSerializer.Serialize(msg));
    }

    public void Interrupt(string id)
    {
        var s = Get(id);
        var msg = new
        {
            type = "control_request",
            request_id = Guid.NewGuid().ToString(),
            request = new { subtype = "interrupt" },
        };
        WriteLine(s, JsonSerializer.Serialize(msg));
    }

    public void Stop(string id)
    {
        if (!_sessions.TryRemove(id, out var s)) return;
        _log($"claude stop {id}");
        KillTree(s);
    }

    private static void KillTree(Session s)
    {
        try { if (!s.Proc.HasExited) s.Proc.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
        catch (NotSupportedException) { }
    }

    public void Dispose()
    {
        foreach (var id in _sessions.Keys.ToArray())
            if (_sessions.TryRemove(id, out var s)) KillTree(s);
    }
}
