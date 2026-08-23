import { describe, expect, it } from 'vitest';
import {
  buildQuestionAnswerAction,
  parseDecisionOptionCards,
} from './planMode';

describe('parseDecisionOptionCards', () => {
  it('parses decision cards with numbered options', () => {
    const parsed = parseDecisionOptionCards(`
先确认关键前提。

## 待确认选项 | 你希望系统采用什么技术栈？
1. c#+ts+electron
2. rust+tauri
3. mac原生
4. 其它（请说明）

补充说明：如果你不确定，我会后续给默认推荐。

## 临时结论
确认技术栈后再输出最终计划。
`);

    expect(parsed.questions).toHaveLength(1);
    expect(parsed.questions[0]).toMatchObject({
      question: '你希望系统采用什么技术栈？',
      options: [
        { label: 'c#+ts+electron' },
        { label: 'rust+tauri' },
        { label: 'mac原生' },
        { label: '其它（请说明）' },
      ],
    });
    expect(parsed.questions[0]?.note).toContain('补充说明');
    expect(parsed.remainderContent).toContain('临时结论');
    expect(parsed.remainderContent).toContain('先确认关键前提');
  });

  it('falls back to plain content when no decision card is present', () => {
    const parsed = parseDecisionOptionCards('直接输出普通计划。');

    expect(parsed.questions).toEqual([]);
    expect(parsed.remainderContent).toBe('直接输出普通计划。');
  });

  it('parses structured decisionCards json blocks', () => {
    const parsed = parseDecisionOptionCards(`\`\`\`json
{
  "decisionCards": [
    {
      "question": "你希望系统采用什么技术栈？",
      "options": [
        { "label": "c#+ts+electron", "description": "现有团队栈一致" },
        { "label": "rust+tauri" }
      ],
      "note": "如果你不确定，我会给默认推荐。"
    }
  ],
  "remainderContent": "确认技术栈后再输出最终计划。"
}
\`\`\``);

    expect(parsed.questions).toHaveLength(1);
    expect(parsed.questions[0]?.question).toBe('你希望系统采用什么技术栈？');
    expect(parsed.questions[0]?.options?.[0]).toMatchObject({
      label: 'c#+ts+electron',
      description: '现有团队栈一致',
    });
    expect(parsed.remainderContent).toContain('确认技术栈后再输出最终计划');
  });
});

