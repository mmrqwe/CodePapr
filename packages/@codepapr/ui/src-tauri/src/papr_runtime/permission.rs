use crate::papr_runtime::manifest::PaprManifest;

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

static APP_SETTINGS: OnceLock<Mutex<AppPermissionSettings>> = OnceLock::new();

fn app_settings() -> &'static Mutex<AppPermissionSettings> {
    APP_SETTINGS.get_or_init(|| {
        let persisted = crate::db::papr_load_permission_settings()
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str::<AppPermissionSettings>(&json).ok());
        Mutex::new(persisted.unwrap_or_default())
    })
}

fn persist_settings(settings: &AppPermissionSettings) {
    // 测试构建绝不写真实用户 DB：permission 测试会设置各种 app_overrides
    //（含 "test-app"），持久化后 APP_SETTINGS 的 OnceLock 在下次运行时从
    // DB 重新读到这些测试残留，导致真实 app 的权限被测试数据污染（曾使
    // services 的 "test-app" 用例在后续运行中永久失败）。
    #[cfg(not(test))]
    if let Ok(json) = serde_json::to_string(settings) {
        let _ = crate::db::papr_save_permission_settings(&json);
    }
    #[cfg(test)]
    let _ = settings;
}

#[cfg(test)]
fn reset_test_settings() {
    let default = AppPermissionSettings::default();
    persist_settings(&default);
    if let Some(guard) = APP_SETTINGS.get() {
        *guard.lock().unwrap_or_else(|e| e.into_inner()) = default;
    }
}

/// 本地（工作区）访问轴：none / read / write。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PaprLocalAccess {
    None,
    Read,
    Write,
}

/// 两轴权限：local × network。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaprAccess {
    pub local: PaprLocalAccess,
    pub network: bool,
}

impl PaprAccess {
    pub const NONE: Self = Self { local: PaprLocalAccess::None, network: false };
}

/// 旧四档等级 → 两轴映射（迁移用）：
/// L0 → 无本地、无网络；L1 → 只读、无网络；L2 → 只读+网络；L3 → 读写执行+网络。
pub fn legacy_level_to_access(level: u8) -> PaprAccess {
    match level.min(3) {
        0 => PaprAccess::NONE,
        1 => PaprAccess { local: PaprLocalAccess::Read, network: false },
        2 => PaprAccess { local: PaprLocalAccess::Read, network: true },
        _ => PaprAccess { local: PaprLocalAccess::Write, network: true },
    }
}

