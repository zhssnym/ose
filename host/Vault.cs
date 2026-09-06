using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OsEditor;

internal sealed class Node
{
    public string Name { get; set; } = "";
    public string Path { get; set; } = "";
    public string Kind { get; set; } = "file";
    public string Ext { get; set; } = "";
    public long Mtime { get; set; }
    public long Size { get; set; }
    public List<Node>? Children { get; set; }
}

/// <summary>Every filesystem operation the bridge exposes, confined to the vault root.</summary>
internal sealed class Vault
{
    private static readonly HashSet<string> HiddenNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git", ".obsidian", ".claude", ".vscode", ".trash", "node_modules", "App",
        ".tmp.driveupload", ".makemd", ".space", "os.exe", "os.pdb",
    };

    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private static readonly JsonSerializerOptions PrettyJson = new()
    {
        WriteIndented = true,
    };

    public string Root { get; }
    public string Name => System.IO.Path.GetFileName(Root.TrimEnd('\\', '/'));

    public Vault(string root)
    {
        Root = System.IO.Path.GetFullPath(root).TrimEnd('\\');
    }

    public static bool IsHidden(string name) => name.StartsWith('.') || HiddenNames.Contains(name);

    // ---- paths -------------------------------------------------------------

    /// <summary>Vault-relative, forward slashes, no leading slash, never escaping the root.</summary>
    public string Resolve(string? rel)
    {
        rel ??= "";
        rel = rel.Replace('/', '\\').Trim();
        while (rel.StartsWith('\\')) rel = rel[1..];
        if (rel.Length == 0) return Root;
        if (System.IO.Path.IsPathRooted(rel))
            throw new InvalidOperationException($"path must be vault-relative: {rel}");
        var full = System.IO.Path.GetFullPath(System.IO.Path.Combine(Root, rel));
        if (!full.Equals(Root, StringComparison.OrdinalIgnoreCase) &&
            !full.StartsWith(Root + "\\", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"path escapes the vault: {rel}");
        return full;
    }

    public string Relative(string full)
    {
        full = System.IO.Path.GetFullPath(full);
        if (full.Equals(Root, StringComparison.OrdinalIgnoreCase)) return "";
        if (full.StartsWith(Root + "\\", StringComparison.OrdinalIgnoreCase))
            return full[(Root.Length + 1)..].Replace('\\', '/');
        return full.Replace('\\', '/');
    }

    // ---- reads -------------------------------------------------------------

    public object RootInfo() => new { root = Root, name = Name };

    private static long Ms(DateTime utc) => new DateTimeOffset(utc, TimeSpan.Zero).ToUnixTimeMilliseconds();

    private Node ToNode(FileSystemInfo info)
    {
        var isDir = (info.Attributes & FileAttributes.Directory) != 0;
        return new Node
        {
            Name = info.Name,
            Path = Relative(info.FullName),
            Kind = isDir ? "dir" : "file",
            Ext = isDir ? "" : System.IO.Path.GetExtension(info.Name).TrimStart('.').ToLowerInvariant(),
            Mtime = Ms(info.LastWriteTimeUtc),
            Size = isDir ? 0 : ((FileInfo)info).Length,
        };
    }

    private static IEnumerable<FileSystemInfo> Visible(DirectoryInfo dir)
    {
        FileSystemInfo[] entries;
        try { entries = dir.GetFileSystemInfos(); }
        catch (UnauthorizedAccessException) { yield break; }
        catch (DirectoryNotFoundException) { yield break; }

        foreach (var e in entries)
        {
            if (IsHidden(e.Name)) continue;
            if ((e.Attributes & FileAttributes.ReparsePoint) != 0) continue;
            yield return e;
        }
    }

    public List<Node> List(string? rel)
    {
        var dir = new DirectoryInfo(Resolve(rel));
        if (!dir.Exists) throw new DirectoryNotFoundException($"not a folder: {rel}");
        var nodes = Visible(dir).Select(ToNode).ToList();
        Sort(nodes);
        return nodes;
    }

    public Node Tree()
    {
        var dir = new DirectoryInfo(Root);
        var root = new Node { Name = Name, Path = "", Kind = "dir", Ext = "", Mtime = Ms(dir.LastWriteTimeUtc), Size = 0 };
        root.Children = Walk(dir, 0);
        return root;
    }

    private List<Node> Walk(DirectoryInfo dir, int depth)
    {
        var nodes = new List<Node>();
        if (depth > 24) return nodes;
        foreach (var e in Visible(dir))
        {
            var n = ToNode(e);
            if (n.Kind == "dir") n.Children = Walk((DirectoryInfo)e, depth + 1);
            nodes.Add(n);
        }
        Sort(nodes);
        return nodes;
    }

    private static void Sort(List<Node> nodes) => nodes.Sort(static (a, b) =>
    {
        if (a.Kind != b.Kind) return a.Kind == "dir" ? -1 : 1;
        return NaturalCompare(a.Name, b.Name);
    });

    /// <summary>"2. Foo" before "10. Foo": digit runs compare as numbers.</summary>
    public static int NaturalCompare(string a, string b)
    {
        int i = 0, j = 0;
        while (i < a.Length && j < b.Length)
        {
            if (char.IsDigit(a[i]) && char.IsDigit(b[j]))
            {
                int si = i, sj = j;
                while (i < a.Length && char.IsDigit(a[i])) i++;
                while (j < b.Length && char.IsDigit(b[j])) j++;
                var na = a.AsSpan(si, i - si).TrimStart('0');
                var nb = b.AsSpan(sj, j - sj).TrimStart('0');
                if (na.Length != nb.Length) return na.Length - nb.Length;
                var c = na.SequenceCompareTo(nb);
                if (c != 0) return c;
            }
            else
            {
                var ca = char.ToLowerInvariant(a[i]);
                var cb = char.ToLowerInvariant(b[j]);
                if (ca != cb) return ca - cb;
                i++; j++;
            }
        }
        return (a.Length - i) - (b.Length - j);
    }

    public object Stat(string rel)
    {
        var full = Resolve(rel);
        if (Directory.Exists(full))
        {
            var d = new DirectoryInfo(full);
            return new { exists = true, kind = "dir", mtime = Ms(d.LastWriteTimeUtc), size = 0L };
        }
        if (File.Exists(full))
        {
            var f = new FileInfo(full);
            return new { exists = true, kind = "file", mtime = Ms(f.LastWriteTimeUtc), size = f.Length };
        }
        return new { exists = false, kind = (string?)null, mtime = 0L, size = 0L };
    }

    public bool Exists(string rel)
    {
        var full = Resolve(rel);
        return File.Exists(full) || Directory.Exists(full);
    }

    public string ReadText(string rel) => File.ReadAllText(Resolve(rel), Encoding.UTF8);

    // ---- writes ------------------------------------------------------------

    private static void EnsureParent(string full)
    {
        var parent = System.IO.Path.GetDirectoryName(full);
        if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
    }

    public void WriteText(string rel, string text)
    {
        var full = Resolve(rel);
        EnsureParent(full);
        File.WriteAllText(full, text, Utf8NoBom);
    }

    public void AppendText(string rel, string text)
    {
        var full = Resolve(rel);
        EnsureParent(full);
        File.AppendAllText(full, text, Utf8NoBom);
    }

    public void WriteBinary(string rel, string base64)
    {
        var full = Resolve(rel);
        EnsureParent(full);
        File.WriteAllBytes(full, Convert.FromBase64String(base64));
    }

    public void Mkdir(string rel) => Directory.CreateDirectory(Resolve(rel));

    public void Rename(string from, string to)
    {
        var src = Resolve(from);
        var dst = Resolve(to);
        EnsureParent(dst);
        if (Directory.Exists(src)) Directory.Move(src, dst);
        else File.Move(src, dst, overwrite: false);
    }

    public void Trash(string rel)
    {
        var full = Resolve(rel);
        if (full.Equals(Root, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("refusing to trash the vault root");
        if (Directory.Exists(full))
            Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory(
                full,
                Microsoft.VisualBasic.FileIO.UIOption.OnlyErrorDialogs,
                Microsoft.VisualBasic.FileIO.RecycleOption.SendToRecycleBin,
                Microsoft.VisualBasic.FileIO.UICancelOption.ThrowException);
        else if (File.Exists(full))
            Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(
                full,
                Microsoft.VisualBasic.FileIO.UIOption.OnlyErrorDialogs,
                Microsoft.VisualBasic.FileIO.RecycleOption.SendToRecycleBin,
                Microsoft.VisualBasic.FileIO.UICancelOption.ThrowException);
        else throw new FileNotFoundException($"nothing to trash: {rel}");
    }

    // ---- search ------------------------------------------------------------

    public List<object> Search(string query, int limit)
    {
        var hits = new List<object>();
        if (string.IsNullOrEmpty(query)) return hits;
        if (limit <= 0) limit = 200;
        SearchDir(new DirectoryInfo(Root), query, limit, hits, 0);
        return hits;
    }

    private void SearchDir(DirectoryInfo dir, string query, int limit, List<object> hits, int depth)
    {
        if (hits.Count >= limit || depth > 24) return;
        foreach (var e in Visible(dir))
        {
            if (hits.Count >= limit) return;
            if (e is DirectoryInfo sub) { SearchDir(sub, query, limit, hits, depth + 1); continue; }
            if (!e.Name.EndsWith(".md", StringComparison.OrdinalIgnoreCase)) continue;

            string[] lines;
            try { lines = File.ReadAllLines(e.FullName, Encoding.UTF8); }
            catch (IOException) { continue; }
            catch (UnauthorizedAccessException) { continue; }

            var rel = Relative(e.FullName);
            for (var i = 0; i < lines.Length; i++)
            {
                if (lines[i].IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0) continue;
                var text = lines[i].Trim();
                if (text.Length > 240) text = text[..240];
                hits.Add(new { path = rel, line = i + 1, text });
                if (hits.Count >= limit) return;
            }
        }
    }

    // ---- state.json --------------------------------------------------------

    public string StatePath => System.IO.Path.Combine(Root, "App", "state.json");

    public JsonObject GetState()
    {
        try
        {
            if (!File.Exists(StatePath)) return new JsonObject();
            var text = File.ReadAllText(StatePath, Encoding.UTF8);
            if (string.IsNullOrWhiteSpace(text)) return new JsonObject();
            return JsonNode.Parse(text) as JsonObject ?? new JsonObject();
        }
        catch (JsonException) { return new JsonObject(); }
        catch (IOException) { return new JsonObject(); }
    }

    public void SetState(JsonNode? state)
    {
        var obj = state as JsonObject ?? new JsonObject();
        var dir = System.IO.Path.GetDirectoryName(StatePath)!;
        Directory.CreateDirectory(dir);
        var tmp = StatePath + ".tmp";
        File.WriteAllText(tmp, obj.ToJsonString(PrettyJson), Utf8NoBom);
        File.Move(tmp, StatePath, overwrite: true);
    }

    private readonly object _stateLock = new();

    /// <summary>Read, merge one key, write. Used by the host for "window" and "theme".</summary>
    public void PatchState(string key, JsonNode? value)
    {
        lock (_stateLock)
        {
            var state = GetState();
            state[key] = value;
            SetState(state);
        }
    }
}
