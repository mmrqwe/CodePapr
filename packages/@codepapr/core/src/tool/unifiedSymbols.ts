export type SymbolSource = 'lsp' | 'ast' | 'regex' | 'none';

export type SymbolConfidence = 'high' | 'medium' | 'low';

export type ProviderCapability =
  | 'symbols'
  | 'definition'
  | 'hover'
  | 'references'
  | 'diagnostics'
  | 'edge-enrich';

export interface UnifiedSymbolDefinition {
  name: string;
  kind: number;
  signature: string;
  detail: string;
  line: number;
  column: number;
  endColumn: number;
  containerName?: string;
  exported: boolean;
  symbolSource: SymbolSource;
}

export interface SymbolLocation {
  uri: string;
  line: number;
  character: number;
}

export interface HoverResult {
  contents: string;
  line: number;
  startColumn: number;
  endColumn: number;
}

export interface ResolvedProviderInfo {
  languageId: string;
  providerName: string;
  source: SymbolSource;
  capability: ProviderCapability[];
  fallbackChain: string[];
}

export interface SymbolProvider {
  readonly languageId: string;
  readonly providerName: string;
  readonly source: SymbolSource;
  readonly capability: ProviderCapability[];

  extractSymbols(
    path: string,
    content: string,
  ): Promise<UnifiedSymbolDefinition[]>;

  hover?(
    path: string,
    content: string,
    line: number,
    character: number,
  ): Promise<HoverResult | null>;

  definition?(
    path: string,
    content: string,
    line: number,
    character: number,
  ): Promise<SymbolLocation[]>;

  references?(
    path: string,
    content: string,
    line: number,
    character: number,
  ): Promise<SymbolLocation[]>;
}

export interface DispatchResult {
  symbols: UnifiedSymbolDefinition[];
  source: SymbolSource;
  confidence: SymbolConfidence;
}

function sourcePriority(source: SymbolSource): number {
  switch (source) {
    case 'lsp': return 0;
    case 'ast': return 1;
    case 'regex': return 2;
    case 'none': return 3;
    default: return 3;
  }
}

export function sourceToConfidence(source: SymbolSource): SymbolConfidence {
  switch (source) {
    case 'lsp': return 'high';
    case 'ast': return 'medium';
    case 'regex': return 'low';
    case 'none': return 'low';
    default: return 'low';
  }
}

export class SymbolProviderRegistry {
  private providersByLanguage = new Map<string, SymbolProvider[]>();

  register(languageId: string, provider: SymbolProvider): void {
    const existing = this.providersByLanguage.get(languageId) ?? [];
    existing.push(provider);
    existing.sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source));
    this.providersByLanguage.set(languageId, existing);
  }

  getProviders(languageId: string): SymbolProvider[] {
    return [...(this.providersByLanguage.get(languageId) ?? [])];
  }

  hasProviders(languageId: string): boolean {
    return (this.providersByLanguage.get(languageId)?.length ?? 0) > 0;
  }

  allLanguageIds(): string[] {
    return [...this.providersByLanguage.keys()];
  }
}

export class UnifiedSymbolDispatcher {
  private static readonly PROVIDER_TIMEOUT_MS = 20_000;

  constructor(private registry: SymbolProviderRegistry) {}

  private withProviderTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Symbol provider 超时（${UnifiedSymbolDispatcher.PROVIDER_TIMEOUT_MS}ms）。`)),
        UnifiedSymbolDispatcher.PROVIDER_TIMEOUT_MS,
      );
    });
    // provider 没有取消通道：超时先胜出后底层请求仍在运行。落败的 promise
    // 稍后可能 reject，必须挂 handler，否则成为 unhandled rejection。
    promise.catch(() => undefined);
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    }) as Promise<T>;
  }

  async extractSymbols(languageId: string, path: string, content: string): Promise<DispatchResult> {
    const providers = this.registry.getProviders(languageId);
    for (const provider of providers) {
      if (!provider.capability.includes('symbols')) continue;
      try {
        const symbols = await this.withProviderTimeout(provider.extractSymbols(path, content));
        if (symbols.length > 0) {
          return { symbols, source: provider.source, confidence: sourceToConfidence(provider.source) };
        }
      } catch {
        continue;
      }
    }
    return { symbols: [], source: 'none', confidence: 'low' };
  }

  async hover(languageId: string, path: string, content: string, line: number, character: number): Promise<HoverResult | null> {
    const providers = this.registry.getProviders(languageId);
    for (const provider of providers) {
      if (!provider.capability.includes('hover') || !provider.hover) continue;
      try {
        const result = await this.withProviderTimeout(provider.hover(path, content, line, character));
        if (result) return result;
      } catch {
        continue;
      }
    }
    return null;
  }

  async definition(languageId: string, path: string, content: string, line: number, character: number): Promise<SymbolLocation[]> {
    const providers = this.registry.getProviders(languageId);
    for (const provider of providers) {
      if (!provider.capability.includes('definition') || !provider.definition) continue;
      try {
        const result = await this.withProviderTimeout(provider.definition(path, content, line, character));
        if (result.length > 0) return result;
      } catch {
        continue;
      }
    }
    return [];
  }

  async references(languageId: string, path: string, content: string, line: number, character: number): Promise<SymbolLocation[]> {
    const providers = this.registry.getProviders(languageId);
    for (const provider of providers) {
      if (!provider.capability.includes('references') || !provider.references) continue;
      try {
        const result = await this.withProviderTimeout(provider.references(path, content, line, character));
        if (result.length > 0) return result;
      } catch {
        continue;
      }
    }
    return [];
  }

  getRegistry(): SymbolProviderRegistry {
    return this.registry;
  }
}
