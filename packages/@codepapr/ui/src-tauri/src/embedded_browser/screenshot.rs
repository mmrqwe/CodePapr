//! 内置浏览器截图：macOS WKWebView.takeSnapshot + NSBitmapImageRep 编码。
//!
//! CodePaprMac 仅支持 macOS；其他平台返回明确错误，不做 WebView2/webkit2gtk 移植。

use std::time::Duration;

use crate::browser::types::BrowserScreenshotFormat;

const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(30);

#[cfg(target_os = "macos")]
pub(crate) async fn capture_webview_screenshot(
    webview: tauri::Webview<tauri::Wry>,
    format: BrowserScreenshotFormat,
) -> Result<Vec<u8>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();

    webview
        .with_webview(move |platform_webview| {
            use block2::RcBlock;
            use objc2::MainThreadMarker;
            use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

            let view = unsafe {
                // SAFETY: `ptr` comes from `platform_webview.inner()`, is
                // null-checked below, and the underlying WKWebView outlives
                // this closure (tauri keeps it alive for the callback).
                let ptr = platform_webview.inner();
                if ptr.is_null() {
                    let _ = tx.send(Err("WKWebView 句柄为空".to_string()));
                    return;
                }
                &*(ptr as *const WKWebView)
            };

            let Some(mtm) = MainThreadMarker::new() else {
                let _ = tx.send(Err("当前不在主线程，无法截图".to_string()));
                return;
            };
            // SAFETY: `mtm` proves we are on the main thread, which
            // `WKSnapshotConfiguration::new` requires.
            let config = unsafe { WKSnapshotConfiguration::new(mtm) };

            // 完成回调在主线程 runloop 触发，直接把编码结果送回异步等待方。
            // RcBlock 要求 Fn（可能多次调用），用 Mutex<Option> 保证只发送一次。
            let tx_slot = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
            let tx_clone = std::sync::Arc::clone(&tx_slot);
            let block = RcBlock::new(
                move |image: *mut objc2_app_kit::NSImage, error: *mut objc2_foundation::NSError| {
                    if let Some(tx) = tx_clone.lock().ok().and_then(|mut guard| guard.take()) {
                        let _ = tx.send(encode_snapshot(image, error, format));
                    }
                },
            );
            // SAFETY: `view` is a valid WKWebView reference, `config` is a
            // valid WKSnapshotConfiguration, and `block` is an objc2
            // RcBlock kept alive through the asynchronous completion call.
            unsafe {
                view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block);
            }
        })
        .map_err(|err| format!("访问平台 WebView 失败: {err}"))?;

    tokio::time::timeout(SCREENSHOT_TIMEOUT, rx)
        .await
        .map_err(|_| "截图超时".to_string())?
        .map_err(|_| "截图通道已关闭".to_string())?
}

#[cfg(target_os = "macos")]
fn encode_snapshot(
    image: *mut objc2_app_kit::NSImage,
    error: *mut objc2_foundation::NSError,
    format: BrowserScreenshotFormat,
) -> Result<Vec<u8>, String> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::NSDictionary;

    if image.is_null() {
        let message = if error.is_null() {
            "未知原因".to_string()
        } else {
            // SAFETY: `error` is non-null here (checked above) and valid for
            // the duration of the completion callback.
            unsafe { (*error).localizedDescription().to_string() }
        };
        return Err(format!("页面截图失败: {message}"));
    }

    // SAFETY: `image` is non-null (checked above) and a valid NSImage
    // owned by the completion callback for the duration of this function.
    let image = unsafe { &*image };
    let cg_image = unsafe {
        // SAFETY: `image` is a valid NSImage reference; passing a null
        // proposed-rect and no hints is the documented no-options form.
        image
            .CGImageForProposedRect_context_hints(std::ptr::null_mut(), None, None)
            .ok_or_else(|| "截图位图转换为空".to_string())?
    };

    use objc2::AnyThread;
    let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg_image);
    let properties = NSDictionary::new();
    let storage_type = match format {
        BrowserScreenshotFormat::Png => NSBitmapImageFileType::PNG,
        BrowserScreenshotFormat::Jpeg => NSBitmapImageFileType::JPEG,
    };
    let data = unsafe {
        // SAFETY: `rep` is a valid NSBitmapImageRep and `properties` a valid
        // NSDictionary; both are ObjC objects owned by this stack frame.
        rep.representationUsingType_properties(storage_type, &properties)
            .ok_or_else(|| "截图编码失败".to_string())?
    };
    Ok(data.to_vec())
}

#[cfg(not(target_os = "macos"))]
pub(crate) async fn capture_webview_screenshot(
    _webview: tauri::Webview<tauri::Wry>,
    _format: BrowserScreenshotFormat,
) -> Result<Vec<u8>, String> {
    Err("当前平台暂不支持内置浏览器截图（仅 macOS）".to_string())
}
