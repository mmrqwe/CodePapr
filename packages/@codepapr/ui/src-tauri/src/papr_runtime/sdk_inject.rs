pub fn inject_sdk_into_html(html: &str) -> String {
    if html.contains("__papr_sdk.js") {
        return html.to_string();
    }

    let script_tag = "\n<script src=\"/__papr_sdk.js\"></script>";
    let lower = html.to_lowercase();

    if let Some(pos) = lower.find("<head") {
        let after_tag_start = &lower[pos..];
        if let Some(close_bracket) = after_tag_start.find('>') {
            let insert_pos = pos + close_bracket + 1;
            let mut modified = String::with_capacity(html.len() + 80);
            modified.push_str(&html[..insert_pos]);
            modified.push_str(script_tag);
            if insert_pos < html.len() {
                modified.push_str(&html[insert_pos..]);
            }
            return modified;
        }
    }

    if let Some(pos) = lower.find("<html") {
        let after_tag_start = &lower[pos..];
        if let Some(close_bracket) = after_tag_start.find('>') {
            let insert_pos = pos + close_bracket + 1;
            let mut modified = String::with_capacity(html.len() + 80);
            modified.push_str(&html[..insert_pos]);
            modified.push_str(script_tag);
            if insert_pos < html.len() {
                modified.push_str(&html[insert_pos..]);
            }
            return modified;
        }
    }

    let mut modified = String::with_capacity(html.len() + 80);
    modified.push_str(script_tag);
    modified.push_str(html);
    modified
}

pub fn get_sdk_js() -> &'static str {
    include_str!("../../resources/papr-sdk.js")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_script_after_head() {
        let html = "<html><head><title>Test</title></head><body></body></html>";
        let result = inject_sdk_into_html(html);
        assert!(result.contains("__papr_sdk.js"));
        assert!(result.contains("<script src=\"/__papr_sdk.js\"></script>"));
    }

    #[test]
    fn does_not_double_inject() {
        let html = "<html><head><script src=\"/__papr_sdk.js\"></script></head></html>";
        let result = inject_sdk_into_html(html);
        assert_eq!(result, html);
    }

    #[test]
    fn handles_no_head_tag() {
        let html = "<html><body>No head</body></html>";
        let result = inject_sdk_into_html(html);
        assert!(result.contains("__papr_sdk.js"));
    }

    #[test]
    fn handles_no_head_no_html_tag() {
        let html = "<body>Bare body</body>";
        let result = inject_sdk_into_html(html);
        assert!(result.contains("__papr_sdk.js"));
        assert!(result.starts_with("\n<script"));
    }

    #[test]
    fn handles_uppercase_head() {
        let html = "<HTML><HEAD></HEAD><BODY></BODY></HTML>";
        let result = inject_sdk_into_html(html);
        assert!(result.contains("__papr_sdk.js"));
    }

    #[test]
    fn sdk_js_is_nonempty() {
        let sdk = get_sdk_js();
        assert!(!sdk.is_empty());
        assert!(sdk.contains("window.papr"));
    }
}
