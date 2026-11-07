use fluid_protocol::{Frontend, FrontendSummary};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use ts_rs::TS;

pub const APP_ID: &str = "org.fluidprotocol.workspace";
pub const SCOPES: &[&str] = &[
    "tasks:read",
    "tasks:write",
    "tasks:delete",
    "frontends:read",
    "frontends:write",
    "orders:read",
    "reviews:write",
];

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Todo,
    InProgress,
    Done,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Low,
    Medium,
    High,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub notes: String,
    pub project: String,
    pub status: Status,
    pub priority: Priority,
    pub due_date: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    Auto,
    Codex,
    Claude,
    Openai,
    Anthropic,
    Compatible,
    Ollama,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub base_url: String,
    pub model: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Connections {
    pub openai: ProviderConfig,
    pub anthropic: ProviderConfig,
    pub compatible: ProviderConfig,
    pub ollama: ProviderConfig,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSettings {
    pub helper_visible: bool,
    pub provider: ProviderId,
    pub connections: Connections,
}
impl Default for AssistantSettings {
    fn default() -> Self {
        let config = |base: &str| ProviderConfig {
            base_url: base.into(),
            model: String::new(),
        };
        Self {
            helper_visible: true,
            provider: ProviderId::Auto,
            connections: Connections {
                openai: config("https://api.openai.com/v1"),
                anthropic: config("https://api.anthropic.com/v1"),
                compatible: config("http://127.0.0.1:1234/v1"),
                ollama: config("http://127.0.0.1:11434"),
            },
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentSettings {
    pub enabled: bool,
    pub permissions: Vec<String>,
}
impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            permissions: vec!["tasks:read".into(), "tasks:write".into()],
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Allowed,
    Denied,
    System,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Activity {
    pub id: String,
    pub at: String,
    pub frontend: String,
    pub action: String,
    pub outcome: Outcome,
    pub detail: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub engine: String,
    pub storage: String,
    pub protocol_source: String,
    pub schema_version: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[ts(type = "number")]
    pub revision: u64,
    pub active_id: String,
    pub canvas_mode: bool,
    pub frontends: Vec<FrontendSummary>,
    #[ts(type = "Record<string, FrontendSummary[]>")]
    pub history: BTreeMap<String, Vec<FrontendSummary>>,
    #[ts(type = "Record<string, string[]>")]
    pub grants: BTreeMap<String, Vec<String>>,
    pub activity: Vec<Activity>,
    pub agent: AgentSettings,
    pub assistant: AssistantSettings,
    pub runtime: RuntimeInfo,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Initialize {
    pub frontends: Vec<Frontend>,
    pub tasks: Vec<Task>,
    pub data_path: Option<String>,
    pub legacy_path: Option<String>,
    pub legacy_state: Option<Value>,
}
