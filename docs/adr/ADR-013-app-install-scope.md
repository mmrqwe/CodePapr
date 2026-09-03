# ADR-013: Papr App / 插件的全局与项目双作用域

- 状态: Accepted
- 日期: 2026-09-03
- 关联: 宿主拆分见 [ADR-012](./ADR-012-host-client-split.md)

## 背景

Papr App（`.papr` 应用 / 插件）最初只能装进 `<workspace>/.CodePapr/apps/`。工具类应用（看板、图表、脚本面板）在每个仓库都要重装一次，而项目专属应用又必须跟着仓库走。单一作用域两头不讨好。

## 决策

**两个安装位置，工作区优先。**

| 作用域 | 目录 | 适合 |
|---|---|---|
| `global` | `~/.codepapr/apps/<appId>/` | 跨项目通用工具 |
| `workspace` | `<workspace>/.CodePapr/apps/<appId>/` | 项目专属、可随仓库分发 |

前端类型 `AppInstallScope = 'global' | 'workspace'`（`src/utils/marketAppTypes.ts`），安装时由用户选择，写盘走 Tauri 命令 `papr_install_app_files`（`src-tauri/src/app_market_install.rs`）。

### 发现与优先级

`scan_workspace_apps(workspace_path)`（`app_runtime_pt3.rs`）：

1. 先扫 `global_apps_dir()`，命中的写进 `app_id -> DiscoveredApp`，`scope: "global"`；
2. 再扫 `<workspace>/.CodePapr/apps`，同 `app_id` **覆盖**全局项，`scope: "workspace"`；
3. 按 `app_id` 排序返回。

一个目录要被认成 App，必须同时满足：目录名通过 `is_valid_app_id`、`manifest.json` 可解析、入口文件（`manifest.entry`，默认 `index.html`）存在。

运行时解析目录用 `codepapr_core::db::resolve_app_dir(workspace_path, app_id)`，同样是**工作区 manifest 优先、全局 manifest 次之**，都没有再落回退路径。因此同名 App 的前端、后端和存储始终落在同一个目录上，不会出现「前端读工作区、数据写全局」的错位。

### 每个 App 的数据面

- 键值存储：`<appDir>/db.sqlite`（`PAPR_APP_DB_FILE`），紧邻 `manifest.json`，所以作用域切换 = 数据切换；
- 因此 `db.sqlite` / `-wal` / `-shm` 以及任意 `.sqlite` 都被 `is_unservable_app_file` 挡在 `codepapr-app://` 之外；
- 快照与导出（`papr_snapshot_app` / `papr_export_app`）跳过 `node_modules`、`.versions`、`data`、`db.sqlite*`。

### 权限

两轴模型（`papr_runtime::permission`）：本地访问（`PaprLocalAccess`）× 网络（`bool`），全局默认 + 逐 App 覆盖，UI 在设置面板 App 页。manifest 里的 `permissions` 声明（`storage:read`、`storage:write`、`http:get`、`fs:read`、`fs:write`、`agent:run:<agent>`）由 `check_permission` 在每个 Tauri 命令入口校验。

网络轴还直接决定文档 CSP（`build_app_csp`）：关闭时 `connect-src` 只有 `'self'` 加自身后端端口，`form-action 'none'`，`script-src` 不放行 `https:`；打开后才追加 `https:/http:/wss:/ws:`。

### 注册表

官方应用注册表：`https://raw.githubusercontent.com/mmrqwe/codepapr-apps/main/registry.json`（`src/tools/marketAppApi.ts`），文件按 raw base 逐个下载后由 `papr_install_app_files` 落到所选作用域。

## 后果

- 同一个 appId 可以同时存在于两个作用域；工作区版本是「本仓库的覆盖」，卸载工作区版本后自动回落到全局版本。
- 每个 App 有独立 origin（`codepapr-app://<appId>/`），配合 CSP 做隔离。
- 代价：用户可能被同名双份搞混，UI 需要显式展示 `scope` 徽标（`DiscoveredApp.scope` 已下发）。
