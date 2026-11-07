//! App-independent Fluid wire contract. Clients are language- and renderer-neutral.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

pub const VERSION: &str = "0.1";
pub const MAX_HTML_UNITS: usize = 500_000;
/// Accommodates UTF-8, worst-case JSON escaping, and manifest overhead.
pub const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Frontend {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_author")]
    pub author: String,
    #[serde(default)]
    pub version: u32,
    pub protocol: String,
    pub app_id: String,
    pub permissions: Vec<String>,
    pub html: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub builtin: Option<bool>,
    #[serde(default)]
    pub updated_at: String,
}
fn default_author() -> String {
    "You".into()
}

/// Interface metadata carried in workspace snapshots without executable source.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FrontendSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub author: String,
    pub version: u32,
    pub protocol: String,
    pub app_id: String,
    pub permissions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub builtin: Option<bool>,
    pub updated_at: String,
}

impl From<&Frontend> for FrontendSummary {
    fn from(frontend: &Frontend) -> Self {
        Self {
            id: frontend.id.clone(),
            name: frontend.name.clone(),
            description: frontend.description.clone(),
            author: frontend.author.clone(),
            version: frontend.version,
            protocol: frontend.protocol.clone(),
            app_id: frontend.app_id.clone(),
            permissions: frontend.permissions.clone(),
            builtin: frontend.builtin,
            updated_at: frontend.updated_at.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolAnnotations {
    pub read_only_hint: bool,
    pub destructive_hint: bool,
    pub open_world_hint: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub name: String,
    pub description: String,
    pub permission: Option<String>,
    #[ts(type = "Record<string, unknown>")]
    pub input_schema: Value,
    #[ts(type = "Record<string, unknown>")]
    pub output_schema: Value,
    pub annotations: ToolAnnotations,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExposedTool {
    #[serde(flatten)]
    #[ts(flatten)]
    pub capability: Capability,
    pub exposed: bool,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolInspection {
    pub client_id: String,
    pub name: String,
    pub enabled: bool,
    pub grants: Vec<String>,
    pub tools: Vec<ExposedTool>,
    pub transports: Vec<String>,
    pub engine: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RpcError {
    pub code: String,
    pub message: String,
    #[serde(skip)]
    #[ts(skip)]
    source: Option<std::sync::Arc<dyn std::error::Error + Send + Sync>>,
}
impl RpcError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            source: None,
        }
    }
    /// Retains a diagnostic cause internally without exposing it on the wire.
    pub fn with_source(mut self, source: impl std::error::Error + Send + Sync + 'static) -> Self {
        self.source = Some(std::sync::Arc::new(source));
        self
    }
}
impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for RpcError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source.as_deref().map(|source| source as _)
    }
}
pub type Result<T> = std::result::Result<T, RpcError>;

/// Tokens and host-management methods never belong to a frontend invocation.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Invocation {
    pub capability: String,
    #[serde(default)]
    pub input: Value,
}

pub fn envelope(result: Result<Value>) -> Value {
    match result {
        Ok(value) => serde_json::json!({ "ok": true, "value": value }),
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    }
}
