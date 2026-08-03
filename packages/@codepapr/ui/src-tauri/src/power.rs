//! Idle-sleep prevention while the agent is working.
//!
//! macOS idle-sleep suspends the WKWebView Web Content process; across
//! sleep/wake cycles WebKit silently terminates Web Workers, killing the
//! agent runtime mid-turn (no JS error event is fired, so the turn just
//! hangs). While a turn is in flight we therefore hold a
//! `NoIdleSleepAssertion` so the machine stays awake. Lid-close sleep is NOT
//! blocked by this assertion type — only idle sleep is.
//!
//! Reference-counted: multiple UI holders (chat turn, app-agent runs) may
//! overlap; the system assertion is created on the first acquire and
//! released when the last holder lets go. Non-macOS platforms are no-ops.

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_char, c_void};
    use std::os::raw::c_uint;
    use std::sync::Mutex;

    type IOPMAssertionId = c_uint;
    type IOReturn = i32;
    type CFStringRef = *const c_void;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_IOPM_ASSERTION_LEVEL_ON: u32 = 255;
    const K_IORETURN_SUCCESS: IOReturn = 0;

    #[link(name = "CoreFoundation", kind = "framework")]
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            cstr: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFRelease(cf: CFStringRef);
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            assertion_level: u32,
            assertion_name: CFStringRef,
            assertion_id: *mut IOPMAssertionId,
        ) -> IOReturn;
        fn IOPMAssertionRelease(assertion_id: IOPMAssertionId) -> IOReturn;
    }

    fn cf_string(value: &str) -> Result<CFStringRef, String> {
        let trimmed = value.trim_end_matches('\0');
        let c_string = std::ffi::CString::new(trimmed)
            .map_err(|err| format!("无效的断言名称: {err}"))?;
        let cf = unsafe {
            CFStringCreateWithCString(
                std::ptr::null(),
                c_string.as_ptr(),
                K_CF_STRING_ENCODING_UTF8,
            )
        };
        if cf.is_null() {
            return Err("创建 CFString 失败".to_string());
        }
        Ok(cf)
    }

    struct SleepBlockState {
        holders: u32,
        assertion_id: Option<IOPMAssertionId>,
    }

    static STATE: Mutex<SleepBlockState> = Mutex::new(SleepBlockState {
        holders: 0,
        assertion_id: None,
    });

    pub fn acquire() -> Result<(), String> {
        let mut state = STATE.lock().map_err(|err| err.to_string())?;
        if state.assertion_id.is_none() {
            // "NoIdleSleepAssertion" blocks idle sleep only; the user can
            // still force sleep (lid close / Apple menu).
            let assertion_type = cf_string("NoIdleSleepAssertion")?;
            let assertion_name = cf_string("CodePapr agent turn in progress")?;
            let mut assertion_id: IOPMAssertionId = 0;
            let result = unsafe {
                IOPMAssertionCreateWithName(
                    assertion_type,
                    K_IOPM_ASSERTION_LEVEL_ON,
                    assertion_name,
                    &mut assertion_id,
                )
            };
            unsafe {
                CFRelease(assertion_type);
                CFRelease(assertion_name);
            }
            if result != K_IORETURN_SUCCESS {
                return Err(format!("IOPMAssertionCreateWithName 失败: 0x{result:08x}"));
            }
            state.assertion_id = Some(assertion_id);
        }
        state.holders = state.holders.saturating_add(1);
        Ok(())
    }

    pub fn release() -> Result<(), String> {
        let mut state = STATE.lock().map_err(|err| err.to_string())?;
        if state.holders == 0 {
            // Unbalanced release: tolerate silently (UI best-effort callers).
            return Ok(());
        }
        state.holders -= 1;
        if state.holders == 0 {
            if let Some(assertion_id) = state.assertion_id.take() {
                let result = unsafe { IOPMAssertionRelease(assertion_id) };
                if result != K_IORETURN_SUCCESS {
                    return Err(format!("IOPMAssertionRelease 失败: 0x{result:08x}"));
                }
            }
        }
        Ok(())
    }

    /// Drop any held assertion (process exit path).
    pub fn release_all() {
        if let Ok(mut state) = STATE.lock() {
            if let Some(assertion_id) = state.assertion_id.take() {
                unsafe {
                    IOPMAssertionRelease(assertion_id);
                }
            }
            state.holders = 0;
        }
    }

    #[cfg(test)]
    pub fn holders_for_test() -> u32 {
        STATE.lock().map(|s| s.holders).unwrap_or(0)
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn prevent_idle_sleep() -> Result<(), String> {
    macos::acquire()
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn allow_idle_sleep() -> Result<(), String> {
    macos::release()
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn prevent_idle_sleep() -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn allow_idle_sleep() -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn release_all() {}

#[cfg(target_os = "macos")]
pub fn release_all() {
    macos::release_all();
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::macos;

    #[test]
    fn acquire_release_is_refcounted_and_round_trips() {
        // Start from a clean slate (other tests may have left holders).
        macos::release_all();
        assert_eq!(macos::holders_for_test(), 0);

        macos::acquire().expect("first acquire should succeed");
        assert_eq!(macos::holders_for_test(), 1);

        macos::acquire().expect("second acquire should succeed");
        assert_eq!(macos::holders_for_test(), 2);

        macos::release().expect("first release should succeed");
        assert_eq!(macos::holders_for_test(), 1);

        macos::release().expect("second release should succeed");
        assert_eq!(macos::holders_for_test(), 0);

        // Unbalanced release must not error or go negative.
        macos::release().expect("unbalanced release should be tolerated");
        assert_eq!(macos::holders_for_test(), 0);
    }
}
