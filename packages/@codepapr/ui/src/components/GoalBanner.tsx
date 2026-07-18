/**
 * GoalBanner: Goal 自主循环运行时的顶部常驻状态条。
 *
 * 显示：goal 条件、当前轮次、Verifier 判定、累计 token/耗时、停止按钮。
 * 仅在 isGoalActive 时渲染。
 */

import { useState, useEffect } from 'react';
import { useGoalStore } from '../store/goalStore';
import { useAgentStore } from '../store/agentStore';
import './GoalBanner.css';

export function GoalBanner() {
  const { isGoalActive, goalState, goalCondition, userGoalText } = useGoalStore();
  const abortGoal = useGoalStore((s) => s.abortGoal);
  const settings = useAgentStore((s) => s.settings);
  const lang = settings.lang ?? 'zh-CN';
  const [liveMs, setLiveMs] = useState(0);

  useEffect(() => {
    if (!goalState || goalState.status !== 'running') return;
    const timer = setInterval(() => {
      setLiveMs(Date.now() - goalState.startedAt);
    }, 1000);
    return () => clearInterval(timer);
  }, [goalState?.status, goalState?.startedAt]);

  if (!isGoalActive || !goalState) return null;

  const statusColors: Record<string, string> = {
    running: 'goal-banner--running',
    satisfied: 'goal-banner--satisfied',
    limit_exceeded: 'goal-banner--limit',
    interrupted: 'goal-banner--interrupted',
    error: 'goal-banner--error',
  };

  const statusText: Record<string, string> = {
    running: lang === 'en' ? 'Running' : lang === 'zh-TW' ? '執行中' : '运行中',
    satisfied: lang === 'en' ? 'Satisfied' : lang === 'zh-TW' ? '已達成' : '已达成',
    limit_exceeded:
      lang === 'en'
        ? 'Limit Exceeded'
        : lang === 'zh-TW'
          ? '超過限制'
          : '超过限制',
    interrupted:
      lang === 'en' ? 'Interrupted' : lang === 'zh-TW' ? '已中斷' : '已中断',
    error: lang === 'en' ? 'Error' : 'Error',
  };

  const displayMs = goalState.status === 'running' ? liveMs : goalState.elapsedMs;
  const elapsedSec = Math.round(displayMs / 1000);
  const elapsedDisplay =
    elapsedSec >= 60
      ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
      : `${elapsedSec}s`;

  const verdictDisplay = goalState.lastVerdict
    ? goalState.lastVerdict.verdict === 'SATISFIED'
      ? '✓'
      : goalState.lastVerdict.verdict === 'NOT_MET'
        ? '✗'
        : '?'
    : '—';

  const conditionDisplay = goalCondition?.humanReadable ?? userGoalText ?? '';

  return (
    <div className={`goal-banner ${statusColors[goalState.status] ?? ''}`}>
      <div className="goal-banner__main">
        <span className="goal-banner__icon" title={statusText[goalState.status]}>
          {goalState.status === 'running' ? '🎯' : statusText[goalState.status]}
        </span>
        <div className="goal-banner__info">
          <div className="goal-banner__condition" title={conditionDisplay}>
            {conditionDisplay}
          </div>
          <div className="goal-banner__meta">
            <span className="goal-banner__stat">
              {lang === 'en' ? 'Iteration' : lang === 'zh-TW' ? '第' : '第'}{' '}
              {goalState.iteration}
              {lang === 'en' ? '' : lang === 'zh-TW' ? '輪' : '轮'}
            </span>
            <span className="goal-banner__sep">·</span>
            <span className="goal-banner__stat">
              Verifier: {verdictDisplay}
            </span>
            <span className="goal-banner__sep">·</span>
            <span className="goal-banner__stat">{elapsedDisplay}</span>
            {goalState.totalOutputTokens > 0 && (
              <>
                <span className="goal-banner__sep">·</span>
                <span className="goal-banner__stat">
                  {(goalState.totalOutputTokens / 1000).toFixed(1)}k tokens
                </span>
              </>
            )}
          </div>
        </div>
      </div>
      {goalState.status === 'running' && (
        <button
          className="goal-banner__stop"
          onClick={abortGoal}
          title={lang === 'en' ? 'Stop' : lang === 'zh-TW' ? '停止' : '停止'}
        >
          {lang === 'en' ? 'Stop' : lang === 'zh-TW' ? '停止' : '停止'}
        </button>
      )}
    </div>
  );
}
