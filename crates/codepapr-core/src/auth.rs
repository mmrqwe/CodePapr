use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestEvent {
    pub runtime_id: String,
    pub request_id: String,
    pub path: String,
    pub operation: String,
    pub workspace_path: String,
    pub exists: bool,
    pub allow_file: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationRequestEvent {
    pub runtime_id: String,
    pub request_id: String,
    pub title: String,
    pub message: String,
}

pub struct PermissionDecision {
    pub approved: bool,
    pub scope: String,
}

pub trait PermissionAuthorizer: Send + Sync + 'static {
    fn request_permission(
        &self,
        event: PermissionRequestEvent,
    ) -> Result<PermissionDecision, String>;

    fn request_confirmation(
        &self,
        event: ConfirmationRequestEvent,
    ) -> Result<bool, String>;
}

/// Permissive authorizer for non-interactive / CLI with `--allow-all`
#[derive(Clone, Default)]
pub struct AllowAllAuthorizer;

impl PermissionAuthorizer for AllowAllAuthorizer {
    fn request_permission(
        &self,
        _event: PermissionRequestEvent,
    ) -> Result<PermissionDecision, String> {
        Ok(PermissionDecision {
            approved: true,
            scope: "session".to_string(),
        })
    }

    fn request_confirmation(
        &self,
        _event: ConfirmationRequestEvent,
    ) -> Result<bool, String> {
        Ok(true)
    }
}
