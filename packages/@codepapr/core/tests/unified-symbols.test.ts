import { describe, expect, it } from 'vitest';
import {
  SymbolProviderRegistry,
  UnifiedSymbolDispatcher,
  sourceToConfidence,
  type SymbolProvider,
  type UnifiedSymbolDefinition,
  type SymbolSource,
} from '../src/tool/unifiedSymbols';

function makeSymbol(name: string, source: SymbolSource): UnifiedSymbolDefinition {
  return {
    name,
    kind: 12,
    signature: `${name}()`,
    detail: '',
    line: 0,
    column: 0,
    endColumn: name.length,
    exported: true,
    symbolSource: source,
  };
}

function makeProvider(overrides: Partial<SymbolProvider> & { source: SymbolSource }): SymbolProvider {
  return {
    languageId: 'typescript',
    providerName: `provider-${overrides.source}`,
    capability: ['symbols'],
    extractSymbols: async () => [],
    ...overrides,
  };
}

describe('SymbolProviderRegistry', () => {
  it('orders providers by source priority (lsp before ast before regex)', () => {
    const registry = new SymbolProviderRegistry();
    registry.register('typescript', makeProvider({ source: 'regex' }));
    registry.register('typescript', makeProvider({ source: 'lsp' }));
    registry.register('typescript', makeProvider({ source: 'ast' }));
    const providers = registry.getProviders('typescript');
    expect(providers.map((p) => p.source)).toEqual(['lsp', 'ast', 'regex']);
  });

  it('returns a defensive copy so callers cannot corrupt priority order', () => {
    const registry = new SymbolProviderRegistry();
    registry.register('typescript', makeProvider({ source: 'lsp' }));
    registry.register('typescript', makeProvider({ source: 'ast' }));
    const first = registry.getProviders('typescript');
    first.reverse();
    const second = registry.getProviders('typescript');
    expect(second.map((p) => p.source)).toEqual(['lsp', 'ast']);
  });
});

describe('UnifiedSymbolDispatcher fallback', () => {
  it('uses the highest-priority provider that yields results', async () => {
    const registry = new SymbolProviderRegistry();
    registry.register('typescript', makeProvider({
      source: 'lsp',
      extractSymbols: async () => [makeSymbol('fromLsp', 'lsp')],
    }));
    registry.register('typescript', makeProvider({
      source: 'ast',
      extractSymbols: async () => [makeSymbol('fromAst', 'ast')],
    }));
    const dispatcher = new UnifiedSymbolDispatcher(registry);
    const result = await dispatcher.extractSymbols('typescript', 'a.ts', 'x');
    expect(result.source).toBe('lsp');
    expect(result.symbols[0].name).toBe('fromLsp');
    expect(result.confidence).toBe('high');
  });

  it('falls back to the next provider when a higher-priority one throws', async () => {
    const registry = new SymbolProviderRegistry();
    registry.register('typescript', makeProvider({
      source: 'lsp',
      extractSymbols: async () => { throw new Error('lsp down'); },
    }));
    registry.register('typescript', makeProvider({
      source: 'ast',
      extractSymbols: async () => [makeSymbol('fromAst', 'ast')],
    }));
    const dispatcher = new UnifiedSymbolDispatcher(registry);
    const result = await dispatcher.extractSymbols('typescript', 'a.ts', 'x');
    expect(result.source).toBe('ast');
    expect(result.symbols[0].name).toBe('fromAst');
  });

  it('falls back when a higher-priority provider returns empty results', async () => {
    const registry = new SymbolProviderRegistry();
    registry.register('typescript', makeProvider({
      source: 'lsp',
      extractSymbols: async () => [],
    }));
    registry.register('typescript', makeProvider({
      source: 'regex',
      extractSymbols: async () => [makeSymbol('fromRegex', 'regex')],
    }));
    const dispatcher = new UnifiedSymbolDispatcher(registry);
    const result = await dispatcher.extractSymbols('typescript', 'a.ts', 'x');
    expect(result.source).toBe('regex');
    expect(result.confidence).toBe('low');
  });

  it('returns none/low when no provider yields results', async () => {
    const registry = new SymbolProviderRegistry();
    registry.register('typescript', makeProvider({ source: 'lsp', extractSymbols: async () => [] }));
    const dispatcher = new UnifiedSymbolDispatcher(registry);
    const result = await dispatcher.extractSymbols('typescript', 'a.ts', 'x');
    expect(result.source).toBe('none');
    expect(result.symbols).toEqual([]);
  });

  it('falls back for definition when the LSP provider throws', async () => {
    const registry = new SymbolProviderRegistry();
    registry.register('typescript', makeProvider({
      source: 'lsp',
      capability: ['definition'],
      definition: async () => { throw new Error('boom'); },
    }));
    registry.register('typescript', makeProvider({
      source: 'ast',
      capability: ['definition'],
      definition: async () => [{ uri: 'file:///a.ts', line: 1, character: 0 }],
    }));
    const dispatcher = new UnifiedSymbolDispatcher(registry);
    const result = await dispatcher.definition('typescript', 'a.ts', 'x', 0, 0);
    expect(result).toHaveLength(1);
  });
});

describe('sourceToConfidence', () => {
  it('maps known sources to confidence levels', () => {
    expect(sourceToConfidence('lsp')).toBe('high');
    expect(sourceToConfidence('ast')).toBe('medium');
    expect(sourceToConfidence('regex')).toBe('low');
    expect(sourceToConfidence('none')).toBe('low');
  });

  it('falls back to low for an unexpected runtime source', () => {
    expect(sourceToConfidence('bogus' as SymbolSource)).toBe('low');
  });
});
