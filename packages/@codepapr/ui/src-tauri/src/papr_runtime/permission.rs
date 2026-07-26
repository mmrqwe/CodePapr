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
    if let Ok(json) = serde_json::to_string(settings) {
        let _ = crate::db::papr_save_permission_settings(&json);
    }
}

#[cfg(test)]
fn reset_test_settings() {
    let default = AppPermissionSettings::default();
    persist_settings(&default);
    if let Some(guard) = APP_SETTINGS.get() {
        *guard.lock().unwrap_or_else(|e| e.into_inner()) = default;
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPermissionSettings {
    pub default_level: u8,
    pub allow_level3: bool,
    pub app_overrides: HashMap<String, u8>,
}

impl Default for AppPermissionSettings {
    fn default() -> Self {
        Self {
            default_level: 1,
            allow_level3: false,
            app_overrides: HashMap::new(),
        }
    }
}

pub fn get_app_settings() -> AppPermissionSettings {
    app_settings().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

pub fn set_app_settings(settings: AppPermissionSettings) {
    persist_settings(&settings);
    *app_settings().lock().unwrap_or_else(|e| e.into_inner()) = settings;
}

const LEVEL_GRANTS: &[&[&str]] = &[
    &[],
    &[
        "storage:read", "storage:write",
        "fs:read", "fs:write",
        "agent:run:*",
        "workspace:read",
    ],
    &[
        "storage:read", "storage:write",
        "fs:read", "fs:write",
        "agent:run:*",
        "workspace:read",
        "http:get", "http:post",
    ],
    &[
        "storage:read", "storage:write",
        "fs:read", "fs:write",
        "agent:run:*",
        "workspace:read",
        "http:get", "http:post",
        "workspace:write", "workspace:exec",
    ],
];

pub fn level_allows(level: u8, capability: &str) -> bool {
    let idx = level.min(3) as usize;
    let grants = LEVEL_GRANTS.get(idx).copied().unwrap_or(&[]);
    if grants.iter().any(|&g| g == capability) {
        return true;
    }
    if capability.starts_with("agent:run:") {
        return grants.iter().any(|&g| g == "agent:run:*");
    }
    false
}

pub fn resolve_effective_level(manifest: &PaprManifest, app_id: &str) -> u8 {
    let settings = get_app_settings();
    let manifest_level = manifest.level.unwrap_or(settings.default_level).min(3);
    let user_override = settings.app_overrides.get(app_id).copied();
    let mut effective = match user_override {
        Some(override_level) => override_level.min(manifest_level),
        None => manifest_level,
    };
    if effective >= 3 && !settings.allow_level3 {
        effective = 2;
    }
    effective
}

pub fn check_permission(manifest: &PaprManifest, app_id: &str, capability: &str) -> Result<(), String> {
    let level = resolve_effective_level(manifest, app_id);

    if !level_allows(level, capability) {
        return Err(format!(
            "permission denied: '{}' requires level {} (app '{}' is level {})",
            capability, required_level_for_capability(capability), app_id, level
        ));
    }

    let permissions = manifest.permissions.as_ref().map_or(&[] as &[String], |v| v.as_slice());

    if permissions.iter().any(|p| p == capability) {
        return Ok(());
    }
    if let Some((prefix, _)) = capability.split_once(':') {
        if permissions.iter().any(|p| p == prefix) {
            return Ok(());
        }
    }
    if capability.starts_with("agent:run:") {
        let agent_name = capability.strip_prefix("agent:run:").unwrap_or("");
        for p in permissions {
            if p == capability || p.strip_prefix("agent:run:") == Some(agent_name) {
                return Ok(());
            }
            if p == "agent:run:*" {
                return Ok(());
            }
        }
    }

    if permissions.is_empty() && level_allows(level, capability) {
        return Ok(());
    }

    Err(format!(
        "permission denied: '{}' not in manifest permissions (app '{}' level {})",
        capability, app_id, level
    ))
}

fn required_level_for_capability(capability: &str) -> u8 {
    let level3 = ["workspace:write", "workspace:exec"];
    let level2 = ["http:get", "http:post"];
    if level3.iter().any(|&c| c == capability || capability.starts_with(c)) {
        return 3;
    }
    if level2.iter().any(|&c| c == capability || capability.starts_with(c)) {
        return 2;
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papr_runtime::manifest::PaprManifest;

    fn make_manifest(permissions: Vec<String>) -> PaprManifest {
        PaprManifest {
            spec: "papr/0.1".into(),
            name: "Test".into(),
            version: None,
            entry: None,
            permissions: Some(permissions),
            agents: None,
            command: None,
            args: None,
            port: None,
            level: None,
        }
    }

    fn make_manifest_level(level: u8, permissions: Vec<String>) -> PaprManifest {
        PaprManifest {
            spec: "papr/0.1".into(),
            name: "Test".into(),
            version: None,
            entry: None,
            permissions: Some(permissions),
            agents: None,
            command: None,
            args: None,
            port: None,
            level: Some(level),
        }
    }

    #[test]
    fn level_allows_storage_at_l1() {
        assert!(level_allows(1, "storage:read"));
        assert!(level_allows(1, "storage:write"));
        assert!(level_allows(1, "fs:read"));
        assert!(!level_allows(1, "http:get"));
        assert!(!level_allows(1, "workspace:write"));
    }

    #[test]
    fn level_allows_http_at_l2() {
        assert!(level_allows(2, "http:get"));
        assert!(level_allows(2, "http:post"));
        assert!(!level_allows(2, "workspace:write"));
    }

    #[test]
    fn level_allows_write_at_l3() {
        assert!(level_allows(3, "workspace:write"));
        assert!(level_allows(3, "workspace:exec"));
    }

    #[test]
    fn level_blocks_everything_at_l0() {
        assert!(!level_allows(0, "storage:read"));
        assert!(!level_allows(0, "http:get"));
    }

    #[test]
    fn resolve_effective_level_caps_l3_when_disabled() {
        reset_test_settings();
        set_app_settings(AppPermissionSettings {
            default_level: 1,
            allow_level3: false,
            app_overrides: HashMap::new(),
        });
        let m = make_manifest_level(3, vec![]);
        assert_eq!(resolve_effective_level(&m, "test-app"), 2);
    }

    #[test]
    fn resolve_effective_level_allows_l3_when_enabled() {
        reset_test_settings();
        set_app_settings(AppPermissionSettings {
            default_level: 1,
            allow_level3: true,
            app_overrides: HashMap::new(),
        });
        let m = make_manifest_level(3, vec![]);
        assert_eq!(resolve_effective_level(&m, "test-app"), 3);
    }

    #[test]
    fn resolve_effective_level_user_override_caps() {
        reset_test_settings();
        set_app_settings(AppPermissionSettings {
            default_level: 1,
            allow_level3: true,
            app_overrides: {
                let mut m = HashMap::new();
                m.insert("test-app".into(), 1u8);
                m
            },
        });
        let m = make_manifest_level(3, vec![]);
        assert_eq!(resolve_effective_level(&m, "test-app"), 1);
    }

    #[test]
    fn check_permission_l1_blocks_http() {
        reset_test_settings();
        set_app_settings(AppPermissionSettings::default());
        let m = make_manifest_level(1, vec!["storage:read".into(), "http:get".into()]);
        assert!(check_permission(&m, "test-app", "storage:read").is_ok());
        assert!(check_permission(&m, "test-app", "http:get").is_err());
    }

    #[test]
    fn check_permission_l2_allows_http() {
        reset_test_settings();
        set_app_settings(AppPermissionSettings {
            default_level: 1,
            allow_level3: true,
            app_overrides: HashMap::new(),
        });
        let m = make_manifest_level(2, vec!["http:get".into()]);
        assert!(check_permission(&m, "test-app", "http:get").is_ok());
    }

    #[test]
    fn check_permission_empty_perms_with_level_grants() {
        reset_test_settings();
        set_app_settings(AppPermissionSettings::default());
        let m = make_manifest_level(1, vec![]);
        assert!(check_permission(&m, "test-app", "storage:read").is_ok());
        assert!(check_permission(&m, "test-app", "http:get").is_err());
    }
}
