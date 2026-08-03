//! 内置浏览器 JS 注入脚本库。
//!
//! WKWebView 的 `evaluateJavaScript` 不会等待 Promise，因此所有脚本必须是
//! 同步 IIFE，返回纯对象。需要等待元素的操作使用两阶段协议：
//!
//! 1. Phase 1 脚本启动一个 setTimeout 轮询，把结果写入
//!    `window.__codepapr_pending[token]`，立即返回 `{ok, token}`；
//! 2. Rust 侧循环 eval Phase 2（`poll`）脚本取回结果，直到完成或超时。
//!
//! 辅助库通过 `WebviewBuilder::initialization_script` 在每个页面加载前注入，
//! 命令脚本只包含简短的调用。

/// 辅助库初始化脚本（每个页面加载时自动执行）。
pub(crate) const HELPER_INIT_SCRIPT: &str = r#"
(() => {
  if (window.__codepapr_lib) return;
  const lib = {};

  lib.find = (selector, kind) => {
    if (!selector) return null;
    if (kind === 'xpath') {
      const r = document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue;
    }
    return document.querySelector(selector);
  };

  lib.state = () => ({ url: location.href, title: document.title });

  lib.fail = (error) => ({ ok: false, error: String((error && error.message) || error) });

  lib.click = (el) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const opts = { bubbles: true, cancelable: true, composed: true, view: window };
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    if (el.focus) { try { el.focus(); } catch (e) {} }
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  };

  lib.setNativeValue = (el, value) => {
    let desc;
    for (let proto = Object.getPrototypeOf(el); proto && !desc; proto = Object.getPrototypeOf(proto)) {
      desc = Object.getOwnPropertyDescriptor(proto, 'value');
    }
    if (desc && desc.set) { desc.set.call(el, value); } else { el.value = value; }
  };

  lib.type = (el, text, clear, submit) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (el.focus) { try { el.focus(); } catch (e) {} }
    const editable = el.isContentEditable === true;
    if (clear) {
      if (editable) {
        el.textContent = '';
      } else {
        lib.setNativeValue(el, '');
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (editable) {
      try { document.execCommand('selectAll', false, null); } catch (e) {}
      try { document.execCommand('insertText', false, text); } catch (e) { el.textContent = text; }
    } else {
      lib.setNativeValue(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (submit) {
      const keyOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
      el.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
      el.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
      const form = el.form || (el.closest && el.closest('form'));
      if (form) {
        if (form.requestSubmit) { try { form.requestSubmit(); } catch (e) { try { form.submit(); } catch (e2) {} } }
        else { try { form.submit(); } catch (e) {} }
      }
    }
  };

  lib.read = (el, contentType) => {
    if (contentType === 'text') {
      if (el) return el.innerText || '';
      const body = document.body || document.documentElement;
      return (body && body.innerText) || '';
    }
    if (el) return el.outerHTML;
    return document.documentElement ? document.documentElement.outerHTML : '';
  };

  // run() 返回 undefined 表示继续等待；返回对象表示完成。
  lib.startWait = (token, timeoutMs, run) => {
    window.__codepapr_pending = window.__codepapr_pending || {};
    const deadline = Date.now() + timeoutMs;
    const finish = (r) => { window.__codepapr_pending[token] = r; };
    const attempt = () => {
      let result;
      try { result = run(); } catch (e) { finish(lib.fail(e)); return; }
      if (result !== undefined) { finish(result); return; }
      if (Date.now() > deadline) { finish({ ok: false, error: 'timeout waiting for condition' }); return; }
      setTimeout(attempt, 120);
    };
    attempt();
    return { ok: true, token: token };
  };

  lib.poll = (token) => {
    const store = window.__codepapr_pending;
    if (store && Object.prototype.hasOwnProperty.call(store, token)) {
      const r = store[token];
      delete store[token];
      return { done: true, result: r };
    }
    return { done: false };
  };

  window.__codepapr_lib = lib;
})()
"#;

/// 读取当前页面状态（同步，单阶段）。
pub(crate) const STATE_SCRIPT: &str =
    "(() => ({ ok: true, url: location.href, title: document.title }))()";

/// 历史导航脚本。
pub(crate) const HISTORY_BACK_SCRIPT: &str = "(() => { history.back(); return { ok: true }; })()";
pub(crate) const HISTORY_FORWARD_SCRIPT: &str =
    "(() => { history.forward(); return { ok: true }; })()";

/// 把任意字符串编码为合法的 JS 字符串字面量（含引号）。
///
/// serde_json 产出的 JSON 字符串即合法 JS 字面量，但 U+2028/U+2029
/// 在 JS 源码中是行终止符（JSON 允许、JS 源码不允许），需额外转义。
fn js_str(value: &str) -> String {
    let encoded = serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string());
    encoded
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

fn selector_kind_literal(kind: &str) -> &'static str {
    if kind.eq_ignore_ascii_case("xpath") {
        "xpath"
    } else {
        "css"
    }
}

/// 元素等待 + 点击脚本（两阶段协议的 Phase 1）。
pub(crate) fn click_script(
    token: &str,
    selector: &str,
    selector_kind: &str,
    timeout_ms: u64,
) -> String {
    format!(
        r#"(() => {{
  const lib = window.__codepapr_lib;
  if (!lib) return {{ ok: false, error: 'embedded browser helper not ready' }};
  return lib.startWait({token}, {timeout_ms}, () => {{
    const el = lib.find({selector}, {kind});
    if (!el) return undefined;
    lib.click(el);
    return Object.assign({{ ok: true, action: 'click', selector: {selector}, selectorType: {kind_label} }}, lib.state());
  }});
}})()"#,
        token = js_str(token),
        timeout_ms = timeout_ms,
        selector = js_str(selector),
        kind = js_str(selector_kind_literal(selector_kind)),
        kind_label = js_str(selector_kind_literal(selector_kind)),
    )
}

