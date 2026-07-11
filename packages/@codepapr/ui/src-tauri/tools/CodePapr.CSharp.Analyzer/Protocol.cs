using System.Text;
using System.Text.Json;

namespace CodePapr.CSharp.Analyzer;

internal sealed class LspMessageReader(Stream input)
{
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

        return JsonDocument.Parse(body);
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