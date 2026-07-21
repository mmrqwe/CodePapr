use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

static APP_CONTEXTS: OnceLock<Mutex<HashMap<String, AppContext>>> = OnceLock::new();

fn app_contexts() -> &'static Mutex<HashMap<String, AppContext>> {
    APP_CONTEXTS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct AppContext {
    pub app_id: String,
    pub workspace_path: String,
}

pub fn register(app_id: &str, workspace_path: &str) {
    app_contexts().lock().unwrap().insert(
        app_id.to_string(),
        AppContext {
            app_id: app_id.to_string(),
            workspace_path: workspace_path.to_string(),
        },
    );
}

pub fn unregister(app_id: &str) {
    app_contexts().lock().unwrap().remove(app_id);
}

pub fn get(app_id: &str) -> Result<AppContext, String> {
    app_contexts()
        .lock()
        .unwrap()
        .get(app_id)
        .cloned()
        .ok_or_else(|| format!("app context '{}' not registered", app_id))
}
