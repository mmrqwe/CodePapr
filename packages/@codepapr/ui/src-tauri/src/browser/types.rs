use headless_chrome::{
    browser::tab::Tab, protocol::cdp::Page::CaptureScreenshotFormatOption, Browser,
};
use serde::Serialize;
use std::sync::Arc;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenBrowserResult {
    pub(crate) target: String,
    pub(crate) kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPageSessionResult {
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) workspace_path: String,
    pub(crate) started_at: i64,
    pub(crate) active: bool,
    /// 导航未等到 load 事件但页面对象仍可探测时的降级说明；无警告为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) navigation_warning: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPageActionResult {
    pub(crate) action: String,
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) selector: Option<String>,
    pub(crate) selector_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) navigation_warning: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPageDomResult {
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) selector: Option<String>,
    pub(crate) selector_type: Option<String>,
    pub(crate) content_type: String,
    pub(crate) content: String,
    pub(crate) truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPageScreenshotResult {
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) path: String,
    pub(crate) bytes: usize,
    pub(crate) format: String,
    pub(crate) selector: Option<String>,
    pub(crate) selector_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPageCloseResult {
    pub(crate) workspace_path: String,
    pub(crate) closed: bool,
}

pub(crate) struct ManagedBrowserPageSession {
    pub(crate) _browser: Browser,
    pub(crate) tab: Arc<Tab>,
    pub(crate) workspace_path: String,
    pub(crate) started_at: i64,
}

#[derive(Clone, Copy)]
pub(crate) enum BrowserSelectorKind {
    Css,
    XPath,
}

impl BrowserSelectorKind {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Css => "css",
            Self::XPath => "xpath",
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum BrowserDomContentType {
    Html,
    Text,
}

impl BrowserDomContentType {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Text => "text",
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum BrowserScreenshotFormat {
    Png,
    Jpeg,
}

impl BrowserScreenshotFormat {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpeg",
        }
    }

    pub(crate) fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
        }
    }

    pub(crate) fn capture_format(self) -> CaptureScreenshotFormatOption {
        match self {
            Self::Png => CaptureScreenshotFormatOption::Png,
            Self::Jpeg => CaptureScreenshotFormatOption::Jpeg,
        }
    }
}
