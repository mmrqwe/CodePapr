//! Poison-safe lock helpers.
//!
//! A standard `.lock().unwrap()` panics when another thread panicked while
//! holding the lock (poisoning). In a long-lived desktop app, panicking the
//! whole process over a poisoned shared state is needlessly fatal — the state
//! itself is still intact, only the panic payload is lost. These helpers
//! recover the guard via `into_inner()` so the caller can continue with a
//! consistent view instead of crashing.

use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn read<T>(m: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    m.read().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn write<T>(m: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    m.write().unwrap_or_else(|e| e.into_inner())
}