/// 元素等待 + 文本输入脚本（两阶段协议的 Phase 1）。
pub(crate) fn input_script(
    token: &str,
    selector: &str,
    selector_kind: &str,
    text: &str,
    clear: bool,
    submit: bool,
    timeout_ms: u64,
) -> String {
    format!(
        r#"(() => {{
  const lib = window.__codepapr_lib;
  if (!lib) return {{ ok: false, error: 'embedded browser helper not ready' }};
  return lib.startWait({token}, {timeout_ms}, () => {{
    const el = lib.find({selector}, {kind});
    if (!el) return undefined;
    lib.type(el, {text}, {clear}, {submit});
    return Object.assign({{ ok: true, action: 'input', selector: {selector}, selectorType: {kind_label} }}, lib.state());
  }});
}})()"#,
        token = js_str(token),
        timeout_ms = timeout_ms,
        selector = js_str(selector),
        kind = js_str(selector_kind_literal(selector_kind)),
        text = js_str(text),
        clear = clear,
        submit = submit,
        kind_label = js_str(selector_kind_literal(selector_kind)),
    )
}

/// DOM 读取脚本（两阶段协议的 Phase 1；无 selector 时等待 body 就绪后整页读取）。
pub(crate) fn read_dom_script(
    token: &str,
    selector: Option<&str>,
    selector_kind: &str,
    content_type: &str,
    timeout_ms: u64,
) -> String {
    let (find_expr, selector_json, selector_type_json) = match selector {
        Some(sel) => (
            format!(
                "lib.find({}, {})",
                js_str(sel),
                js_str(selector_kind_literal(selector_kind))
            ),
            js_str(sel),
            js_str(selector_kind_literal(selector_kind)),
        ),
        None => (
            "document.body".to_string(),
            "null".to_string(),
            "null".to_string(),
        ),
    };
    format!(
        r#"(() => {{
  const lib = window.__codepapr_lib;
  if (!lib) return {{ ok: false, error: 'embedded browser helper not ready' }};
  return lib.startWait({token}, {timeout_ms}, () => {{
    const el = {find_expr};
    if (!el) return undefined;
    const content = lib.read({read_target}, {content_type});
    return Object.assign({{ ok: true, content: content, selector: {selector}, selectorType: {selector_type} }}, lib.state());
  }});
}})()"#,
        token = js_str(token),
        timeout_ms = timeout_ms,
        find_expr = find_expr,
        read_target = if selector.is_some() { "el" } else { "null" },
        content_type = js_str(if content_type.eq_ignore_ascii_case("text") {
            "text"
        } else {
            "html"
        }),
        selector = selector_json,
        selector_type = selector_type_json,
    )
}

