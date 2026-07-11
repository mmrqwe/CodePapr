/**
 * goalStore: Goal 自主循环的 UI 状态管理。
 *
 * 与 agentStore 正交：agentStore 驱动 Worker turn，
 * goalStore 管理 goal 外循环的可见状态（banner 显示、进度、停止）。
 */

import { create } from 'zustand';
import type { GoalRunnerState, GoalCondition } from '@codepapr/types';

export interface GoalStoreState {
  /** 当前 goal 是否激活 */
  isGoalActive: boolean;
  /** GoalRunner 的最新状态快照 */
  goalState: GoalRunnerState | null;
  /** 当前 goal 的验证条件（用于 banner 显示） */
  goalCondition: GoalCondition | null;
  /** 用户的自然语言目标 */
  userGoalText: string;
  /** 中断信号 */
  aborted: boolean;

  setGoalActive: (condition: GoalCondition, userGoalText: string) => void;
  setGoalState: (state: GoalRunnerState) => void;
  abortGoal: () => void;
  clearGoal: () => void;
  isAborted: () => boolean;
}

export const useGoalStore = create<GoalStoreState>((set, get) => ({
  isGoalActive: false,
  goalState: null,
  goalCondition: null,
  userGoalText: '',
  aborted: false,

  setGoalActive: (condition, userGoalText) =>
    set({
      isGoalActive: true,
      goalCondition: condition,
      userGoalText,
      goalState: null,
      aborted: false,
    }),

  setGoalState: (state) => set({ goalState: state }),

  abortGoal: () => set({ aborted: true }),

  clearGoal: () =>
    set({
      isGoalActive: false,
      goalState: null,
      goalCondition: null,
      userGoalText: '',
      aborted: false,
    }),

  isAborted: () => get().aborted,
}));
