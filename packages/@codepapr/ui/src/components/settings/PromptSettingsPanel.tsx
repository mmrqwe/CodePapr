import { useEffect, useMemo, useState } from 'react';
import {
  buildSessionBootstrapPrompt,
  buildRuntimeUserPrompt,
  buildStructuredUserPrompt,
  createDefaultUserPromptSections,
  parseStructuredUserPrompt,
  validateUserPrompt,
  type PromptMode,
  type UserPromptSectionKey,
  type UserPromptSections,
} from '../../../../core/src/agent/promptSystem';
import type { Lang } from '../../utils/i18n';

const SECTION_KEYS: UserPromptSectionKey[] = [
  'execution',
  'change',
  'validation',
  'risk',
  'response',
  'appendix',
];

interface PromptSettingsPanelProps {
  lang: Lang;
  value: string;
  workspacePath: string;
  onChange: (value: string) => void;
}

interface PromptSectionCopy {
  title: string;
  description: string;
  tip: string;
}

interface PromptPanelCopy {
  title: string;
  subtitle: string;
  savedStateStructured: string;
  savedStateTemplate: string;
  savedStateLegacy: string;
  resetAll: string;
  clearAll: string;
  resetSection: string;
  editLabel: string;
  generatedPreview: string;
  runtimePreview: string;
  runtimePreviewTip: string;
  runtimePreviewNote: string;
  runtimePreviewInput: string;
  validationWarning: string;
  previewPlaceholder: string;
  saveHint: string;
  ask: string;
  plan: string;
  agent: string;
  sections: Record<UserPromptSectionKey, PromptSectionCopy>;
}

function toPromptLang(lang: Lang): 'zh-CN' | 'zh-TW' | 'en' {
  return lang === 'en' || lang === 'zh-TW' ? lang : 'zh-CN';
}

