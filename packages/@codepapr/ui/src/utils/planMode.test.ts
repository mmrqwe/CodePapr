import { describe, expect, it } from 'vitest';
import {
  buildDecisionOptionAction,
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

    expect(parsed.cards).toHaveLength(1);
    expect(parsed.cards[0]).toMatchObject({
      question: '你希望系统采用什么技术栈？',
      options: [
        { label: 'c#+ts+electron' },
        { label: 'rust+tauri' },
        { label: 'mac原生' },
        { label: '其它（请说明）' },
      ],
    });
    expect(parsed.cards[0]?.note).toContain('补充说明');
    expect(parsed.remainderContent).toContain('临时结论');
    expect(parsed.remainderContent).toContain('先确认关键前提');
  });

  it('falls back to plain content when no decision card is present', () => {
    const parsed = parseDecisionOptionCards('直接输出普通计划。');

    expect(parsed.cards).toEqual([]);
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

    expect(parsed.cards).toHaveLength(1);
    expect(parsed.cards[0]?.question).toBe('你希望系统采用什么技术栈？');
    expect(parsed.cards[0]?.options[0]).toMatchObject({
      label: 'c#+ts+electron',
      description: '现有团队栈一致',
    });
    expect(parsed.remainderContent).toContain('确认技术栈后再输出最终计划');
  });
});

describe('buildDecisionOptionAction', () => {
  it('keeps the flow inside plan mode after the user chooses an option', () => {
    const action = buildDecisionOptionAction({
      card: {
        id: 'decision-card-1',
        heading: '待确认选项 | 你希望系统采用什么技术栈？',
        question: '你希望系统采用什么技术栈？',
        options: [{ id: 'decision-1-option-1', label: 'rust+tauri' }],
      },
      option: {
        id: 'decision-1-option-1',
        label: 'rust+tauri',
      },
      lang: 'zh-CN',
    });

    expect(action).toMatchObject({
      mode: 'plan',
      label: '选择了「rust+tauri」',
    });
    expect(action.prompt).toContain('rust+tauri');
    expect(action.prompt).toContain('不要开始执行');
  });
});
