use std::time::{SystemTime, UNIX_EPOCH};

/// Current Unix timestamp in milliseconds.
pub(crate) fn unix_millis() -> Result<i64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("系统时间异常: {err}"))?
        .as_millis();
    i64::try_from(millis).map_err(|_| "系统时间超出可存储范围".to_string())
}
