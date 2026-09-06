use crate::papr_runtime::permission::PaprLocalAccess;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::sync::OnceLock;

static MANIFEST_CACHE: OnceLock<Mutex<HashMap<String, PaprManifest>>> = OnceLock::new();

fn manifest_cache() -> &'static Mutex<HashMap<String, PaprManifest>> {
    MANIFEST_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn store_manifest(app_id: &str, manifest: PaprManifest) {
    manifest_cache().lock().unwrap_or_else(|e| e.into_inner()).insert(app_id.to_string(), manifest);
}

pub fn get_manifest(app_id: &str) -> Result<PaprManifest, String> {
    manifest_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(app_id)
        .cloned()
        .ok_or_else(|| format!("app '{}' manifest not loaded", app_id))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaprInheritContext {
    #[serde(default)]
    pub skills: bool,
    #[serde(default)]
    pub project_rules: bool,
    #[serde(default)]
    pub project_memory: bool,
    #[serde(default)]
    pub custom_prompt: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaprAgentDef {
    pub name: String,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub max_tool_rounds: Option<usize>,
    pub inherit_context: Option<PaprInheritContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PaprSurface {
    #[serde(rename = "type")]
    pub surface_type: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub position: Option<String>,
    #[serde(default)]
    pub always_on_top: Option<bool>,
    #[serde(default)]
    pub transparent: Option<bool>,
    #[serde(default)]
    pub decorations: Option<bool>,
    #[serde(default)]
    pub resizable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PaprLifecycle {
    pub autostart: Option<bool>,
    pub persist_position: Option<bool>,
    /// 仅 plugin：启用后 overlay 何时出现（always/onDemand/never）。
    /// 结构体必须覆盖此字段，否则任何 struct→JSON 的再序列化都会静默丢配置。
    pub show: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaprManifest {
    pub spec: String,
    pub name: String,
    pub version: Option<String>,
    pub entry: Option<String>,
    pub icon: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub surface: Option<PaprSurface>,
    #[serde(default)]
    pub lifecycle: Option<PaprLifecycle>,
    pub permissions: Option<Vec<String>>,
    pub agents: Option<Vec<PaprAgentDef>>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub port: Option<u16>,
    #[serde(default)]
    pub level: Option<u8>,
    #[serde(default)]
    pub local: Option<PaprLocalAccess>,
    #[serde(default)]
    pub network: Option<bool>,
    /// 频道契约（channel → {description, example}）。结构体必须覆盖此字段：
    /// 之前缺失导致 scan 重序列化后 inbox 被剥离，前端「已启用插件」目录永远为空。
    #[serde(default)]
    pub inbox: Option<HashMap<String, serde_json::Value>>,
}

/// Thin convenience wrapper over [`load_manifest_with_raw`] for callers that
/// do not need the on-disk source. Used by tests; production paths pass
/// through `with_raw` so unknown manifest fields survive round-trips.
#[allow(dead_code)]
pub fn load_manifest(apps_dir: &Path, app_id: &str) -> Result<PaprManifest, String> {
    load_manifest_with_raw(apps_dir, app_id).map(|(manifest, _)| manifest)
}

/// 读取并校验 manifest，同时返回磁盘原文。scan 等对外通道应透传原文，
/// 避免结构体未覆盖的字段（inbox、description 等）在反/重序列化中被剥离。
pub fn load_manifest_with_raw(apps_dir: &Path, app_id: &str) -> Result<(PaprManifest, String), String> {
    let manifest_path = apps_dir.join(app_id).join("manifest.json");
    let content = fs::read_to_string(&manifest_path).map_err(|err| {
        format!(
            "读取 manifest {} 失败: {err}",
            manifest_path.display()
        )
    })?;

    let manifest: PaprManifest = serde_json::from_str(&content)
        .map_err(|err| format!("解析 manifest {} 失败: {err}", manifest_path.display()))?;

    if manifest.spec != "papr/0.1" {
        return Err(format!(
            "不支持的 manifest spec '{}'（需要 papr/0.1）",
            manifest.spec
        ));
    }

    if manifest.name.trim().is_empty() {
        return Err("manifest name 不能为空".to_string());
    }

    Ok((manifest, content))
}

pub fn clear_manifest(app_id: &str) {
    manifest_cache().lock().unwrap_or_else(|e| e.into_inner()).remove(app_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn load_valid_manifest() {
        let dir = std::env::temp_dir().join(format!("papr-test-valid-{}", std::process::id()));
        let app_dir = dir.join("hello-app");
        fs::create_dir_all(&app_dir).unwrap();

        let json = r#"{"spec":"papr/0.1","name":"Hello","version":"1.0","permissions":["storage:read"],"agents":[{"name":"assistant","model":"deepseek"}]}"#;
        fs::write(app_dir.join("manifest.json"), json).unwrap();

        let manifest = load_manifest(&dir, "hello-app").unwrap();
        assert_eq!(manifest.name, "Hello");
        assert_eq!(manifest.spec, "papr/0.1");
        assert_eq!(manifest.version.as_deref(), Some("1.0"));
        assert_eq!(manifest.permissions.unwrap().len(), 1);
        assert_eq!(manifest.agents.unwrap().len(), 1);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_plugin_manifest_kind_and_surface() {
        let dir = std::env::temp_dir().join(format!("papr-test-plugin-{}", std::process::id()));
        let app_dir = dir.join("stock-ticker");
        fs::create_dir_all(&app_dir).unwrap();

        let json = r#"{"spec":"papr/0.1","name":"股票","kind":"plugin","surface":{"type":"overlay","width":320,"height":180,"position":"top-right"},"local":"none","network":true}"#;
        fs::write(app_dir.join("manifest.json"), json).unwrap();

        let manifest = load_manifest(&dir, "stock-ticker").unwrap();
        assert_eq!(manifest.kind.as_deref(), Some("plugin"));
        let surface = manifest.surface.expect("surface");
        assert_eq!(surface.surface_type.as_deref(), Some("overlay"));
        assert_eq!(surface.width, Some(320));
        assert_eq!(surface.height, Some(180));
        assert_eq!(surface.position.as_deref(), Some("top-right"));
        assert_eq!(manifest.network, Some(true));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_manifest_with_two_axis_access() {
        let dir = std::env::temp_dir().join(format!("papr-test-axis-{}", std::process::id()));
        let app_dir = dir.join("axis-app");
        fs::create_dir_all(&app_dir).unwrap();

        let json = r#"{"spec":"papr/0.1","name":"Axis","local":"read","network":true}"#;
        fs::write(app_dir.join("manifest.json"), json).unwrap();

        let manifest = load_manifest(&dir, "axis-app").unwrap();
        assert_eq!(manifest.local, Some(PaprLocalAccess::Read));
        assert_eq!(manifest.network, Some(true));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_manifest_preserves_inbox_and_show_through_round_trip() {
        // 回归：Rust 结构体曾缺 inbox/show 字段，serde 静默丢未知字段，
        // scan 重序列化后前端「已启用插件」目录永远为空。
        let dir = std::env::temp_dir().join(format!("papr-test-inbox-{}", std::process::id()));
        let app_dir = dir.join("kanban");
        fs::create_dir_all(&app_dir).unwrap();

        let json = r#"{"spec":"papr/0.1","name":"看板","kind":"plugin","description":"极简看板","lifecycle":{"show":"onDemand"},"inbox":{"board":{"description":"推送看板","example":{"op":"replace","blocks":[]}},"canvas":{"example":{"op":"replace","nodes":[]}}}}"#;
        fs::write(app_dir.join("manifest.json"), json).unwrap();

        let (manifest, raw) = load_manifest_with_raw(&dir, "kanban").unwrap();
        assert_eq!(raw, json, "raw 应为磁盘原文");

        let inbox = manifest.inbox.as_ref().expect("结构体必须保留 inbox");
        assert_eq!(inbox.len(), 2);
        assert!(inbox.contains_key("board"));
        assert!(inbox.contains_key("canvas"));
        assert_eq!(
            manifest.lifecycle.as_ref().and_then(|l| l.show.as_deref()),
            Some("onDemand")
        );

        // 结构体自身重序列化也不能丢字段（缓存/papr_get_manifest 出口）。
        let reserialized = serde_json::to_string(&manifest).unwrap();
        let reparsed: PaprManifest = serde_json::from_str(&reserialized).unwrap();
        assert_eq!(reparsed.inbox.expect("重序列化后 inbox 仍在").len(), 2);
        assert_eq!(
            reparsed.lifecycle.and_then(|l| l.show).as_deref(),
            Some("onDemand")
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reject_wrong_spec() {
        let dir = std::env::temp_dir().join(format!("papr-test-spec-{}", std::process::id()));
        let app_dir = dir.join("bad-spec");
        fs::create_dir_all(&app_dir).unwrap();
        fs::write(app_dir.join("manifest.json"), r#"{"spec":"bad/1.0","name":"X"}"#).unwrap();

        let result = load_manifest(&dir, "bad-spec");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("不支持的 manifest spec"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reject_empty_name() {
        let dir = std::env::temp_dir().join(format!("papr-test-name-{}", std::process::id()));
        let app_dir = dir.join("empty-name");
        fs::create_dir_all(&app_dir).unwrap();
        fs::write(app_dir.join("manifest.json"), r#"{"spec":"papr/0.1","name":"   "}"#).unwrap();

        let result = load_manifest(&dir, "empty-name");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("name 不能为空"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reject_invalid_json() {
        let dir = std::env::temp_dir().join(format!("papr-test-json-{}", std::process::id()));
        let app_dir = dir.join("bad-json");
        fs::create_dir_all(&app_dir).unwrap();
        fs::write(app_dir.join("manifest.json"), b"not json at all").unwrap();

        let result = load_manifest(&dir, "bad-json");
        assert!(result.is_err());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn store_and_get_from_cache() {
        let manifest = PaprManifest {
            spec: "papr/0.1".into(),
            name: "Cached".into(),
            version: None,
            entry: None,
            icon: None,
            kind: None,
            surface: None,
            lifecycle: None,
            permissions: None,
            agents: None,
            command: None,
            args: None,
            port: None,
            level: None,
            local: Some(PaprLocalAccess::Read),
            network: Some(false),
            inbox: None,
        };

        store_manifest("test-cache", manifest);
        let retrieved = get_manifest("test-cache").unwrap();
        assert_eq!(retrieved.name, "Cached");

        clear_manifest("test-cache");
        assert!(get_manifest("test-cache").is_err());
    }

    #[test]
    fn manifest_missing_file() {
        let dir = std::env::temp_dir().join(format!("papr-test-missing-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let result = load_manifest(&dir, "no-exist");
        assert!(result.is_err());

        fs::remove_dir_all(&dir).ok();
    }
}

