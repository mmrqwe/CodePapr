use crate::papr_runtime::manifest::PaprManifest;

pub fn check_permission(manifest: &PaprManifest, capability: &str) -> Result<(), String> {
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

    Err(format!(
        "permission denied: '{}' not in manifest permissions",
        capability
    ))
}

pub fn check_tool_permission(manifest: &PaprManifest, tool_name: &str) -> Result<(), String> {
    let required = match tool_name {
        "read" | "grep" | "list" | "graph" | "lsp" | "diagnostics" | "read_image" => "workspace:read",
        "write" | "edit" | "patch" => "workspace:write",
        "exec" | "shell" => "workspace:exec",
        "web_search" | "web_fetch" | "web_download" => "http:get",
        _ => return Ok(()),
    };
    check_permission(manifest, required)
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
        }
    }

    #[test]
    fn exact_match_passes() {
        let m = make_manifest(vec!["storage:read".into()]);
        assert!(check_permission(&m, "storage:read").is_ok());
    }

    #[test]
    fn prefix_match_passes() {
        let m = make_manifest(vec!["storage".into()]);
        assert!(check_permission(&m, "storage:read").is_ok());
        assert!(check_permission(&m, "storage:write").is_ok());
    }

    #[test]
    fn wildcard_agent_match_passes() {
        let m = make_manifest(vec!["agent:run:*".into()]);
        assert!(check_permission(&m, "agent:run:assistant").is_ok());
        assert!(check_permission(&m, "agent:run:explorer").is_ok());
    }

    #[test]
    fn specific_agent_match_passes() {
        let m = make_manifest(vec!["agent:run:assistant".into()]);
        assert!(check_permission(&m, "agent:run:assistant").is_ok());
        assert!(check_permission(&m, "agent:run:explorer").is_err());
    }

    #[test]
    fn no_match_fails() {
        let m = make_manifest(vec!["storage:read".into()]);
        assert!(check_permission(&m, "http:get").is_err());
    }

    #[test]
    fn empty_permissions_fails() {
        let m = make_manifest(vec![]);
        assert!(check_permission(&m, "storage:read").is_err());
    }

    #[test]
    fn no_permissions_field_fails() {
        let m = PaprManifest {
            spec: "papr/0.1".into(),
            name: "Test".into(),
            version: None,
            entry: None,
            permissions: None,
            agents: None,
            command: None,
            args: None,
            port: None,
        };
        assert!(check_permission(&m, "storage:read").is_err());
    }

    #[test]
    fn tool_read_requires_workspace_read() {
        let m = make_manifest(vec!["workspace:read".into()]);
        assert!(check_tool_permission(&m, "read").is_ok());
        assert!(check_tool_permission(&m, "grep").is_ok());
        assert!(check_tool_permission(&m, "list").is_ok());
        assert!(check_tool_permission(&m, "diagnostics").is_ok());
    }

    #[test]
    fn tool_write_requires_workspace_write() {
        let m = make_manifest(vec!["workspace:write".into()]);
        assert!(check_tool_permission(&m, "write").is_ok());
        assert!(check_tool_permission(&m, "edit").is_ok());
    }

    #[test]
    fn tool_exec_requires_workspace_exec() {
        let m = make_manifest(vec!["workspace:exec".into()]);
        assert!(check_tool_permission(&m, "exec").is_ok());
        assert!(check_tool_permission(&m, "shell").is_ok());
    }

    #[test]
    fn tool_web_requires_http_get() {
        let m = make_manifest(vec!["http:get".into()]);
        assert!(check_tool_permission(&m, "web_search").is_ok());
        assert!(check_tool_permission(&m, "web_fetch").is_ok());
    }

    #[test]
    fn tool_without_permission_fails() {
        let m = make_manifest(vec!["storage:read".into()]);
        assert!(check_tool_permission(&m, "read").is_err());
        assert!(check_tool_permission(&m, "write").is_err());
        assert!(check_tool_permission(&m, "exec").is_err());
    }

    #[test]
    fn unknown_tool_passes() {
        let m = make_manifest(vec![]);
        assert!(check_tool_permission(&m, "unknown_tool").is_ok());
    }
}
