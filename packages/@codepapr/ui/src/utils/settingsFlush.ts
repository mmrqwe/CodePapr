import { listen } from '@tauri-apps/api/event';
import { flushAppSettingsSaves, queueAppSettingsSave } from './appSettingsStorage';
import { useAgentStore } from '../store/agentStore';
import { flushCharactersState } from '../store/charactersStore';

// 退出前的最后持久化保障：Rust 在 CloseRequested 时发出
// "codepapr:flush-settings" 事件并等待设置保存完成，这里负责：
// 1) 等待队列中在途的设置保存落库；
// 2) 用 store 当前最新状态再保存一次（覆盖"保存消息尚未发出就退出"的窗口）；
// 3) 等待角色卡保存链落库。
// 该监听在 App 挂载时注册，整个生命周期只需一次。
let registered = false;

export function registerSettingsFlushListener(): void {
  if (registered) return;
  registered = true;
  void listen('codepapr:flush-settings', () => {
    void (async () => {
      try {
        await flushAppSettingsSaves();
        const state = useAgentStore.getState();
        if (state.settingsLoaded && state._settingsPersistable) {
          await queueAppSettingsSave(state.settings);
        }
      } catch {
        // 设置保存失败由调用方提示；退出流程有超时兜底，绝不阻塞关闭。
      }
      await flushCharactersState().catch(() => undefined);
    })();
  });
}
