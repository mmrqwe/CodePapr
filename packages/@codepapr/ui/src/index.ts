/**
 * @codepapr/ui: React + Tauri UI 入口
 *
 * 注意: 这是一个轻量脚手架。
 * 完整的 Tauri 应用需要 Rust 工具链 + tauri-cli + Vite。
 * 此包导出 React 组件与 Tauri IPC 桥接 hooks。
 */

export { ChatPanel } from './components/ChatPanel';
export { SessionManager } from './components/SessionManager';
export { CacheStatsDashboard } from './components/CacheStatsDashboard';
export { CodingWorkbench } from './components/CodingWorkbench';
export { useAgent } from './hooks/useAgent';
