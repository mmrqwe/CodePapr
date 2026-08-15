#![forbid(unsafe_code)]

/// 把文本内容写入用户在保存对话框中选择的路径（主题 JSON 等导出用途）。
/// 路径完全由用户通过系统保存对话框挑选，与 export_character_card 同模式。
#[tauri::command]
pub fn export_text_file(save_path: String, content: String) -> Result<(), String> {
    std::fs::write(&save_path, content.as_bytes()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::export_text_file;

    #[test]
    fn export_text_file_writes_utf8_content() {
        let dir = std::env::temp_dir().join(format!("codepapr-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("theme.json");
        let content = "{\"name\":\"测试主题\",\"mode\":\"dark\"}";

        export_text_file(path.to_string_lossy().to_string(), content.to_string())
            .expect("export should succeed");

        let read = std::fs::read_to_string(&path).expect("read back");
        assert_eq!(read, content);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn export_text_file_reports_invalid_path() {
        let result = export_text_file(
            "/definitely/not/exist/dir/theme.json".to_string(),
            "{}".to_string(),
        );
        assert!(result.is_err());
    }
}