/// 两轴取交集（用户覆盖只能收窄，不能放大）。
pub fn intersect_access(a: PaprAccess, b: PaprAccess) -> PaprAccess {
    let rank = |l: PaprLocalAccess| match l {
        PaprLocalAccess::None => 0,
        PaprLocalAccess::Read => 1,
        PaprLocalAccess::Write => 2,
    };
    let local = if rank(a.local) < rank(b.local) { a.local } else { b.local };
    PaprAccess { local, network: a.network && b.network }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPermissionSettings {
    pub default_local: PaprLocalAccess,
    pub default_network: bool,
    pub app_overrides: HashMap<String, PaprAccess>,
}

impl Default for AppPermissionSettings {
    fn default() -> Self {
        Self {
            default_local: PaprLocalAccess::None,
            default_network: false,
            app_overrides: HashMap::new(),
        }
    }
}

impl<'de> serde::Deserialize<'de> for AppPermissionSettings {
    /// 兼容旧版持久化格式（defaultLevel/allowLevel3/appOverrides: u8）。
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct NewSettings {
            default_local: PaprLocalAccess,
            default_network: bool,
            app_overrides: Option<HashMap<String, PaprAccess>>,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct LegacyOverride {
            #[serde(rename = "appOverrides")]
            app_overrides: Option<HashMap<String, serde_json::Value>>,
        }
        let value = serde_json::Value::deserialize(deserializer)?;
        if let Ok(new) = serde_json::from_value::<NewSettings>(value.clone()) {
            return Ok(Self {
                default_local: new.default_local,
                default_network: new.default_network,
                app_overrides: new.app_overrides.unwrap_or_default(),
            });
        }
        let legacy_level = value
            .get("defaultLevel")
            .and_then(|v| v.as_u64())
            .map(|lvl| legacy_level_to_access(lvl as u8));
        let default = legacy_level.unwrap_or(PaprAccess::NONE);
        let legacy_overrides = serde_json::from_value::<LegacyOverride>(value)
            .ok()
            .and_then(|l| l.app_overrides)
            .unwrap_or_default();
        let mut overrides = HashMap::new();
        for (app_id, raw) in legacy_overrides {
            if let Some(level) = raw.as_u64() {
                overrides.insert(app_id, legacy_level_to_access(level as u8));
            } else if let Ok(access) = serde_json::from_value::<PaprAccess>(raw) {
                overrides.insert(app_id, access);
            }
        }
        Ok(Self {
            default_local: default.local,
            default_network: default.network,
            app_overrides: overrides,
        })
    }
}

pub fn get_app_settings() -> AppPermissionSettings {
    app_settings().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

pub fn set_app_settings(settings: AppPermissionSettings) {
    persist_settings(&settings);
    *app_settings().lock().unwrap_or_else(|e| e.into_inner()) = settings;
}

/// manifest 声明的两轴访问；缺省回落到用户全局默认。
pub fn manifest_access(manifest: &PaprManifest) -> PaprAccess {
    if let Some(local) = manifest.local {
        return PaprAccess {
            local,
            network: manifest.network.unwrap_or(false),
        };
    }
    if let Some(level) = manifest.level {
        return legacy_level_to_access(level);
    }
    let settings = get_app_settings();
    PaprAccess {
        local: settings.default_local,
        network: settings.default_network,
    }
}

/// 生效的两轴访问：manifest 声明 ∩ 用户逐 app 覆盖（覆盖只能收窄）。
pub fn resolve_effective_access(manifest: &PaprManifest, app_id: &str) -> PaprAccess {
    let settings = get_app_settings();
    let manifest_access = manifest_access(manifest);
    match settings.app_overrides.get(app_id).copied() {
        Some(override_access) => intersect_access(override_access, manifest_access),
        None => manifest_access,
    }
}

fn manifest_declares_agent(manifest: &PaprManifest, agent_name: &str) -> bool {
    manifest
        .agents
        .as_ref()
        .map(|agents| agents.iter().any(|a| a.name == agent_name))
        .unwrap_or(false)
}

/// papr SDK 能力检查（两轴模型）：
/// - storage/fs 是 app 自有沙箱，永远放行（路径仍限制在 app data 目录）；
///   local 轴只约束项目工作区（agent read/write/bash），与 JS 层 accessAllows 对齐；
/// - http 需要网络轴开启；
/// - agent:run:<name> 需要 manifest 声明了该 agent（工具集由 worker 按轴过滤）。
pub fn check_permission(manifest: &PaprManifest, app_id: &str, capability: &str) -> Result<(), String> {
    let access = resolve_effective_access(manifest, app_id);

    if capability.starts_with("http:") {
        if access.network {
            return Ok(());
        }
        return Err(format!(
            "permission denied: '{}' requires network access (app '{}' network is off)",
            capability, app_id
        ));
    }
    if capability.starts_with("agent:run:") {
        let agent_name = capability.strip_prefix("agent:run:").unwrap_or("");
        if manifest_declares_agent(manifest, agent_name) {
            return Ok(());
        }
        return Err(format!(
            "permission denied: agent '{}' not declared in manifest (app '{}')",
            agent_name, app_id
        ));
    }
    if capability.starts_with("storage:") || capability.starts_with("fs:") {
        return Ok(());
    }

    Err(format!(
        "unknown capability '{}' for app '{}'",
        capability, app_id
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papr_runtime::manifest::PaprManifest;

    fn make_manifest(local: Option<PaprLocalAccess>, network: Option<bool>, level: Option<u8>) -> PaprManifest {
        PaprManifest {
            spec: "papr/0.1".into(),
            name: "Test".into(),
            version: None,
            entry: None,
            icon: None,
            permissions: None,
            agents: Some(vec![crate::papr_runtime::manifest::PaprAgentDef {
                name: "assistant".into(),
                model: None,
                system_prompt: None,
                tools: None,
                max_tool_rounds: None,
                inherit_context: None,
            }]),
            command: None,
            args: None,
            port: None,
            level,
            local,
            network,
        }
    }

    #[test]
    fn legacy_level_mapping() {
        assert_eq!(legacy_level_to_access(0), PaprAccess::NONE);
        assert_eq!(
            legacy_level_to_access(1),
            PaprAccess { local: PaprLocalAccess::Read, network: false }
        );
        assert_eq!(
            legacy_level_to_access(2),
            PaprAccess { local: PaprLocalAccess::Read, network: true }
        );
        assert_eq!(
            legacy_level_to_access(3),
            PaprAccess { local: PaprLocalAccess::Write, network: true }
        );
    }

    #[test]
    fn intersect_only_narrows() {
        let a = PaprAccess { local: PaprLocalAccess::Write, network: true };
        let b = PaprAccess { local: PaprLocalAccess::Read, network: false };
        let narrowed = intersect_access(a, b);
        assert_eq!(narrowed.local, PaprLocalAccess::Read);
        assert!(!narrowed.network);
        // 覆盖不会放大
        let kept = intersect_access(b, a);
        assert_eq!(kept, narrowed);
    }

    #[test]
    fn manifest_access_prefers_two_axis_over_legacy_level() {
        reset_test_settings();
        let m = make_manifest(Some(PaprLocalAccess::Read), Some(true), Some(0));
        assert_eq!(
            manifest_access(&m),
            PaprAccess { local: PaprLocalAccess::Read, network: true }
        );
        let legacy = make_manifest(None, None, Some(2));
        assert_eq!(
            manifest_access(&legacy),
            PaprAccess { local: PaprLocalAccess::Read, network: true }
        );
    }

    #[test]
    fn check_storage_always_available() {
        reset_test_settings();
        // papr.db / papr.fs 是 app 自有沙箱：local=none 也放行
        let none = make_manifest(Some(PaprLocalAccess::None), Some(false), None);
        assert!(check_permission(&none, "test-app", "storage:read").is_ok());
        assert!(check_permission(&none, "test-app", "storage:write").is_ok());
        assert!(check_permission(&none, "test-app", "fs:read").is_ok());
        assert!(check_permission(&none, "test-app", "fs:write").is_ok());
        let read = make_manifest(Some(PaprLocalAccess::Read), Some(false), None);
        assert!(check_permission(&read, "test-app", "storage:write").is_ok());
        assert!(check_permission(&read, "test-app", "fs:write").is_ok());
    }

    #[test]
    fn check_http_requires_network() {
        reset_test_settings();
        let off = make_manifest(Some(PaprLocalAccess::Read), Some(false), None);
        assert!(check_permission(&off, "test-app", "http:get").is_err());
        let on = make_manifest(Some(PaprLocalAccess::Read), Some(true), None);
        assert!(check_permission(&on, "test-app", "http:post").is_ok());
    }

    #[test]
    fn check_agent_requires_declared_agent() {
        reset_test_settings();
        let m = make_manifest(Some(PaprLocalAccess::None), Some(false), None);
        assert!(check_permission(&m, "test-app", "agent:run:assistant").is_ok());
        assert!(check_permission(&m, "test-app", "agent:run:nobody").is_err());
    }

    #[test]
    fn user_override_narrows_manifest_access() {
        reset_test_settings();
        // 用独立 app id：persist 的 override 是全局共享状态，若与其它测试
        // 共用 "test-app" 且不清理，并行运行时会把其它用例的断言收窄失败。
        let app_id = "override-app";
        set_app_settings(AppPermissionSettings {
            default_local: PaprLocalAccess::None,
            default_network: false,
            app_overrides: {
                let mut map = HashMap::new();
                map.insert(
                    app_id.into(),
                    PaprAccess { local: PaprLocalAccess::None, network: false },
                );
                map
            },
        });
        let m = make_manifest(Some(PaprLocalAccess::Write), Some(true), None);
        let access = resolve_effective_access(&m, app_id);
        assert_eq!(access.local, PaprLocalAccess::None);
        assert!(!access.network);
        // 未覆盖的 app 使用 manifest 声明
        let other = make_manifest(Some(PaprLocalAccess::Read), Some(true), None);
        let access2 = resolve_effective_access(&other, "other-app");
        assert_eq!(access2.local, PaprLocalAccess::Read);
        assert!(access2.network);

        // 清理全局 settings，避免污染并行运行的其它用例
        reset_test_settings();
    }

    #[test]
    fn legacy_settings_deserialize() {
        let json = r#"{"defaultLevel":2,"allowLevel3":false,"appOverrides":{"app-a":1}}"#;
        let settings: AppPermissionSettings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.default_local, PaprLocalAccess::Read);
        assert!(settings.default_network);
        let override_access = settings.app_overrides.get("app-a").unwrap();
        assert_eq!(override_access.local, PaprLocalAccess::Read);
        assert!(!override_access.network);
    }
}