/// 元素滚动到视口中央（截图前使用，同步单阶段）。
pub(crate) fn scroll_into_view_script(selector: &str, selector_kind: &str) -> String {
    format!(
        r#"(() => {{
  try {{
    const lib = window.__codepapr_lib;
    const el = lib ? lib.find({selector}, {kind}) : null;
    if (!el) return {{ ok: false, error: 'element not found: ' + {selector} }};
    el.scrollIntoView({{ block: 'center', inline: 'center' }});
    return {{ ok: true }};
  }} catch (e) {{
    return {{ ok: false, error: String((e && e.message) || e) }};
  }}
}})()"#,
        selector = js_str(selector),
        kind = js_str(selector_kind_literal(selector_kind)),
    )
}

/// 两阶段协议的 Phase 2：查询 token 对应结果是否就绪。
pub(crate) fn poll_script(token: &str) -> String {
    format!(
        r#"(() => {{
  const lib = window.__codepapr_lib;
  if (!lib) return {{ done: false }};
  return lib.poll({token});
}})()"#,
        token = js_str(token),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_str_escapes_quotes_and_newlines() {
        assert_eq!(js_str("a\"b"), "\"a\\\"b\"");
        assert_eq!(js_str("line1\nline2"), "\"line1\\nline2\"");
        assert_eq!(js_str("</script>"), "\"</script>\"");
        assert_eq!(js_str("中文"), "\"中文\"");
    }

    #[test]
    fn js_str_escapes_backslash_and_control_chars() {
        let encoded = js_str("a\\b\u{2028}c");
        assert!(encoded.starts_with('"') && encoded.ends_with('"'));
        assert!(encoded.contains("\\\\"));
        // U+2028 是 JS 源码中的行终止符，必须被转义
        assert!(!encoded.contains('\u{2028}'));
    }

    #[test]
    fn click_script_embeds_selector_and_timeout() {
        let script = click_script("tok-1", "#go", "css", 5000);
        assert!(script.contains("\"#go\""));
        assert!(script.contains("5000"));
        assert!(script.contains("\"tok-1\""));
        assert!(script.contains("lib.startWait"));
        assert!(script.contains("lib.click(el)"));
    }

    #[test]
    fn click_script_normalizes_selector_kind() {
        let script = click_script("t", "//button", "XPath", 1000);
        assert!(script.contains("\"xpath\""));
        let script = click_script("t", "#x", "unknown", 1000);
        assert!(script.contains("\"css\""));
    }

    #[test]
    fn input_script_embeds_text_with_quotes() {
        let script = input_script("tok", "#q", "css", "he said \"hi\"", true, false, 3000);
        assert!(script.contains("\\\"hi\\\""));
        assert!(script.contains("lib.type(el"));
        assert!(script.contains("true, false"));
    }

    #[test]
    fn read_dom_script_without_selector_reads_full_page() {
        let script = read_dom_script("tok", None, "css", "text", 2000);
        assert!(script.contains("document.body"));
        assert!(script.contains("selector: null"));
        assert!(script.contains("\"text\""));
    }

    #[test]
    fn read_dom_script_with_selector_and_html() {
        let script = read_dom_script("tok", Some(".item"), "css", "html", 2000);
        assert!(script.contains("lib.find(\".item\""));
        assert!(script.contains("read(el"));
        assert!(script.contains("\"html\""));
    }

    #[test]
    fn poll_script_embeds_token() {
        let script = poll_script("tok-42");
        assert!(script.contains("\"tok-42\""));
        assert!(script.contains("lib.poll"));
    }

    #[test]
    fn scroll_script_embeds_selector() {
        let script = scroll_into_view_script("#target", "xpath");
        assert!(script.contains("\"#target\""));
        assert!(script.contains("\"xpath\""));
        assert!(script.contains("scrollIntoView"));
    }

    #[test]
    fn helper_script_is_guarded_and_defines_protocol() {
        assert!(HELPER_INIT_SCRIPT.contains("if (window.__codepapr_lib) return"));
        assert!(HELPER_INIT_SCRIPT.contains("lib.startWait"));
        assert!(HELPER_INIT_SCRIPT.contains("lib.poll"));
        assert!(HELPER_INIT_SCRIPT.contains("__codepapr_pending"));
    }

    #[test]
    fn state_script_returns_url_and_title() {
        assert!(STATE_SCRIPT.contains("location.href"));
        assert!(STATE_SCRIPT.contains("document.title"));
    }
}
