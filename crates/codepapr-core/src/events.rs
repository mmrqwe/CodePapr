use serde_json::Value;
use std::sync::Arc;

/// Generic event sink for forwarding events to UI or IPC clients.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: Value);
}

#[derive(Clone, Default)]
pub struct NoopEventSink;

impl EventSink for NoopEventSink {
    fn emit(&self, _event: &str, _payload: Value) {}
}

#[derive(Clone)]
pub struct FnEventSink<F: Fn(&str, Value) + Send + Sync + 'static>(pub F);

impl<F: Fn(&str, Value) + Send + Sync + 'static> EventSink for FnEventSink<F> {
    fn emit(&self, event: &str, payload: Value) {
        (self.0)(event, payload);
    }
}

pub type SharedEventSink = Arc<dyn EventSink>;
