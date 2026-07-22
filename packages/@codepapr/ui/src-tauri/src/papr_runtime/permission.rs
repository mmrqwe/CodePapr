use crate::papr_runtime::manifest::PaprManifest;

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

static APP_SETTINGS: OnceLock<Mutex<AppPermissionSettings>> = OnceLock::new();

fn app_settings() -> &'static Mutex<AppPermissionSettings> {
    APP_SETTINGS.get_or_init(|| Mutex::new(AppPermissionSettings::default()))
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
    app_settings().lock().unwrap().clone()
}

pub fn set_app_settings(settings: AppPermissionSettings) {
    *app_settings().lock().unwrap() = settings;
}

const LEVEL_GRANTS: &[&[&str]] = &[
    &[],
    &[
        "storage:read", "storage:write",
        "fs:read", "fs:write",
        "llm:chat",
        "agent:run:*",
        "workspace:read",
    ],
    &[
        "storage:read", "storage:write",
        "fs:read", "fs:write",
        "llm:chat",
        "agent:run:*",
        "workspace:read",
        "http:get", "http:post",
    ],
    &[
        "storage:read", "storage:write",
        "fs:read", "fs:write",
        "llm:chat",
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
    if let Some((prefix, _)) = capability.split_once(':') {
        if grants.iter().any(|&g| g == prefix) {
            return true;
        }
    }
    if capability.starts_with("agent:run:") {
        return grants.iter().any(|&g| g == "agent:run:*");
    }
    false
}

pub fn level_allows_tool(level: u8, tool_name: &str) -> bool {
    let required = match tool_name {
        "read" | "grep" | "list" | "graph" | "lsp" | "diagnostics" | "read_image" | "skill_load" | "question" | "todo" => "workspace:read",
        "write" | "edit" | "patch" => "workspace:write",
        "exec" | "shell" => "workspace:exec",
        "web_search" | "web_fetch" | "web_download" => "http:get",
        _ if tool_name.starts_with("mcp__") => "http:get",
        _ => return true,
    };
    level_allows(level, required)
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

pub fn check_tool_permission(manifest: &PaprManifest, app_id: &str, tool_name: &str) -> Result<(), String> {
    let level = resolve_effective_level(manifest, app_id);

    if !level_allows_tool(level, tool_name) {
        return Err(format!(
            "tool '{}' not allowed at level {} (app '{}')",
            tool_name, level, app_id
        ));
    }

    let required = match tool_name {
        "read" | "grep" | "list" | "graph" | "lsp" | "diagnostics" | "read_image" | "skill_load" | "question" | "todo" => "workspace:read",
        "write" | "edit" | "patch" => "workspace:write",
        "exec" | "shell" => "workspace:exec",
        "web_search" | "web_fetch" | "web_download" => "http:get",
        _ if tool_name.starts_with("mcp__") => "http:get",
        _ => return Ok(()),
    };

    check_permission(manifest, app_id, required)
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
    fn level_allows_tool_read_at_l1() {
        assert!(level_allows_tool(1, "read"));
        assert!(level_allows_tool(1, "grep"));
        assert!(!level_allows_tool(1, "web_search"));
        assert!(!level_allows_tool(1, "write"));
        assert!(!level_allows_tool(1, "exec"));
    }

    #[test]
    fn level_allows_tool_web_at_l2() {
        assert!(level_allows_tool(2, "web_search"));
        assert!(level_allows_tool(2, "web_fetch"));
        assert!(!level_allows_tool(2, "write"));
    }

    #[test]
    fn level_allows_tool_write_at_l3() {
        assert!(level_allows_tool(3, "write"));
        assert!(level_allows_tool(3, "exec"));
    }

    #[test]
    fn level_allows_mcp_at_l2() {
        assert!(level_allows_tool(2, "mcp__server__tool"));
        assert!(!level_allows_tool(1, "mcp__server__tool"));
    }

    #[test]
    fn level_blocks_everything_at_l0() {
        assert!(!level_allows(0, "storage:read"));
        assert!(!level_allows(0, "http:get"));
        assert!(!level_allows_tool(0, "read"));
    }

    #[test]
    fn resolve_effective_level_caps_l3_when_disabled() {
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
        set_app_settings(AppPermissionSettings::default());
        let m = make_manifest_level(1, vec!["storage:read".into(), "http:get".into()]);
        assert!(check_permission(&m, "test-app", "storage:read").is_ok());
        assert!(check_permission(&m, "test-app", "http:get").is_err());
    }

    #[test]
    fn check_permission_l2_allows_http() {
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
        set_app_settings(AppPermissionSettings::default());
        let m = make_manifest_level(1, vec![]);
        assert!(check_permission(&m, "test-app", "storage:read").is_ok());
        assert!(check_permission(&m, "test-app", "http:get").is_err());
    }
}
