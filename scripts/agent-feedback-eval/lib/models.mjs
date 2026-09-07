#!/usr/bin/env node
/**
 * L2/L3 评估的模型清单来源：桌面 ui.settings（sqlite）。
 *
 * 与 agent-tool-smoke 的 readStoredSettings 同源：真实 key 通常只存在
 * modelProfiles 子配置里。评估要求"全模型"覆盖（用户拍板），所以默认
 * 取所有"有 key 且 (model,apiFormat) 去重"的 profile。
 * 绝不打印/落盘 apiKey —— 结果 JSON 只记录 profile id 与 model 名。
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const APP_DB_PATH = path.join(os.homedir(), '.codepapr', 'codepapr.sqlite');

export function loadEvalModels({ all = true } = {}) {
  const raw = execFileSync(
    'sqlite3',
    [APP_DB_PATH, "select value from settings where key='ui.settings';"],
    { encoding: 'utf8' }
  ).trim();
  if (!raw) throw new Error(`未在 ${APP_DB_PATH} 找到 ui.settings`);
  const settings = JSON.parse(raw);
  const candidates = [];
  for (const profile of settings.modelProfiles ?? []) {
    const apiKey = String(profile.apiKey ?? '').trim();
    if (!apiKey) continue;
    const model = String(profile.model ?? '').trim();
    if (!model) continue;
    const format = String(profile.apiFormat ?? 'openai');
    const provider = format === 'claude' ? 'claude' : format === 'response' ? 'response' : 'openai';
    candidates.push({
      id: profile.id ?? `profile-${candidates.length}`,
      label: `${provider}/${model}`,
      provider,
      model,
      apiKey,
      baseUrl: String(profile.baseURL ?? '').trim(),
      // 评估统一低温度，保证跨轮次可比的收敛行为
      temperature: 0.2,
    });
  }
  const seen = new Set();
  const deduped = candidates.filter((m) => {
    const key = `${m.provider}|${m.model}|${m.baseUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!deduped.length) throw new Error('modelProfiles 中没有任何带 apiKey 的模型，无法跑真实模型评估');
  return all ? deduped : deduped.slice(0, 1);
}

/** 脱敏：结果 JSON / 日志里出现凭据时的兜底。 */
export function redact(text, models) {
  let out = String(text ?? '');
  for (const m of models) {
    if (m.apiKey) out = out.split(m.apiKey).join('<redacted>');
  }
  return out;
}
