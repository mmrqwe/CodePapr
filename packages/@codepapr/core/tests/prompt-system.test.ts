import { describe, expect, it } from 'vitest';
import {
  buildModeSystemPrompt,
  buildSkillsSection,
  buildSessionBootstrapPrompt,
  buildRuntimeSystemPrompt,
  buildRuntimeUserPrompt,
  buildStructuredUserPrompt,
  createDefaultUserPromptSections,
  ImmutablePrefix,
  parseStructuredUserPrompt,
  validateUserPrompt,
  type SkillDefinition,
} from '../src';

describe('promptSystem', () => {
  const skills: SkillDefinition[] = [
    {
      name: 'search',
      description: '搜索资料',
      prompt: '优先查官方文档。',
    },
    {
      name: 'release',
      description: '发布检查',
      prompt: '先检查构建产物。',
    },
  ];

  it('builds a stable runtime system prompt without per-turn diagnostics or skills', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      rulesSection: '## 项目规则\n- 先跑测试',
      toolNames: ['edit', 'graph', 'exec'],
    });

    expect(prompt).toContain('你是一名资深软件工程师');
    expect(prompt).toContain('## 项目规则');
    expect(prompt).toContain('你处于 Agent 模式');
    expect(prompt).not.toContain('项目 Skills');
    expect(prompt).not.toContain('项目诊断');
  });

  it('includes graph tool constraint when graph is in toolNames', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['graph'],
    });
    expect(prompt).toContain('graph');
    expect(prompt).toContain('先拿地图再行动');
  });

  it('includes bash constraint when present', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['bash'],
    });
    expect(prompt).toContain('bash');
    expect(prompt).toContain('background');
    expect(prompt).toContain('workdir');
  });

  it('lsp constraint does not mention diagnostics as lsp action', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['lsp'],
    });
    expect(prompt).toContain('lsp');
    expect(prompt).not.toContain('`diagnostics`');
  });

  it('includes diagnostics standalone constraint', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['diagnostics'],
    });
    expect(prompt).toContain('diagnostics');
    expect(prompt).toContain('lint/typecheck/build');
  });

  it('includes write/edit/patch parameter guidance', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['write', 'edit'],
    });
    expect(prompt).toContain('relativePath');
    expect(prompt).toContain('SEARCH/REPLACE');
    expect(prompt).toContain('项目记忆');
  });

  it('includes web_search constraint in ask mode', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'ask',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['websearch', 'webfetch'],
    });
    expect(prompt).toContain('websearch');
    expect(prompt).toContain('webfetch');
  });

  it('includes write constraint with project memory in agent mode', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['write'],
    });
    expect(prompt).toContain('项目记忆');
    expect(prompt).toContain('memory_write');
    expect(prompt).toContain('记忆账本');
    expect(prompt).not.toContain('常规发现');
  });

  it('does NOT include project memory in ask mode even with write tool', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'ask',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['write'],
    });
    expect(prompt).not.toContain('项目记忆');
  });

  it('includes question constraint only in plan mode', () => {
    const planPrompt = buildRuntimeSystemPrompt({
      mode: 'plan',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['question'],
    });
    expect(planPrompt).toContain('question');

    const agentPrompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['question'],
    });
    expect(agentPrompt).not.toContain('需求模糊时调用');
  });

  it('keeps the immutable prefix stable when only the custom guidance changes', () => {
    const systemPrompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      rulesSection: '## 项目规则\n- 先跑测试',
      toolNames: ['edit'],
    });
    const prefixA = new ImmutablePrefix({
      systemPrompt,
      tools: [],
      model: 'deepseek-v4-pro',
      parameters: { temperature: 0.7, topP: 0.9, maxTokens: 393_216, thinkingEnabled: true },
    });
    const prefixB = new ImmutablePrefix({
      systemPrompt,
      tools: [],
      model: 'deepseek-v4-pro',
      parameters: { temperature: 0.7, topP: 0.9, maxTokens: 393_216, thinkingEnabled: true },
    });

    const bootstrapA = buildSessionBootstrapPrompt({
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      skillsSection: buildSkillsSection(skills, 'zh-CN'),
      customPromptSection: '## 执行方式\n优先直接执行。',
    });
    const bootstrapB = buildSessionBootstrapPrompt({
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      skillsSection: buildSkillsSection(skills, 'zh-CN'),
      customPromptSection: '## 执行方式\n优先最小改动。',
    });
    const turnPrompt = buildRuntimeUserPrompt({
      mode: 'agent',
      input: '修复当前报错',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
    });

    expect(prefixA.computeHash()).toBe(prefixB.computeHash());
    expect(bootstrapA).not.toBe(bootstrapB);
    expect(bootstrapA).toContain('## 项目 Skills');
    expect(bootstrapA).toContain('`search`: 搜索资料');
    expect(bootstrapA).toContain('## 长期附加指导');
    expect(turnPrompt).not.toContain('## 项目文件夹');
  });

  it('keeps full skill content out of per-turn runtime prompts', () => {
    const prompt = buildRuntimeUserPrompt({
      mode: 'agent',
      input: '请搜索最新官方 docs',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
    });

    expect(prompt).not.toContain('项目 Skills');
    expect(prompt).not.toContain('优先查官方文档。');
  });

  it('keeps project overview and diagnostics out of per-turn prompts (agent fetches via tools)', () => {
    // Per-turn user messages sit at the request tail and never hit the prefix
    // cache; large project overviews/diagnostics there burn fresh tokens every
    // round. The agent uses graph / diagnostics tools on demand instead.
    for (const lang of ['zh-CN', 'zh-TW', 'en'] as const) {
      const prompt = buildRuntimeUserPrompt({
        mode: 'agent',
        input: '修复构建错误',
        workspacePath: '/tmp/project',
        lang,
      });
      expect(prompt).not.toContain('项目结构概览');
      expect(prompt).not.toContain('項目結構概覽');
      expect(prompt).not.toContain('Project Structure Overview');
      expect(prompt).not.toContain('项目诊断');
      expect(prompt).not.toContain('項目診斷');
      expect(prompt).not.toContain('Project Diagnostics');
    }
  });

  it('marks the injected todo digest as background-only state', () => {
    const digest = '[TodoList] 目标: 旧任务\n  ○ t1: 旧步骤 ← current';
    const zhPrompt = buildRuntimeUserPrompt({
      mode: 'agent',
      input: '讲个笑话',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      todoDigest: digest,
    });
    expect(zhPrompt).toContain('## 当前任务清单（背景进度，仅供了解；当前回合的行动以用户最新消息为准）');
    expect(zhPrompt).toContain(digest);

    const enPrompt = buildRuntimeUserPrompt({
      mode: 'agent',
      input: 'tell me a joke',
      workspacePath: '/tmp/project',
      lang: 'en',
      todoDigest: digest,
    });
    expect(enPrompt).toContain('## Current Task List (background progress, for awareness only');

    const noDigest = buildRuntimeUserPrompt({
      mode: 'agent',
      input: '讲个笑话',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
    });
    expect(noDigest).not.toContain('当前任务清单');
  });

  it('flags obviously dynamic user prompt content', () => {
    const result = validateUserPrompt('请在回答中加入 [TIMESTAMP] 和 ${env}');
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(2);
  });

  it('builds and parses structured user prompt sections', () => {
    const sections = createDefaultUserPromptSections('zh-CN');
    sections.appendix = '回答中优先给出验证命令。';

    const prompt = buildStructuredUserPrompt(sections, 'zh-CN');
    const parsed = parseStructuredUserPrompt(prompt);

    expect(prompt).toContain('## 执行方式');
    expect(prompt).toContain('## 补充约束');
    expect(parsed).toEqual(sections);
  });

  it('includes architect references when mentorEnabled is true', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['graph', 'lsp', 'task'],
      mentorEnabled: true,
    });
    expect(prompt).toContain('架构师');
    expect(prompt).toContain('必须先向架构师汇报');
    expect(prompt).toContain('如果架构师调用失败');
  });

  it('excludes architect references when mentorEnabled is false', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['graph', 'lsp', 'task'],
      mentorEnabled: false,
    });
    expect(prompt).not.toContain('架构师');
    expect(prompt).not.toContain('必须先向架构师汇报');
    expect(prompt).not.toContain('如果架构师调用失败');
  });

  it('excludes architect references by default when mentorEnabled is not specified', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['graph', 'lsp', 'task'],
    });
    expect(prompt).not.toContain('架构师');
  });

  it('includes read_image hint only when read_image is in toolNames', () => {
    const withTool = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['read', 'read_image'],
    });
    expect(withTool).toContain('[read_image]');

    const withoutTool = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['read'],
    });
    expect(withoutTool).not.toContain('read_image');
  });

  it('omits app_render section outside app mode even when app_render is in toolNames', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['read', 'app_render'],
    });
    expect(prompt).not.toContain('app_render');
    expect(prompt).not.toContain('应用渲染');
  });

  it('includes app_render section in app mode', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'app',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['app_render'],
    });
    expect(prompt).toContain('app_render');
    expect(prompt).toContain('应用渲染');
    expect(prompt).toContain('应用管理');
  });

  it('app mode workflow references real tool names, not hidden workspace_* internals', () => {
    for (const lang of ['zh-CN', 'zh-TW', 'en'] as const) {
      const prompt = buildRuntimeSystemPrompt({
        mode: 'app',
        workspacePath: '/tmp/project',
        lang,
        toolNames: ['read', 'list', 'grep', 'glob', 'app_render', 'app_list', 'app_start', 'app_stop', 'app_delete'],
      });
      expect(prompt).not.toContain('workspace_read_file');
      expect(prompt).not.toContain('workspace_write_file');
      expect(prompt).not.toContain('workspace_list_files');
      expect(prompt).not.toContain('workspace_search_text');
    }
  });

  it('app mode workflow teaches exploration with list/read/grep', () => {
    const zhCN = buildRuntimeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang: 'zh-CN' });
    expect(zhCN).toContain('探索数据：用 list');
    const zhTW = buildRuntimeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang: 'zh-TW' });
    expect(zhTW).toContain('探索資料：用 list');
    const en = buildRuntimeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang: 'en' });
    expect(en).toContain('Explore data: use list');
  });

  it('app mode examples include the required title parameter in all languages', () => {
    for (const lang of ['zh-CN', 'zh-TW', 'en'] as const) {
      const prompt = buildModeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang });
      expect(prompt).toContain('title: "AI Todo App"');
    }
  });

  it('app mode documents __PAPR_BACKEND_URL and CORS for backend apps in all languages', () => {
    for (const lang of ['zh-CN', 'zh-TW', 'en'] as const) {
      const prompt = buildModeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang });
      expect(prompt).toContain('__PAPR_BACKEND_URL');
      expect(prompt).toContain('Access-Control-Allow-Origin');
    }
  });

  it('app mode documents backend cwd as the app directory, not the workspace root', () => {
    for (const lang of ['zh-CN', 'zh-TW', 'en'] as const) {
      const prompt = buildModeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang });
      expect(prompt).toContain('.CodePapr/apps/<appId>/');
    }
    const en = buildModeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang: 'en' });
    expect(en).not.toMatch(/backend process runs in the workspace directory/i);
    const zhCN = buildModeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang: 'zh-CN' });
    expect(zhCN).not.toContain('后端进程运行在工作区目录下');
  });

  it('app mode mandates papr.db as default in-app persistence', () => {
    const zhCN = buildModeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang: 'zh-CN' });
    expect(zhCN).toContain('持久化默认用 papr.db');
    expect(zhCN).toContain('无需权限（app 自有沙箱');
    expect(zhCN).not.toContain('需要权限：storage');
    const en = buildModeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang: 'en' });
    expect(en).toContain('default in-app persistence');
    expect(en).toContain('No permission needed (app-owned sandbox');
    expect(en).not.toContain('Permissions: storage');
  });

  it('app mode warns about the network:false CSP hard block', () => {
    for (const lang of ['zh-CN', 'zh-TW', 'en'] as const) {
      const prompt = buildModeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang });
      expect(prompt).toContain('network:false');
      expect(prompt).toMatch(/CSP|Content-Security/i);
    }
  });

  it('app mode includes the high-quality-app methodology and self-check', () => {
    const zhCN = buildModeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang: 'zh-CN' });
    expect(zhCN).toContain('构建高质量 App');
    expect(zhCN).toContain('生成后自检');
    const zhTW = buildModeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang: 'zh-TW' });
    expect(zhTW).toContain('構建高品質 App');
    const en = buildModeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang: 'en' });
    expect(en).toContain('Building a High-Quality App');
    expect(en).toContain('Self-check');
  });

  it('app mode includes a project-data-exploration example', () => {
    for (const lang of ['zh-CN', 'zh-TW', 'en'] as const) {
      const prompt = buildModeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang });
      expect(prompt).toContain('readme-dashboard');
      expect(prompt).toContain('local: "read"');
    }
  });

  it('app mode mandates themed dual dark/light UI matching the CodePapr palette in all languages', () => {
    for (const lang of ['zh-CN', 'zh-TW', 'en'] as const) {
      const prompt = buildModeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang });
      expect(prompt).toContain('data-mode');
      expect(prompt).toContain('--bg');
      expect(prompt).not.toContain('prefers-color-scheme');
      expect(prompt).toContain('#0a0c12');
      expect(prompt).toContain('#f7f4ef');
      expect(prompt).toContain('#d9673e');
      expect(prompt).toContain('#6366f1');
    }
  });

  it('app mode documents papr.fs subdirectory auto-creation and agent-cannot-read-db', () => {
    const zhCN = buildModeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang: 'zh-CN' });
    expect(zhCN).toContain('自动创建子目录');
    expect(zhCN).toContain('Agent 读不到 papr.db');
    const en = buildModeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang: 'en' });
    expect(en).toContain('auto-creates subdirectories');
    expect(en).toContain('Agents cannot read papr.db');
  });

  it('app mode documents multi-file frontend, http.request, and fs encoding', () => {
    for (const lang of ['zh-CN', 'zh-TW', 'en'] as const) {
      const prompt = buildModeSystemPrompt({ mode: 'app', workspacePath: '/tmp/project', lang });
      expect(prompt).toContain('app.css');
      expect(prompt).toContain('app.js');
      expect(prompt).toContain('papr.http.request');
      expect(prompt).toContain('base64');
      expect(prompt).toContain('exists');
    }
  });

  it('all mode prompts pass the ImmutablePrefix static-content guard', () => {
    // 回归：app 模式后端示例曾含 `${API}` 模板字面量，命中缓存层的动态内容拦截，
    // 导致 app 模式直接报 "System prompt contains dynamic content" 无法使用。
    for (const mode of ['ask', 'plan', 'agent', 'app'] as const) {
      for (const lang of ['zh-CN', 'zh-TW', 'en'] as const) {
        const prompt = buildRuntimeSystemPrompt({ mode, workspacePath: '/tmp/project', lang });
        expect(
          () =>
            new ImmutablePrefix({
              systemPrompt: prompt,
              tools: [],
              model: 'test-model',
              parameters: { temperature: 0.7, topP: 0.9, maxTokens: 2000 },
            }),
          `mode=${mode} lang=${lang} 的系统提示词含动态内容`,
        ).not.toThrow();
      }
    }
  });

  it('suppresses mutating tool hints in ask mode', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'ask',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['read', 'write', 'edit', 'patch', 'git', 'lsp_edit'],
    });
    expect(prompt).not.toContain('SEARCH/REPLACE');
    expect(prompt).not.toContain('git(action');
    expect(prompt).not.toContain('lsp_edit');
  });
});
