using System.Text.Json;

namespace CodePapr.CSharp.Analyzer;

/// 请求参数结构不合法（缺字段/类型错误/空数组）。转成 JSON-RPC -32602 返回，
/// 绝不能让单条畸形请求杀死分析器进程。
internal sealed class InvalidParamsException(string message) : Exception(message);

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var cancellationToken = CancellationToken.None;
        var reader = new LspMessageReader(Console.OpenStandardInput());
        var output = Console.OpenStandardOutput();
        var analyzer = new RoslynAnalyzer();
        var shutdownRequested = false;

        while (true)
        {
            JsonDocument? message;
            try
            {
                message = await reader.ReadAsync(cancellationToken);
            }
            catch (LspProtocolException ex)
            {
                // 消息体已完整读出、流仍同步：记日志后继续服务，不退出。
                await Console.Error.WriteLineAsync($"[CodePapr.CSharp.Analyzer] {ex.Message}");
                continue;
            }

            if (message is null)
            {
                return 0;
            }

            var root = message.RootElement;
            (bool Exit, int ExitCode, bool Shutdown) outcome;
            try
            {
                outcome = await HandleMessageAsync(
                    root, output, analyzer, shutdownRequested, cancellationToken);
            }
            finally
            {
                message.Dispose();
            }

            if (outcome.Shutdown)
            {
                shutdownRequested = true;
            }
            if (outcome.Exit)
            {
                return outcome.ExitCode;
            }
        }
    }

    private static async Task<(bool Exit, int ExitCode, bool Shutdown)> HandleMessageAsync(
        JsonElement root,
        Stream output,
        RoslynAnalyzer analyzer,
        bool shutdownRequested,
        CancellationToken cancellationToken)
    {
        if (!root.TryGetProperty("method", out var methodElement) ||
            methodElement.ValueKind != JsonValueKind.String)
        {
            // 非请求/通知（例如客户端响应）：忽略。
            return default;
        }

        var method = methodElement.GetString() ?? string.Empty;
        var hasId = root.TryGetProperty("id", out var idElement);
        object? id = null;
        if (hasId)
        {
            try
            {
                id = JsonSerializer.Deserialize<object>(idElement.GetRawText(), Json.Options);
            }
            catch (JsonException)
            {
                id = null;
            }
        }

        var hasParams = root.TryGetProperty("params", out var paramsElement) &&
            paramsElement.ValueKind == JsonValueKind.Object;

        try
        {
            switch (method)
            {
                case "initialize":
                    await RespondAsync(output, id, new
                    {
                        capabilities = new
                        {
                            textDocumentSync = 1,
                            hoverProvider = true,
                            definitionProvider = true,
                            documentSymbolProvider = true,
                        }
                    }, cancellationToken);
                    break;
                case "initialized":
                    break;
                case "shutdown":
                    await RespondAsync(output, id, result: null, cancellationToken);
                    return (false, 0, true);
                case "exit":
                    return (true, shutdownRequested ? 0 : 1, false);
                case "textDocument/didOpen":
                    {
                        var (uri, textDocument) = RequireDocument(paramsElement, hasParams);
                        var text = RequireString(textDocument, "text");
                        analyzer.OpenOrUpdate(uri, text);
                        await PublishDiagnosticsAsync(output, analyzer, uri, cancellationToken);
                        break;
                    }
                case "textDocument/didChange":
                    {
                        var (uri, _) = RequireDocument(paramsElement, hasParams);
                        if (!paramsElement.TryGetProperty("contentChanges", out var contentChanges) ||
                            contentChanges.ValueKind != JsonValueKind.Array ||
                            contentChanges.GetArrayLength() == 0)
                        {
                            throw new InvalidParamsException("contentChanges 必须是非空数组");
                        }
                        var text = RequireString(contentChanges[0], "text");
                        analyzer.OpenOrUpdate(uri, text);
                        await PublishDiagnosticsAsync(output, analyzer, uri, cancellationToken);
                        break;
                    }
                case "textDocument/didClose":
                    {
                        var (uri, _) = RequireDocument(paramsElement, hasParams);
                        analyzer.Close(uri);
                        await NotifyAsync(output, "textDocument/publishDiagnostics", new { uri, diagnostics = Array.Empty<object>() }, cancellationToken);
                        break;
                    }
                case "textDocument/hover":
                    {
                        var (uri, position) = RequireDocumentAndPosition(paramsElement, hasParams);
                        var result = analyzer.GetHover(uri, position.Line, position.Character);
                        await RespondAsync(output, id, result, cancellationToken);
                        break;
                    }
                case "textDocument/definition":
                    {
                        var (uri, position) = RequireDocumentAndPosition(paramsElement, hasParams);
                        var result = analyzer.GetDefinition(uri, position.Line, position.Character);
                        await RespondAsync(output, id, result, cancellationToken);
                        break;
                    }
                case "textDocument/documentSymbol":
                    {
                        var (uri, _) = RequireDocument(paramsElement, hasParams);
                        var result = analyzer.GetDocumentSymbols(uri);
                        await RespondAsync(output, id, result, cancellationToken);
                        break;
                    }
                default:
                    if (hasId)
                    {
                        await RespondErrorAsync(output, id, -32601, $"Method not implemented: {method}", cancellationToken);
                    }
                    break;
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (InvalidParamsException ex)
        {
            await Console.Error.WriteLineAsync($"[CodePapr.CSharp.Analyzer] {method} 参数不合法: {ex.Message}");
            if (hasId)
            {
                await RespondErrorAsync(output, id, -32602, $"Invalid params: {ex.Message}", cancellationToken);
            }
        }
        catch (Exception ex)
        {
            // 单条请求的任何意外异常都不得终止主循环：记日志并回 JSON-RPC error。
            await Console.Error.WriteLineAsync($"[CodePapr.CSharp.Analyzer] {method} 处理失败: {ex}");
            if (hasId)
            {
                await RespondErrorAsync(output, id, -32603, $"Internal error: {ex.Message}", cancellationToken);
            }
        }

        return default;
    }

    private static (string Uri, JsonElement TextDocument) RequireDocument(JsonElement paramsElement, bool hasParams)
    {
        if (!hasParams)
        {
            throw new InvalidParamsException("缺少 params");
        }
        if (!paramsElement.TryGetProperty("textDocument", out var textDocument) ||
            textDocument.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidParamsException("textDocument 必须是对象");
        }
        var uri = RequireString(textDocument, "uri");
        return (uri, textDocument);
    }

    private static (string Uri, (int Line, int Character) Position) RequireDocumentAndPosition(
        JsonElement paramsElement, bool hasParams)
    {
        if (!hasParams)
        {
            throw new InvalidParamsException("缺少 params");
        }
        if (!paramsElement.TryGetProperty("textDocument", out var textDocument) ||
            textDocument.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidParamsException("textDocument 必须是对象");
        }
        var uri = RequireString(textDocument, "uri");
        if (!paramsElement.TryGetProperty("position", out var position) ||
            position.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidParamsException("position 必须是对象");
        }
        var line = RequireInt(position, "line");
        var character = RequireInt(position, "character");
        return (uri, (line, character));
    }

    private static string RequireString(JsonElement element, string property)
    {
        if (element.ValueKind != JsonValueKind.Object ||
            !element.TryGetProperty(property, out var value) ||
            value.ValueKind != JsonValueKind.String)
        {
            throw new InvalidParamsException($"{property} 必须是字符串");
        }
        return value.GetString() ?? string.Empty;
    }

    private static int RequireInt(JsonElement element, string property)
    {
        if (element.ValueKind != JsonValueKind.Object ||
            !element.TryGetProperty(property, out var value) ||
            value.ValueKind != JsonValueKind.Number ||
            !value.TryGetInt32(out var number))
        {
            throw new InvalidParamsException($"{property} 必须是整数");
        }
        return number;
    }

    private static Task PublishDiagnosticsAsync(Stream output, RoslynAnalyzer analyzer, string uri, CancellationToken cancellationToken)
        => NotifyAsync(output, "textDocument/publishDiagnostics", new { uri, diagnostics = analyzer.GetDiagnostics(uri) }, cancellationToken);

    private static Task RespondAsync(Stream output, object? id, object? result, CancellationToken cancellationToken)
        => LspMessageWriter.WriteAsync(output, new { jsonrpc = "2.0", id, result }, cancellationToken);

    private static Task RespondErrorAsync(Stream output, object? id, int code, string message, CancellationToken cancellationToken)
        => LspMessageWriter.WriteAsync(output, new { jsonrpc = "2.0", id, error = new { code, message } }, cancellationToken);

    private static Task NotifyAsync(Stream output, string method, object @params, CancellationToken cancellationToken)
        => LspMessageWriter.WriteAsync(output, new { jsonrpc = "2.0", method, @params }, cancellationToken);
}