describe('buildQuestionAnswerAction', () => {
  it('keeps the flow inside plan mode after the user chooses an option', () => {
    const action = buildQuestionAnswerAction({
      question: {
        question: '你希望系统采用什么技术栈？',
        header: '技术栈',
        options: [{ label: 'rust+tauri' }],
      },
      selected: [{ label: 'rust+tauri' }],
      lang: 'zh-CN',
    });

    expect(action).toMatchObject({
      mode: 'plan',
      label: '选择了「rust+tauri」',
    });
    expect(action.prompt).toContain('你希望系统采用什么技术栈？');
    expect(action.prompt).toContain('rust+tauri');
    expect(action.prompt).toContain('不要开始执行');
  });

  it('uses the full question text (not the truncated header) in the answer prompt', () => {
    const action = buildQuestionAnswerAction({
      question: {
        question: '你希望系统采用什么技术栈？React 还是 Vue，还是 Rust + Tauri？',
        header: '技术栈',
        options: [{ label: 'rust+tauri' }, { label: 'react+vite' }],
      },
      selected: [{ label: 'rust+tauri' }],
      lang: 'zh-CN',
    });

    expect(action.prompt).toContain('你希望系统采用什么技术栈？React 还是 Vue，还是 Rust + Tauri？');
    // 使用完整问题文本，而非旧的「header 截断」格式
    expect(action.prompt).not.toContain('对问题「技术栈」');
  });

  it('joins multiple selected options into a multi-select answer', () => {
    const action = buildQuestionAnswerAction({
      question: {
        question: '需要哪些模块？',
        header: '模块',
        multiple: true,
        options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      },
      selected: [{ label: 'A' }, { label: 'C' }],
      lang: 'zh-CN',
    });

    expect(action.prompt).toContain('选择了「A、C」');
    expect(action.label).toBe('选择了「A、C」');
  });

  it('supports en prompts', () => {
    const action = buildQuestionAnswerAction({
      question: {
        question: 'Which stack?',
        header: 'Stack',
        options: [{ label: 'Rust' }],
      },
      selected: [{ label: 'Rust' }],
      lang: 'en',
    });

    expect(action.prompt).toContain('Which stack?');
    expect(action.prompt).toContain('Do not start execution');
  });

  it('supports zh-TW prompts', () => {
    const action = buildQuestionAnswerAction({
      question: {
        question: '你希望系統採用什麼技術棧？',
        header: '技術棧',
        options: [{ label: 'rust+tauri' }],
      },
      selected: [{ label: 'rust+tauri' }],
      lang: 'zh-TW',
    });

    expect(action.prompt).toContain('你希望系統採用什麼技術棧？');
    expect(action.prompt).toContain('不要開始執行');
  });

  it('carries the source message id for answered-state marking', () => {
    const action = buildQuestionAnswerAction({
      question: {
        question: 'Proceed?',
        header: 'Confirm',
        options: [{ label: 'Yes' }],
      },
      selected: [{ label: 'Yes' }],
      lang: 'en',
      sourceMessageId: 'msg-42',
    });

    expect(action.sourceMessageId).toBe('msg-42');
  });

  it('supports custom text answers when user inputs custom thoughts', () => {
    const action = buildQuestionAnswerAction({
      question: {
        question: '你希望系统采用什么技术栈？',
        header: '技术栈',
        options: [{ label: 'rust+tauri' }, { label: 'react+vite' }],
      },
      customText: '我想要使用 SvelteKit + Electron',
      lang: 'zh-CN',
    });

    expect(action.label).toBe('自定义回答：「我想要使用 SvelteKit + Electron」');
    expect(action.prompt).toContain('用户对问题「你希望系统采用什么技术栈？」的自定义回答：「我想要使用 SvelteKit + Electron」');
    expect(action.prompt).toContain('不要开始执行');
  });

  it('supports selected options combined with custom note/thoughts', () => {
    const action = buildQuestionAnswerAction({
      question: {
        question: '需要哪些功能？',
        header: '功能',
        options: [{ label: '暗黑模式' }, { label: '国际化' }],
      },
      selected: [{ label: '暗黑模式' }],
      customText: '另外需要支持自定义主题色',
      lang: 'zh-CN',
    });

    expect(action.label).toContain('选择了「暗黑模式」，补充：「另外需要支持自定义主题色」');
    expect(action.prompt).toContain('选择了「暗黑模式」，并补充了想法：「另外需要支持自定义主题色」');
    expect(action.prompt).toContain('不要开始执行');
  });

  it('supports custom text answers in en and zh-TW', () => {
    const actionEn = buildQuestionAnswerAction({
      question: { question: 'Which DB?', header: 'DB' },
      customText: 'Use PostgreSQL with Prisma',
      lang: 'en',
    });
    expect(actionEn.label).toBe('Custom answer: "Use PostgreSQL with Prisma"');
    expect(actionEn.prompt).toContain('Custom answer to question "Which DB?": "Use PostgreSQL with Prisma"');

    const actionTw = buildQuestionAnswerAction({
      question: { question: '資料庫選擇？', header: 'DB' },
      customText: '使用 SQLite 即可',
      lang: 'zh-TW',
    });
    expect(actionTw.label).toBe('自訂回答：「使用 SQLite 即可」');
    expect(actionTw.prompt).toContain('用戶對問題「資料庫選擇？」的自訂回答：「使用 SQLite 即可」');
  });
});
