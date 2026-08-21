import { afterEach, describe, expect, it } from 'vitest';
import { buildAgentRuntimeSystemPrompt, buildAgentRuntimeUserPrompt, buildAgentSessionBootstrapPrompt } from './promptBuilders';
import { useCharactersStore } from '../charactersStore';
import { useAppRuntimeStore } from '../appRuntimeStore';
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
    useAppRuntimeStore.setState({
      apps: [],
      pinnedPluginIds: [],
    });
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

    const settings = makeSettings({ systemPrompt: 'CUSTOM_SYS_PROMPT_MARKER', experimentalCharacters: true });
    const bootstrap = buildAgentSessionBootstrapPrompt(settings, '/tmp/ws', [], 'some memory');

    expect(bootstrap).toContain('CUSTOM_SYS_PROMPT_MARKER');
    expect(bootstrap).toContain('UNIQUE_CHAR_DESCRIPTION_MARKER');
    expect(bootstrap).toContain('Work in the voice of');
    expect(bootstrap).toContain('## 角色人设');
  });

  it('omits the active character when experimental characters are disabled', () => {
    const character = makeCharacter();
    useCharactersStore.setState({
      characters: [character],
      activeCharacterId: character.id,
    });

    const settings = makeSettings({ experimentalCharacters: false });
    const bootstrap = buildAgentSessionBootstrapPrompt(settings, '/tmp/ws', [], 'some memory');

    expect(bootstrap).not.toContain('UNIQUE_CHAR_DESCRIPTION_MARKER');
    expect(bootstrap).not.toContain('## 角色人设');
  });

  it('omits the custom guidance section entirely when system prompt is empty', () => {
    const settings = makeSettings({ systemPrompt: '   ' });
    const bootstrap = buildAgentSessionBootstrapPrompt(settings, '/tmp/ws', [], 'some memory');
    expect(bootstrap).toContain('some memory');
    expect(bootstrap).not.toContain('长期附加指导');
  });

  it('injects enabled inbox plugins from the runtime store', () => {
    const canvasManifest = JSON.stringify({
      spec: 'papr/0.1',
      name: '架构画布',
      kind: 'plugin',
      inbox: { scene: { description: '整幅替换画布', example: { op: 'replace' } } },
    });
    const tickerManifest = JSON.stringify({ spec: 'papr/0.1', name: '股票', kind: 'plugin' });
    useAppRuntimeStore.setState({
      apps: [
        {
          appId: 'arch-canvas',
          title: '架构画布',
          html: '',
          filePath: 'x',
          createdAt: 1,
          updatedAt: 1,
          manifestJson: canvasManifest,
        },
        {
          appId: 'stock-ticker',
          title: '股票',
          html: '',
          filePath: 'y',
          createdAt: 1,
          updatedAt: 1,
          manifestJson: tickerManifest,
        },
      ],
      pinnedPluginIds: ['arch-canvas', 'stock-ticker'],
    });

    const bootstrap = buildAgentSessionBootstrapPrompt(makeSettings(), '/tmp/ws', []);
    expect(bootstrap).toContain('## 已启用插件');
    expect(bootstrap).toContain('arch-canvas');
    expect(bootstrap).toContain('scene：整幅替换画布');
    expect(bootstrap).not.toContain('stock-ticker');
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

  it('exposes read_image on primary when only the fast slot can see images', () => {
    const settings = makeRuntimeSettings({
      model: 'primary-model',
      fastModelEnabled: true,
      fastModel: 'fast-model',
      multimodalEnabled: false,
      modelProfiles: [
        {
          id: 'p-primary',
          name: 'primary',
          apiMode: 'custom',
          apiFormat: 'openai',
          baseURL: '',
          apiKey: '',
          model: 'primary-model',
          maxTokens: 8000,
          multimodalEnabled: false,
        },
        {
          id: 'p-fast',
          name: 'fast',
          apiMode: 'custom',
          apiFormat: 'openai',
          baseURL: '',
          apiKey: '',
          model: 'fast-model',
          maxTokens: 8000,
          multimodalEnabled: true,
        },
      ],
      primaryProfileId: 'p-primary',
      fastProfileId: 'p-fast',
    } as Partial<Settings>);
    const prompt = buildAgentRuntimeSystemPrompt(settings, 'agent', '/tmp/ws', undefined, {
      model: 'primary-model',
    });
    expect(prompt).toContain('read_image');
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

  it('lists custom agents from runtime definitions in the task catalog', () => {
    const prompt = buildAgentRuntimeSystemPrompt(
      makeRuntimeSettings(),
      'agent',
      '/tmp/ws',
      undefined,
      {
        agentDefinitions: [
          { name: 'explore', description: 'e', mode: 'subagent', prompt: 'p' },
          { name: 'reviewer', description: '代码审查', mode: 'subagent', prompt: 'p' },
          { name: 'hidden', description: 'h', mode: 'primary', prompt: 'p' },
        ],
      }
    );
    expect(prompt).toContain('reviewer — 代码审查');
    expect(prompt).not.toContain('hidden —');
  });
});

describe('buildAgentRuntimeUserPrompt', () => {
  afterEach(() => {
    useCharactersStore.setState({ characters: [], activeCharacterId: null });
  });

  it('appends post-history instructions to the user prompt tail', () => {
    const character = makeCharacter({
      postHistoryInstructions: 'Stay in character, {{char}}.',
    });
    useCharactersStore.setState({
      characters: [character],
      activeCharacterId: character.id,
    });
    const prompt = buildAgentRuntimeUserPrompt({
      settings: makeRuntimeSettings({ experimentalCharacters: true }),
      mode: 'agent',
      workspacePath: '/tmp/ws',
      input: 'fix the bug',
    });
    expect(prompt).toContain('## Post-History Instructions');
    expect(prompt).toContain('Stay in character, TestChar.');
    expect(prompt.indexOf('fix the bug')).toBeLessThan(prompt.indexOf('Post-History Instructions'));
  });

  it('omits post-history instructions when experimental characters are disabled', () => {
    const character = makeCharacter({
      postHistoryInstructions: 'Stay in character, {{char}}.',
    });
    useCharactersStore.setState({
      characters: [character],
      activeCharacterId: character.id,
    });
    const prompt = buildAgentRuntimeUserPrompt({
      settings: makeRuntimeSettings({ experimentalCharacters: false }),
      mode: 'agent',
      workspacePath: '/tmp/ws',
      input: 'fix the bug',
    });
    expect(prompt).not.toContain('Post-History Instructions');
    expect(prompt).not.toContain('Stay in character');
  });
});
