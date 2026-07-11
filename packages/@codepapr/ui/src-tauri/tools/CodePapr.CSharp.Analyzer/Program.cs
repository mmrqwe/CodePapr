using System.Text.Json;

namespace CodePapr.CSharp.Analyzer;

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
            using var message = await reader.ReadAsync(cancellationToken);
            if (message is null)
            {
                return 0;
            }

            var root = message.RootElement;
            if (!root.TryGetProperty("method", out var methodElement))
            {
                continue;
            }

            var method = methodElement.GetString() ?? string.Empty;
            var hasId = root.TryGetProperty("id", out var idElement);
            var id = hasId ? JsonSerializer.Deserialize<object>(idElement.GetRawText(), Json.Options) : null;
            var @params = root.TryGetProperty("params", out var paramsElement)
                ? JsonDocument.Parse(paramsElement.GetRawText()).RootElement.Clone()
                : default;

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
                    shutdownRequested = true;
                    await RespondAsync(output, id, result: null, cancellationToken);
                    break;
                case "exit":
                    return shutdownRequested ? 0 : 1;
                case "textDocument/didOpen":
                    {
                        var textDocument = @params.GetProperty("textDocument");
                        var uri = textDocument.GetProperty("uri").GetString() ?? string.Empty;
                        var text = textDocument.GetProperty("text").GetString() ?? string.Empty;
                        analyzer.OpenOrUpdate(uri, text);
                        await PublishDiagnosticsAsync(output, analyzer, uri, cancellationToken);
                        break;
                    }
                case "textDocument/didChange":
                    {
                        var textDocument = @params.GetProperty("textDocument");
                        var uri = textDocument.GetProperty("uri").GetString() ?? string.Empty;
                        var text = @params.GetProperty("contentChanges")[0].GetProperty("text").GetString() ?? string.Empty;
                        analyzer.OpenOrUpdate(uri, text);
                        await PublishDiagnosticsAsync(output, analyzer, uri, cancellationToken);
                        break;
                    }
                case "textDocument/didClose":
                    {
                        var uri = @params.GetProperty("textDocument").GetProperty("uri").GetString() ?? string.Empty;
                        analyzer.Close(uri);
                        await NotifyAsync(output, "textDocument/publishDiagnostics", new { uri, diagnostics = Array.Empty<object>() }, cancellationToken);
                        break;
                    }
                case "textDocument/hover":
                    {
                        var uri = @params.GetProperty("textDocument").GetProperty("uri").GetString() ?? string.Empty;
                        var position = @params.GetProperty("position");
                        var result = analyzer.GetHover(uri, position.GetProperty("line").GetInt32(), position.GetProperty("character").GetInt32());
                        await RespondAsync(output, id, result, cancellationToken);
                        break;
                    }
                case "textDocument/definition":
                    {
                        var uri = @params.GetProperty("textDocument").GetProperty("uri").GetString() ?? string.Empty;
                        var position = @params.GetProperty("position");
                        var result = analyzer.GetDefinition(uri, position.GetProperty("line").GetInt32(), position.GetProperty("character").GetInt32());
                        await RespondAsync(output, id, result, cancellationToken);
                        break;
                    }
                case "textDocument/documentSymbol":
                    {
                        var uri = @params.GetProperty("textDocument").GetProperty("uri").GetString() ?? string.Empty;
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