use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct PaprIPCRequest {
    #[serde(rename = "__papr")]
    pub is_papr: bool,
    #[serde(rename = "reqId")]
    pub req_id: String,
    #[serde(rename = "type")]
    pub request_type: String,
    pub payload: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct PaprIPCResponse {
    #[serde(rename = "__papr")]
    pub is_papr: bool,
    #[serde(rename = "reqId")]
    pub req_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<PaprIPCError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct PaprIPCError {
    pub code: String,
    pub message: String,
}
