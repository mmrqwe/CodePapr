using System.Text;
using System.Text.Json;

namespace CodePapr.CSharp.Analyzer;

/// 消息体已按 Content-Length 完整读出（流仍同步），但内容违反协议
/// （畸形 JSON 等）。主循环应记录日志并继续服务，而不是退出。
internal sealed class LspProtocolException(string message) : Exception(message);

internal sealed class LspMessageReader(Stream input)
{
    /// 协议层内存闸门：绝不按对端声明的长度无上限分配。
    /// 单条 LSP 消息（含整文件 didOpen 文本）远超不到 8MB；超限即拒绝。
    public const int MaxContentLength = 8 * 1024 * 1024;

    /// 头部行长度上限：无 CRLF 终止的恶意头部不得无限撑大缓冲区。
    private const int MaxHeaderLineBytes = 8 * 1024;

    public async Task<JsonDocument?> ReadAsync(CancellationToken cancellationToken)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        while (true)
        {
            var line = await ReadHeaderLineAsync(input, cancellationToken);
            if (line is null)
            {
                return null;
            }

            if (line.Length == 0)
            {
                break;
            }

            var separatorIndex = line.IndexOf(':');
            if (separatorIndex <= 0)
            {
                continue;
            }

            var name = line[..separatorIndex].Trim();
            var value = line[(separatorIndex + 1)..].Trim();
            headers[name] = value;
        }

        if (!headers.TryGetValue("Content-Length", out var contentLengthRaw) ||
            !int.TryParse(contentLengthRaw, out var contentLength) ||
            contentLength <= 0)
        {
            return null;
        }

        if (contentLength > MaxContentLength)
        {
            // 声明长度超限：无法安全分配，也无法在不读空 2GB 级声明体的情况下
            // 重新同步流——记错误日志后受控关闭会话。
            await Console.Error.WriteLineAsync(
                $"[CodePapr.CSharp.Analyzer] Content-Length {contentLength} 超过上限 {MaxContentLength}，拒绝该消息并关闭会话");
            return null;
        }

        var body = new byte[contentLength];
        var offset = 0;
        while (offset < contentLength)
        {
            var read = await input.ReadAsync(body.AsMemory(offset, contentLength - offset), cancellationToken);
            if (read == 0)
            {
                return null;
            }
            offset += read;
        }

        try
        {
            return JsonDocument.Parse(body);
        }
        catch (JsonException ex)
        {
            // body 已完整读出、流仍同步：作为可恢复协议错误上抛，主循环继续。
            throw new LspProtocolException($"消息体不是合法 JSON: {ex.Message}");
        }
    }

    private static async Task<string?> ReadHeaderLineAsync(Stream input, CancellationToken cancellationToken)
    {
        using var buffer = new MemoryStream();
        while (true)
        {
            var singleByte = new byte[1];
            var read = await input.ReadAsync(singleByte.AsMemory(0, 1), cancellationToken);
            if (read == 0)
            {
                return buffer.Length == 0 ? null : Encoding.ASCII.GetString(buffer.ToArray()).TrimEnd('\r', '\n');
            }

            buffer.WriteByte(singleByte[0]);
            if (buffer.Length > MaxHeaderLineBytes)
            {
                // 头部行异常（无 CRLF 的无限流）：视为会话损坏，受控关闭。
                return null;
            }
            if (buffer.Length >= 2)
            {
                var span = buffer.GetBuffer().AsSpan(0, (int)buffer.Length);
                if (span[^2] == '\r' && span[^1] == '\n')
                {
                    return Encoding.ASCII.GetString(span[..^2]);
                }
            }
        }
    }
}

internal static class LspMessageWriter
{
    public static async Task WriteAsync(Stream output, object message, CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(message, Json.Options);
        var header = Encoding.ASCII.GetBytes($"Content-Length: {payload.Length}\r\n\r\n");
        await output.WriteAsync(header, cancellationToken);
        await output.WriteAsync(payload, cancellationToken);
        await output.FlushAsync(cancellationToken);
    }
}

internal static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };
}
