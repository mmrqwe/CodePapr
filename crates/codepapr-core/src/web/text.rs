pub(crate) fn truncate_text_to_bytes(content: String, max_bytes: usize) -> (String, bool) {
    if content.len() <= max_bytes {
        return (content, false);
    }

    let mut end = max_bytes;
    while end > 0 && !content.is_char_boundary(end) {
        end -= 1;
    }

    (content[..end].to_string(), true)
}

pub(crate) fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn decode_html_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&#x27;", "'")
}

fn strip_tag_block(mut html: String, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");

    loop {
        let lower = html.to_lowercase();
        let Some(start) = lower.find(&open) else {
            break;
        };
        let Some(close_start_rel) = lower[start..].find(&close) else {
            html.replace_range(start..html.len(), " ");
            break;
        };
        let close_start = start + close_start_rel;
        let Some(close_end_rel) = lower[close_start..].find('>') else {
            html.replace_range(start..html.len(), " ");
            break;
        };
        let close_end = close_start + close_end_rel + 1;
        html.replace_range(start..close_end, " ");
    }

    html
}

pub(crate) fn html_to_text(html: &str) -> String {
    let without_scripts = strip_tag_block(html.to_string(), "script");
    let sanitized = strip_tag_block(without_scripts, "style");
    let mut output = String::with_capacity(sanitized.len());
    let mut in_tag = false;
    let mut last_space = false;

    for ch in sanitized.chars() {
        match ch {
            '<' => {
                in_tag = true;
                if !last_space {
                    output.push(' ');
                    last_space = true;
                }
            }
            '>' => {
                in_tag = false;
            }
            _ if in_tag => {}
            c if c.is_whitespace() => {
                if !last_space {
                    output.push(' ');
                    last_space = true;
                }
            }
            c => {
                output.push(c);
                last_space = false;
            }
        }
    }

    collapse_whitespace(&decode_html_entities(&output))
}

pub(crate) fn normalize_search_text(value: &str) -> String {
    let trimmed = value.trim();
    let without_cdata = trimmed
        .strip_prefix("<![CDATA[")
        .and_then(|inner| inner.strip_suffix("]]>"))
        .unwrap_or(trimmed);
    html_to_text(without_cdata)
}
