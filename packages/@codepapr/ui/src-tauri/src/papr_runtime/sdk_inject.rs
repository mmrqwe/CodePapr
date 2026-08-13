/// 在原始字符串上按字节做 ASCII 大小写不敏感匹配（HTML 标签均为 ASCII）。
/// 返回的偏移是原文中的合法字节位置——旧实现在 `to_lowercase()` 副本上定位
/// 后把偏移直接用于切分原文，而 to_lowercase 可能改变字节长度
/// （'İ' U+0130→"i̇" 2→3 字节、Kelvin 符号 U+212A→'k' 3→1 字节），
/// 这类字符出现在 <head 之前时切分点会落在非字符边界上直接 panic。
/// 输入来自 papr app 提供的 HTML（经 codepapr-app:// 协议），属不可信内容。
fn find_ascii_ci(haystack: &str, needle: &str) -> Option<usize> {
    let h = haystack.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || n.len() > h.len() {
        return None;
    }
    (0..=(h.len() - n.len())).find(|&i| {
        h[i..i + n.len()]
            .iter()
            .zip(n)
            .all(|(a, b)| a.eq_ignore_ascii_case(b))
    })
}

fn insert_after_tag(html: &str, tag: &str, script_tag: &str) -> Option<String> {
    let pos = find_ascii_ci(html, tag)?;
    let close_bracket = html[pos..].find('>')?;
    let insert_pos = pos + close_bracket + 1;
    let mut modified = String::with_capacity(html.len() + script_tag.len());
    modified.push_str(&html[..insert_pos]);
    modified.push_str(script_tag);
    modified.push_str(&html[insert_pos..]);
    Some(modified)
}

pub fn inject_sdk_into_html(html: &str) -> String {
    if html.contains("__papr_sdk.js") {
        return html.to_string();
    }

    let script_tag = "\n<script src=\"/__papr_sdk.js\"></script>";

    if let Some(modified) = insert_after_tag(html, "<head", script_tag) {
        return modified;
    }

    if let Some(modified) = insert_after_tag(html, "<html", script_tag) {
        return modified;
    }

    let mut modified = String::with_capacity(html.len() + script_tag.len());
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
    fn handles_case_changing_unicode_before_head() {
        // 'İ'（U+0130）小写化后字节数 2→3，Kelvin 符号（U+212A）3→1：
        // 旧实现用 lowercase 副本的偏移切分原文，这里会 panic 或注入错位。
        let html = "<!-- İ Kelvin: \u{212A} --><html><head></head><body></body></html>";
        let result = inject_sdk_into_html(html);
        assert!(result.contains("__papr_sdk.js"));
        assert!(result.starts_with("<!-- İ Kelvin: \u{212A} --><html><head>"));
    }

    #[test]
    fn sdk_js_is_nonempty() {
        let sdk = get_sdk_js();
        assert!(!sdk.is_empty());
        assert!(sdk.contains("window.papr"));
    }
}
