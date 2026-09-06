using System.Text.Json;

namespace OsEditor;

/// <summary>Watches the vault and emits debounced, deduplicated batches of changes.</summary>
internal sealed class Watcher : IDisposable
{
    private sealed record Change(string Path, string Kind, string? To);

    private readonly Vault _vault;
    private readonly Action<string> _postJson;
    private readonly Action<string> _log;
    private readonly object _gate = new();
    private readonly List<Change> _pending = new();
    private readonly HashSet<string> _seen = new(StringComparer.OrdinalIgnoreCase);
    private readonly System.Threading.Timer _timer;

    private FileSystemWatcher? _fsw;
    private bool _disposed;

    public Watcher(Vault vault, Action<string> postJson, Action<string> log)
    {
        _vault = vault;
        _postJson = postJson;
        _log = log;
        _timer = new System.Threading.Timer(_ => Flush(), null, Timeout.Infinite, Timeout.Infinite);
        Start();
    }

    private void Start()
    {
        Stop();
        var w = new FileSystemWatcher(_vault.Root)
        {
            IncludeSubdirectories = true,
            InternalBufferSize = 64 * 1024,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName
                         | NotifyFilters.LastWrite | NotifyFilters.Size,
        };
        w.Created += (_, e) => Queue(e.FullPath, "create", null);
        w.Changed += (_, e) => Queue(e.FullPath, "modify", null);
        w.Deleted += (_, e) => Queue(e.FullPath, "delete", null);
        w.Renamed += (_, e) => Queue(e.OldFullPath, "rename", e.FullPath);
        w.Error += OnError;
        w.EnableRaisingEvents = true;
        _fsw = w;
    }

    private void Stop()
    {
        var w = _fsw;
        _fsw = null;
        if (w is null) return;
        try { w.EnableRaisingEvents = false; w.Dispose(); } catch (ObjectDisposedException) { }
    }

    private void OnError(object sender, ErrorEventArgs e)
    {
        _log($"watcher error: {e.GetException().Message}; restarting");
        if (_disposed) return;
        try { Start(); }
        catch (Exception ex) { _log($"watcher restart failed: {ex.Message}"); }
    }

    /// <summary>True for anything under a hidden folder or under App/.</summary>
    private bool Ignored(string full)
    {
        var rel = _vault.Relative(full);
        if (rel.Length == 0) return true;
        foreach (var part in rel.Split('/'))
            if (Vault.IsHidden(part)) return true;
        return false;
    }

    private void Queue(string full, string kind, string? to)
    {
        if (_disposed) return;
        if (Ignored(full) && (to is null || Ignored(to))) return;

        var path = _vault.Relative(full);
        var toRel = to is null ? null : _vault.Relative(to);
        lock (_gate)
        {
            var key = $"{kind}|{path}|{toRel}";
            if (_seen.Add(key)) _pending.Add(new Change(path, kind, toRel));
            if (_pending.Count > 2000) { _timer.Change(0, Timeout.Infinite); return; }
        }
        _timer.Change(150, Timeout.Infinite);
    }

    private void Flush()
    {
        Change[] batch;
        lock (_gate)
        {
            if (_pending.Count == 0) return;
            batch = _pending.ToArray();
            _pending.Clear();
            _seen.Clear();
        }

        var sb = new System.Text.StringBuilder();
        sb.Append("{\"event\":\"fs\",\"data\":{\"changes\":[");
        for (var i = 0; i < batch.Length; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append("{\"path\":").Append(JsonSerializer.Serialize(batch[i].Path));
            sb.Append(",\"kind\":").Append(JsonSerializer.Serialize(batch[i].Kind));
            if (batch[i].To is { } to) sb.Append(",\"to\":").Append(JsonSerializer.Serialize(to));
            sb.Append('}');
        }
        sb.Append("]}}");

        _log($"fs batch: {batch.Length} change(s)");
        _postJson(sb.ToString());
    }

    public void Dispose()
    {
        _disposed = true;
        Stop();
        _timer.Dispose();
    }
}