function getPanelCopy(lang: Lang): PromptPanelCopy {
  if (lang === 'en') {
    return {
      title: 'Prompt System Configuration',
      subtitle:
        'Edit the real long-lived custom guidance sections that are appended to the runtime user prompt. Each section maps directly to the saved custom-prompt layer.',
      savedStateStructured: 'The current saved prompt already uses the structured format below.',
      savedStateTemplate:
        'No saved custom prompt yet. The sections below are recommended defaults and will take effect only after you save.',
      savedStateLegacy:
        'A legacy free-form prompt was detected. It has been imported into "Additional Constraints" so you can migrate it into the structured system before saving.',
      resetAll: 'Reset All',
      clearAll: 'Clear All',
      resetSection: 'Reset',
      editLabel: 'Injected text for this section',
      generatedPreview: 'Custom Guidance Preview',
      runtimePreview: 'Session + Turn Prompt Preview',
      runtimePreviewTip: 'Preview the actual request-side layering: stable session bootstrap first, then the per-turn user prompt.',
      runtimePreviewNote:
        'This preview shows the post-system layering. The immutable system core, project rules, and tool constraints stay in the stable prefix, while this saved guidance moves into the session bootstrap instead of repeating every turn.',
      runtimePreviewInput: 'Example task: fix the current build failure and verify the result.',
      validationWarning: 'Potentially unstable dynamic content detected',
      previewPlaceholder: 'No custom guidance will be appended if all sections are empty.',
      saveHint: 'The preview below is the draft that will be used after you save settings.',
      ask: 'Ask',
      plan: 'Plan',
      agent: 'Agent',
      sections: {
        execution: {
          title: 'Execution Style',
          description: 'How the agent should move when the task is actionable.',
          tip: 'Prefer direct execution for fix/implement/modify tasks instead of re-discussing the request.',
        },
        change: {
          title: 'Change Strategy',
          description: 'How aggressively the agent should modify existing code.',
          tip: 'Use this to control minimal-diff bias, refactor appetite, and behavior preservation.',
        },
        validation: {
          title: 'Validation Requirements',
          description: 'What verification standard should be enforced before the work is considered done.',
          tip: 'Use this to define when tests, builds, or publish checks must run and how failures should be reported.',
        },
        risk: {
          title: 'Risk And Compatibility',
          description: 'How strongly the agent should protect compatibility and regression safety.',
          tip: 'Use this section to express rollback, compatibility, and release-safety expectations.',
        },
        response: {
          title: 'Response Style',
          description: 'How the final answer should be written for the user.',
          tip: 'Use this to shape concision, structure, and what must be called out in summaries.',
        },
        appendix: {
          title: 'Additional Constraints',
          description: 'Optional leftover project or team constraints that do not fit the fixed sections above.',
          tip: 'Use sparingly. Prefer the named sections above whenever possible.',
        },
      },
    };
  }

  if (lang === 'zh-TW') {
    return {
      title: '提示詞體系配置',
      subtitle: '直接編輯會附加到運行時 user prompt 的真實長期自定義指導層。下面每個分區都對應保存提示詞的一段。',
      savedStateStructured: '當前已保存的提示詞已經是下面這種結構化格式。',
      savedStateTemplate: '目前還沒有已保存的自定義提示詞。下面顯示的是推薦默認模板，只有保存後才會真正生效。',
      savedStateLegacy:
        '檢測到舊版自由文本提示詞。它已被導入到「補充約束」區，方便你在保存前遷移到結構化體系。',
      resetAll: '全部重置',
      clearAll: '全部清空',
      resetSection: '重置',
      editLabel: '本分區實際注入文本',
      generatedPreview: '自定義指導層預覽',
      runtimePreview: '會話 + 當前輪提示預覽',
      runtimePreviewTip: '預覽真實請求分層：前面是穩定會話 bootstrap，後面才是本輪 user prompt。',
      runtimePreviewNote:
        '這裡展示的是 system 之後的分層；不可變的系統核心、項目規則與工具約束仍保留在穩定前綴裡，而這些長期指導會移入會話 bootstrap，不再每輪重複。',
      runtimePreviewInput: '示例任務：修復當前構建失敗並驗證結果。',
      validationWarning: '檢測到可能導致提示詞不穩定的動態內容',
      previewPlaceholder: '如果所有分區都為空，則不會附加任何自定義指導層。',
      saveHint: '下面預覽的是本次編輯後、保存後將生效的內容。',
      ask: 'Ask',
      plan: 'Plan',
      agent: 'Agent',
      sections: {
        execution: {
          title: '執行方式',
          description: '需求已明確時，Agent 應該如何推進。',
          tip: '控制修復、實現、修改任務是直接執行，還是先停在討論層。',
        },
        change: {
          title: '修改策略',
          description: 'Agent 修改現有代碼時的保守程度與範圍控制。',
          tip: '適合約束最小改動、重構範圍、結構保持與行為穩定性。',
        },
        validation: {
          title: '驗證要求',
          description: '在什麼驗證標準下，任務才算真正完成。',
          tip: '適合規定測試、構建、發布檢查是否必跑，以及失敗時怎麼交代。',
        },
        risk: {
          title: '風險與兼容性',
          description: 'Agent 面對回歸風險、向後兼容與發布安全時的偏好。',
          tip: '適合寫回退安全、兼容策略和高風險改動時的交付要求。',
        },
        response: {
          title: '輸出風格',
          description: 'Agent 最終對用戶的回答應該怎麼表達。',
          tip: '適合約束簡潔度、結果總結格式、風險說明與驗證呈現方式。',
        },
        appendix: {
          title: '補充約束',
          description: '放不進前面固定分區，但仍需長期生效的少量附加規則。',
          tip: '盡量優先使用前面的命名分區，這裡只放確實無法歸類的內容。',
        },
      },
    };
  }

  return {
    title: '提示词体系配置',
    subtitle: '直接编辑会附加到运行时 user prompt 的真实长期自定义指导层。下面每个分区都对应保存提示词的一段。',
    savedStateStructured: '当前已保存的提示词已经是下面这种结构化格式。',
    savedStateTemplate: '目前还没有已保存的自定义提示词。下面显示的是推荐默认模板，只有保存后才会真正生效。',
    savedStateLegacy:
      '检测到旧版自由文本提示词。它已被导入到“补充约束”区，方便你在保存前迁移到结构化体系。',
    resetAll: '全部重置',
    clearAll: '全部清空',
    resetSection: '重置',
    editLabel: '本分区实际注入文本',
    generatedPreview: '自定义指导层预览',
    runtimePreview: '会话 + 当前轮提示预览',
    runtimePreviewTip: '预览真实请求分层：前面是稳定会话 bootstrap，后面才是本轮 user prompt。',
    runtimePreviewNote:
      '这里展示的是 system 之后的分层；不可变的系统核心、项目规则与工具约束仍保留在稳定前缀里，而这些长期指导会移入会话 bootstrap，不再每轮重复。',
    runtimePreviewInput: '示例任务：修复当前构建失败并验证结果。',
    validationWarning: '检测到可能导致提示词不稳定的动态内容',
    previewPlaceholder: '如果所有分区都为空，则不会附加任何自定义指导层。',
    saveHint: '下面预览的是本次编辑后、保存后将生效的内容。',
    ask: 'Ask',
    plan: 'Plan',
    agent: 'Agent',
    sections: {
      execution: {
        title: '执行方式',
        description: '需求已明确时，Agent 应该如何推进。',
        tip: '控制修复、实现、修改任务是直接执行，还是先停在讨论层。',
      },
      change: {
        title: '修改策略',
        description: 'Agent 修改现有代码时的保守程度与范围控制。',
        tip: '适合约束最小改动、重构范围、结构保持与行为稳定性。',
      },
      validation: {
        title: '验证要求',
        description: '在什么验证标准下，任务才算真正完成。',
        tip: '适合规定测试、构建、发布检查是否必跑，以及失败时怎么交代。',
      },
      risk: {
        title: '风险与兼容性',
        description: 'Agent 面对回归风险、向后兼容与发布安全时的偏好。',
        tip: '适合写回退安全、兼容策略和高风险改动时的交付要求。',
      },
      response: {
        title: '输出风格',
        description: 'Agent 最终对用户的回答应该怎么表达。',
        tip: '适合约束简洁度、结果总结格式、风险说明与验证呈现方式。',
      },
      appendix: {
        title: '补充约束',
        description: '放不进前面固定分区，但仍需长期生效的少量附加规则。',
        tip: '尽量优先使用前面的命名分区，这里只放确实无法归类的内容。',
      },
    },
  };
}

