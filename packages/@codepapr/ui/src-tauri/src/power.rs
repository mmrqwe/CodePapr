//! Sleep/display-sleep prevention while the agent is working.
//!
//! WKWebView silently terminates Web Workers when the display sleeps (the
//! page is frozen and the worker is killed mid-request — no JS error event
//! fires, the turn just dies) and likewise across system sleep/wake cycles.
//! While a turn is in flight we therefore hold TWO assertions:
//!  - `PreventUserIdleDisplaySleep`: keeps the screen on (display sleep was
//!    the observed kill trigger, not system sleep);
//!  - `NoIdleSleepAssertion`: keeps the system from idle-sleeping.
//! Lid-close sleep is NOT blocked by either — crash recovery (heartbeat +
//! auto-rebuild) covers that case.
//!
//! Reference-counted: multiple UI holders (chat turn, app-agent runs) may
//! overlap; the assertions are created on the first acquire and released
//! when the last holder lets go. Non-macOS platforms are no-ops.

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
            // SAFETY: `c_string` is a live NUL-terminated C string whose
            // pointer remains valid for the call; `null()` selects the
            // default allocator, and the returned CFString is non-owning
            // (we hold `c_string` until the CF string's first use).
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
        assertion_ids: Vec<IOPMAssertionId>,
    }

    static STATE: Mutex<SleepBlockState> = Mutex::new(SleepBlockState {
        holders: 0,
        assertion_ids: Vec::new(),
    });

    fn create_assertion(assertion_type: &str) -> Result<IOPMAssertionId, String> {
        let type_ref = cf_string(assertion_type)?;
        let name_ref = match cf_string("CodePapr agent turn in progress") {
            Ok(name_ref) => name_ref,
            Err(err) => {
                // SAFETY: `type_ref` is a valid CFStringRef returned by
                // `cf_string` above and not yet released.
                unsafe { CFRelease(type_ref) };
                return Err(err);
            }
        };
        let mut assertion_id: IOPMAssertionId = 0;
        let result = unsafe {
            // SAFETY: `type_ref`/`name_ref` are live CFStringRefs; 
            // `assertion_id` is a valid writable pointer to a u32.
            IOPMAssertionCreateWithName(
                type_ref,
                K_IOPM_ASSERTION_LEVEL_ON,
                name_ref,
                &mut assertion_id,
            )
        };
        unsafe {
            // SAFETY: both references are still live here; CFRelease is
            // balanced with the +1 retains from `cf_string`.
            CFRelease(type_ref);
            CFRelease(name_ref);
        }
        if result != K_IORETURN_SUCCESS {
            return Err(format!(
                "IOPMAssertionCreateWithName({assertion_type}) 失败: 0x{result:08x}"
            ));
        }
        Ok(assertion_id)
    }

    pub fn acquire() -> Result<(), String> {
        let mut state = STATE.lock().map_err(|err| err.to_string())?;
        if state.assertion_ids.is_empty() {
            let display_id = create_assertion("PreventUserIdleDisplaySleep")?;
            let idle_id = match create_assertion("NoIdleSleepAssertion") {
                Ok(id) => id,
                Err(err) => {
                    // SAFETY: `display_id` is a live assertion created by
                    // `create_assertion` on the line above.
                    unsafe { IOPMAssertionRelease(display_id) };
                    return Err(err);
                }
            };
            state.assertion_ids = vec![display_id, idle_id];
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
            let mut first_error: Option<String> = None;
            for assertion_id in state.assertion_ids.drain(..) {
                // SAFETY: every id in `assertion_ids` was produced by a
                // successful `create_assertion` and released exactly once
                // here (ids are drained, never released twice).
                let result = unsafe { IOPMAssertionRelease(assertion_id) };
                if result != K_IORETURN_SUCCESS && first_error.is_none() {
                    first_error = Some(format!("IOPMAssertionRelease 失败: 0x{result:08x}"));
                }
            }
            if let Some(err) = first_error {
                return Err(err);
            }
        }
        Ok(())
    }

    /// Drop any held assertions (process exit path).
    pub fn release_all() {
        if let Ok(mut state) = STATE.lock() {
            for assertion_id in state.assertion_ids.drain(..) {
                // SAFETY: same invariant as `release()` — ids are live
                // assertions created by `create_assertion`, drained exactly
                // once (process exit path).
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
