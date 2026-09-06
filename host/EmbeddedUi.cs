using System.Reflection;

namespace OsEditor;

/// <summary>
/// The Vite build output embedded at compile time, served at https://app.os/.
/// Resource names come in as "ui/assets\index-x.js" (MSBuild keeps the OS separator),
/// so every lookup key is normalised to forward slashes.
/// </summary>
internal static class EmbeddedUi
{
    private static readonly Dictionary<string, string> Ui = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, string> Builtin = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Assembly Asm = typeof(EmbeddedUi).Assembly;

    static EmbeddedUi()
    {
        foreach (var name in Asm.GetManifestResourceNames())
        {
            var norm = name.Replace('\\', '/');
            if (norm.StartsWith("ui/", StringComparison.OrdinalIgnoreCase))
                Ui[norm[3..]] = name;
            else if (norm.StartsWith("builtin/", StringComparison.OrdinalIgnoreCase))
                Builtin[norm[8..]] = name;
        }
    }

    public static bool HasBuiltUi => Ui.ContainsKey("index.html");

    public static int Count => Ui.Count;

    public static IEnumerable<string> Names => Ui.Keys;

    /// <summary>Path from the request URI, without the leading slash. Empty means index.html.</summary>
    public static byte[]? Get(string path, out string mime)
    {
        mime = "application/octet-stream";
        path = path.Replace('\\', '/').TrimStart('/');
        if (path.Length == 0) path = "index.html";
        if (path.EndsWith('/')) path += "index.html";

        if (!Ui.TryGetValue(path, out var res) && !Builtin.TryGetValue(path, out res)) return null;

        using var s = Asm.GetManifestResourceStream(res);
        if (s is null) return null;
        var buf = new byte[s.Length];
        s.ReadExactly(buf);
        mime = MimeOf(path);
        return buf;
    }

    public static string MimeOf(string path)
    {
        var i = path.LastIndexOf('.');
        var ext = i < 0 ? "" : path[(i + 1)..].ToLowerInvariant();
        return ext switch
        {
            "html" or "htm" => "text/html; charset=utf-8",
            "js" or "mjs" => "text/javascript; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "json" or "map" => "application/json; charset=utf-8",
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "jpg" or "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "avif" => "image/avif",
            "ico" => "image/x-icon",
            "wasm" => "application/wasm",
            "woff2" => "font/woff2",
            "woff" => "font/woff",
            "ttf" => "font/ttf",
            "otf" => "font/otf",
            "txt" or "md" => "text/plain; charset=utf-8",
            "webmanifest" => "application/manifest+json",
            _ => "application/octet-stream",
        };
    }
}
