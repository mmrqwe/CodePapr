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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaprManifest {
    pub spec: String,
    pub name: String,
    pub version: Option<String>,
    pub entry: Option<String>,
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
}

pub fn load_manifest(apps_dir: &Path, app_id: &str) -> Result<PaprManifest, String> {
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

    Ok(manifest)
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
            permissions: None,
            agents: None,
            command: None,
            args: None,
            port: None,
            level: None,
            local: Some(PaprLocalAccess::Read),
            network: Some(false),
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

