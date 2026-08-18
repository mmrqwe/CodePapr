import { afterEach, describe, expect, it } from 'vitest';
import { buildAgentRuntimeSystemPrompt, buildAgentSessionBootstrapPrompt } from './promptBuilders';
import { useCharactersStore } from '../charactersStore';
import type { CharacterProfile } from '../../utils/characterTypes';
import { createDefaultMcpSettings } from '../../utils/mcpTypes';
import type { McpSettings } from '../../utils/mcpTypes';
import type { Settings } from './types';

function makeCharacter(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  const now = new Date().toISOString();
  return {
    id: 'char-test',
    name: 'TestChar',
    avatarDataUrl: null,
    description: 'UNIQUE_CHAR_DESCRIPTION_MARKER',
    personality: '',
    scenario: '',
    firstMessage: '',
    exampleMessages: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    tags: [],
    creator: '',
    characterVersion: '',
    source: 'manual',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    systemPrompt: '',
    lang: 'zh-CN',
    ...overrides,
  } as unknown as Settings;
}

describe('buildAgentSessionBootstrapPrompt', () => {
  afterEach(() => {
    useCharactersStore.setState({ characters: [], activeCharacterId: null });
  });

  it('includes the custom system prompt in the bootstrap', () => {
    const settings = makeSettings({ systemPrompt: 'CUSTOM_SYS_PROMPT_MARKER' });
    const bootstrap = buildAgentSessionBootstrapPrompt(settings, '/tmp/ws', [], 'some memory');
    expect(bootstrap).toContain('CUSTOM_SYS_PROMPT_MARKER');
    expect(bootstrap).toContain('some memory');
  });

  it('injects the active character description into the bootstrap, not the prefix', () => {
    const character = makeCharacter();
    useCharactersStore.setState({
      characters: [character],
      activeCharacterId: character.id,
    });

    const settings = makeSettings({ systemPrompt: 'CUSTOM_SYS_PROMPT_MARKER' });
    const bootstrap = buildAgentSessionBootstrapPrompt(settings, '/tmp/ws', [], 'some memory');

    expect(bootstrap).toContain('CUSTOM_SYS_PROMPT_MARKER');
    expect(bootstrap).toContain('UNIQUE_CHAR_DESCRIPTION_MARKER');
    expect(bootstrap).toContain('Work in the voice of');
    expect(bootstrap).toContain('## 角色人设');
  });

  it('omits the custom guidance section entirely when system prompt is empty', () => {
    const settings = makeSettings({ systemPrompt: '   ' });
    const bootstrap = buildAgentSessionBootstrapPrompt(settings, '/tmp/ws', [], 'some memory');
    expect(bootstrap).toContain('some memory');
    expect(bootstrap).not.toContain('长期附加指导');
  });
});

function makeRuntimeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    systemPrompt: '',
    lang: 'zh-CN',
    model: 'main-model',
    mentorEnabled: false,
    multimodalEnabled: false,
    multimodalModelTier: 'all',
    fastModelEnabled: false,
    fastModel: '',
    mcp: createDefaultMcpSettings(),
    ...overrides,
  } as unknown as Settings;
}

describe('buildAgentRuntimeSystemPrompt', () => {
  afterEach(() => {
    useCharactersStore.setState({ characters: [], activeCharacterId: null });
  });

  it('keeps the active character out of the runtime system prompt', () => {
    const character = makeCharacter();
    useCharactersStore.setState({
      characters: [character],
      activeCharacterId: character.id,
    });
    const prompt = buildAgentRuntimeSystemPrompt(makeRuntimeSettings(), 'agent', '/tmp/ws');
    expect(prompt).not.toContain('UNIQUE_CHAR_DESCRIPTION_MARKER');
    expect(prompt).not.toContain('Work in the voice of');
  });

  it('omits the read_image hint when multimodal is disabled', () => {
    const settings = makeRuntimeSettings({ multimodalEnabled: false });
    const prompt = buildAgentRuntimeSystemPrompt(settings, 'agent', '/tmp/ws');
    expect(prompt).not.toContain('read_image');
  });

  it('includes the read_image hint when multimodal is enabled', () => {
    const settings = makeRuntimeSettings({ multimodalEnabled: true });
    const prompt = buildAgentRuntimeSystemPrompt(settings, 'agent', '/tmp/ws');
    expect(prompt).toContain('read_image');
  });

  it('respects multimodalModelTier against the effective model', () => {
    const settings = makeRuntimeSettings({
      multimodalEnabled: true,
      multimodalModelTier: 'primary',
      fastModelEnabled: true,
      fastModel: 'fast-model',
    });
    const onPrimary = buildAgentRuntimeSystemPrompt(settings, 'agent', '/tmp/ws', undefined, {
      model: 'main-model',
    });
    const onFast = buildAgentRuntimeSystemPrompt(settings, 'agent', '/tmp/ws', undefined, {
      model: 'fast-model',
    });
    expect(onPrimary).toContain('read_image');
    expect(onFast).not.toContain('read_image');
  });

  it('omits the app_render hint outside app mode', () => {
    const settings = makeRuntimeSettings();
    const prompt = buildAgentRuntimeSystemPrompt(settings, 'agent', '/tmp/ws');
    expect(prompt).not.toContain('app_render');
    expect(prompt).not.toContain('应用渲染');
  });

  it('includes the app_render hint in app mode', () => {
    const settings = makeRuntimeSettings();
    const prompt = buildAgentRuntimeSystemPrompt(settings, 'app', '/tmp/ws');
    expect(prompt).toContain('app_render');
  });

  it('omits mutating tool hints in read-only ask mode', () => {
    const settings = makeRuntimeSettings();
    const prompt = buildAgentRuntimeSystemPrompt(settings, 'ask', '/tmp/ws');
    expect(prompt).not.toContain('SEARCH/REPLACE');
    expect(prompt).not.toContain('git(action');
    expect(prompt).not.toContain('lsp_edit');
  });

  it('omits websearch/webfetch hints when MCP search is enabled', () => {
    const mcp = {
      enabled: true,
      exposeTools: true,
      servers: [{ enabled: true, category: 'search' }],
    } as unknown as McpSettings;
    const settings = makeRuntimeSettings({ mcp });
    const prompt = buildAgentRuntimeSystemPrompt(settings, 'agent', '/tmp/ws');
    expect(prompt).not.toContain('websearch');
    expect(prompt).not.toContain('webfetch');
  });

  it('keeps websearch/webfetch hints when MCP search is disabled', () => {
    const settings = makeRuntimeSettings();
    const prompt = buildAgentRuntimeSystemPrompt(settings, 'agent', '/tmp/ws');
    expect(prompt).toContain('websearch');
    expect(prompt).toContain('webfetch');
  });
});