function getEditableSections(value: string, lang: Lang): {
  sections: UserPromptSections;
  state: 'structured' | 'template' | 'legacy';
} {
  const parsed = parseStructuredUserPrompt(value);
  if (parsed) {
    return { sections: parsed, state: 'structured' };
  }

  const defaults = createDefaultUserPromptSections(toPromptLang(lang));
  if (!value.trim()) {
    return { sections: defaults, state: 'template' };
  }

  return {
    sections: {
      ...defaults,
      appendix: value.trim(),
    },
    state: 'legacy',
  };
}

export function PromptSettingsPanel(props: PromptSettingsPanelProps) {
  const promptLang = toPromptLang(props.lang);
  const copy = getPanelCopy(props.lang);
  const initialState = useMemo(() => getEditableSections(props.value, props.lang), [props.value, props.lang]);
  const [sections, setSections] = useState<UserPromptSections>(initialState.sections);
  const [previewMode, setPreviewMode] = useState<PromptMode>('agent');

  useEffect(() => {
    setSections(initialState.sections);
  }, [initialState]);

  const generatedPrompt = useMemo(
    () => buildStructuredUserPrompt(sections, promptLang),
    [promptLang, sections]
  );
  const runtimePreview = useMemo(
    () => {
      const sessionBootstrap = buildSessionBootstrapPrompt({
        workspacePath: props.workspacePath,
        lang: promptLang,
        customPromptSection: generatedPrompt,
      });
      const turnPrompt = buildRuntimeUserPrompt({
        mode: previewMode,
        input: copy.runtimePreviewInput,
        workspacePath: props.workspacePath,
        lang: promptLang,
      });

      return [sessionBootstrap, turnPrompt].filter(Boolean).join('\n\n');
    },
    [copy.runtimePreviewInput, generatedPrompt, previewMode, promptLang, props.workspacePath]
  );
  const validation = validateUserPrompt(generatedPrompt);

  const applySections = (next: UserPromptSections) => {
    setSections(next);
    props.onChange(buildStructuredUserPrompt(next, promptLang));
  };

  const resetSection = (key: UserPromptSectionKey) => {
    const defaults = createDefaultUserPromptSections(promptLang);
    applySections({ ...sections, [key]: defaults[key] });
  };

  const resetAll = () => {
    applySections(createDefaultUserPromptSections(promptLang));
  };

  const clearAll = () => {
    applySections({
      execution: '',
      change: '',
      validation: '',
      risk: '',
      response: '',
      appendix: '',
    });
  };

  const stateMessage =
    initialState.state === 'structured'
      ? copy.savedStateStructured
      : initialState.state === 'legacy'
      ? copy.savedStateLegacy
      : copy.savedStateTemplate;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4">
        <div className="text-sm font-semibold text-slate-100">{copy.title}</div>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">{copy.subtitle}</p>
        <div className="mt-3 rounded-xl border border-[#252938] bg-[#0f1117] px-4 py-3 text-xs leading-relaxed text-slate-300">
          {stateMessage}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={resetAll}
            title={copy.savedStateTemplate}
            className="rounded-lg border border-[#2a2d3a] px-3 py-1.5 text-xs text-slate-200 transition-colors hover:border-indigo-400/60 hover:text-indigo-200"
          >
            {copy.resetAll}
          </button>
          <button
            type="button"
            onClick={clearAll}
            title={copy.previewPlaceholder}
            className="rounded-lg border border-[#2a2d3a] px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-rose-400/60 hover:text-rose-200"
          >
            {copy.clearAll}
          </button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {SECTION_KEYS.map((key) => {
          const section = copy.sections[key];
          return (
            <div key={key} className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-100">{section.title}</div>
                  <p className="mt-1 text-xs leading-relaxed text-slate-400">{section.description}</p>
                </div>
                <button
                  type="button"
                  onClick={() => resetSection(key)}
                  title={section.tip}
                  className="rounded-lg border border-[#2a2d3a] px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-indigo-400/60 hover:text-indigo-200"
                >
                  {copy.resetSection}
                </button>
              </div>
              <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                {copy.editLabel}
              </label>
              <textarea
                value={sections[key]}
                onChange={(event) => applySections({ ...sections, [key]: event.target.value })}
                rows={key === 'appendix' ? 5 : 4}
                title={section.tip}
                className="mt-2 w-full resize-none rounded-xl border border-[#2a2d3a] bg-[#0b0d12] px-3 py-3 font-mono text-xs leading-relaxed text-slate-200 placeholder-slate-700 focus:border-indigo-500/60 focus:outline-none"
              />
            </div>
          );
        })}
      </div>

      {generatedPrompt && !validation.valid && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <div className="font-medium">{copy.validationWarning}</div>
          <div className="mt-1">{validation.issues.join('；')}</div>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[0.92fr_1.08fr]">
        <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4">
          <div className="text-sm font-semibold text-slate-100">{copy.generatedPreview}</div>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">{copy.saveHint}</p>
          <pre className="mt-3 min-h-[260px] overflow-auto whitespace-pre-wrap rounded-xl bg-[#0b0d12] px-4 py-4 font-mono text-[11px] leading-relaxed text-slate-300">
            {generatedPrompt || copy.previewPlaceholder}
          </pre>
        </div>

        <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-100">{copy.runtimePreview}</div>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">{copy.runtimePreviewNote}</p>
            </div>
            <div className="flex rounded-xl border border-[#2a2d3a] bg-[#0f1117] p-1" title={copy.runtimePreviewTip}>
              {([
                ['ask', copy.ask],
                ['plan', copy.plan],
                ['agent', copy.agent],
              ] as Array<[PromptMode, string]>).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setPreviewMode(mode)}
                  className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
                    previewMode === mode
                      ? 'bg-[#2b3150] text-slate-100'
                      : 'text-slate-400 hover:bg-[#202434] hover:text-slate-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <pre className="mt-3 min-h-[260px] overflow-auto whitespace-pre-wrap rounded-xl bg-[#0b0d12] px-4 py-4 font-mono text-[11px] leading-relaxed text-slate-300">
            {runtimePreview}
          </pre>
        </div>
      </div>
    </div>
  );
}
