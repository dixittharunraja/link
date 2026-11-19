using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;

namespace Link.FsDriver;

/// Deserialized from /roots
public class FsRoot
{
    [JsonPropertyName("name")]  public string Name  { get; set; } = "";
    [JsonPropertyName("path")]  public string Path  { get; set; } = "";
    [JsonPropertyName("totalSpace")] public long TotalSpace { get; set; }
    [JsonPropertyName("freeSpace")]  public long FreeSpace  { get; set; }
}

/// Deserialized from /stat and /readdir items
public class FsEntry
{
    [JsonPropertyName("name")]        public string Name        { get; set; } = "";
    [JsonPropertyName("isDirectory")] public bool   IsDirectory { get; set; }
    [JsonPropertyName("size")]        public long   Size        { get; set; }
    [JsonPropertyName("mtime")]       public long   Mtime       { get; set; }
}

/// Client for the Link app's loopback, token-authenticated file API (src-tauri/src/core/mount.rs).
/// Methods are synchronous because WinFsp callbacks must return their result directly.
public class ApiClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly string     _base;

    public ApiClient(int port, string token)
    {
        _base = $"http://127.0.0.1:{port}";
        _http = new HttpClient();
        _http.DefaultRequestHeaders.Add("X-Link-Token", token);
        _http.Timeout = TimeSpan.FromSeconds(60);
    }

    // ------------------------------------------------------------------
    // Metadata calls
    // ------------------------------------------------------------------

    public FsRoot[] Roots()
        => Get<FsRoot[]>("/roots") ?? Array.Empty<FsRoot>();

    public FsEntry? Stat(string realPath)
        => Get<FsEntry>($"/stat?path={Uri.EscapeDataString(realPath)}");

    public FsEntry[] Readdir(string realPath)
        => Get<FsEntry[]>($"/readdir?path={Uri.EscapeDataString(realPath)}") ?? Array.Empty<FsEntry>();

    // ------------------------------------------------------------------
    // Data calls
    // ------------------------------------------------------------------

    /// Returns the bytes read, or null on error.
    public byte[]? Read(string realPath, long offset, int length)
    {
        try
        {
            var url = $"{_base}/read?path={Uri.EscapeDataString(realPath)}&offset={offset}&length={length}";
            var resp = _http.GetAsync(url).GetAwaiter().GetResult();
            if (!resp.IsSuccessStatusCode) return null;
            return resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[ApiClient] Read error: {ex.Message}");
            return null;
        }
    }

    /// Sends a chunk to the device and blocks until it is acknowledged. Returns true on success.
    public bool Write(string realPath, long offset, byte[] data)
    {
        try
        {
            var url  = $"{_base}/write?path={Uri.EscapeDataString(realPath)}&offset={offset}";
            var body = new ByteArrayContent(data);
            body.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
            var resp = _http.PostAsync(url, body).GetAwaiter().GetResult();
            return resp.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[ApiClient] Write error: {ex.Message}");
            return false;
        }
    }

    public bool Create(string realPath, bool isDirectory)
        => PostJson("/create", new { path = realPath, isDirectory });

    public bool Delete(string realPath)
        => PostJson("/delete", new { path = realPath });

    public bool Rename(string realPath, string newRealPath)
        => PostJson("/rename", new { path = realPath, newPath = newRealPath });

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private T? Get<T>(string relativeUrl)
    {
        try
        {
            var resp = _http.GetAsync($"{_base}{relativeUrl}").GetAwaiter().GetResult();
            if (!resp.IsSuccessStatusCode) return default;
            var json = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();
            return JsonSerializer.Deserialize<T>(json);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[ApiClient] GET {relativeUrl} error: {ex.Message}");
            return default;
        }
    }

    private bool PostJson(string relativeUrl, object payload)
    {
        try
        {
            var json = JsonSerializer.Serialize(payload);
            var body = new StringContent(json, Encoding.UTF8, "application/json");
            var resp = _http.PostAsync($"{_base}{relativeUrl}", body).GetAwaiter().GetResult();
            return resp.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[ApiClient] POST {relativeUrl} error: {ex.Message}");
            return false;
        }
    }

    public void Dispose() => _http.Dispose();
}
