use crate::{diagnostics, host::Host, model::APP_ID};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use fluid_protocol::{RpcError, envelope};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use subtle::ConstantTimeEq;
use tokio::sync::mpsc;

#[derive(Clone)]
pub struct Shared {
    pub host: Arc<Mutex<Host>>,
    pub token: String,
    pub port: u16,
    pub events: mpsc::UnboundedSender<Value>,
}
impl Shared {
    pub async fn execute(&self, method: String, args: Vec<Value>) -> fluid_protocol::Result<Value> {
        let state = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut host = state
                .host
                .lock()
                .map_err(|_| RpcError::new("HOST_FAILED", "The native host is unavailable."))?;
            let before = host.revision()?;
            let result = host.dispatch(&method, &args);
            if let Err(error) = &result {
                diagnostics::report(error);
            }
            if host.revision()? != before {
                let _ = state.events.send(json!({"event":"changed"}));
            }
            result
        })
        .await
        .map_err(|_| RpcError::new("HOST_FAILED", "The native request could not finish."))?
    }
}
fn response(status: StatusCode, value: Value) -> Response {
    (
        status,
        [
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
        ],
        Json(value),
    )
        .into_response()
}
fn authenticate(
    state: &Shared,
    headers: &HeaderMap,
    required: bool,
) -> std::result::Result<(), (StatusCode, &'static str)> {
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let expected = format!("127.0.0.1:{}", state.port);
    let alternate = format!("localhost:{}", state.port);
    if host != expected && host != alternate {
        return Err((StatusCode::FORBIDDEN, "Invalid local host"));
    }
    if let Some(origin) = headers.get("origin") {
        let origin = origin.to_str().unwrap_or("");
        if origin != format!("http://{host}") {
            return Err((StatusCode::FORBIDDEN, "Cross-origin access is disabled"));
        }
    }
    if required {
        let token = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or("");
        if token.as_bytes().ct_eq(state.token.as_bytes()).unwrap_u8() != 1 {
            return Err((StatusCode::UNAUTHORIZED, "Invalid agent token"));
        }
    }
    Ok(())
}
async fn discovery(State(state): State<Shared>, headers: HeaderMap) -> Response {
    if let Err(error) = authenticate(&state, &headers, false) {
        return response(error.0, json!({"error":error.1}));
    }
    response(
        StatusCode::OK,
        json!({"protocol":"fluid-app","version":fluid_protocol::VERSION,"appId":APP_ID,"engine":"Rust","mcpUrl":format!("http://127.0.0.1:{}/mcp",state.port),"authorization":"Bearer token supplied by the user through Connect an agent","transports":["streamable-http","stdio"],"tools":"Enable agent access and choose permissions in the app. tools/list returns only callable tools."}),
    )
}
async fn unsupported(State(state): State<Shared>, headers: HeaderMap) -> Response {
    if let Err(error) = authenticate(&state, &headers, true) {
        return response(error.0, json!({"error":error.1}));
    }
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}
async fn legacy(State(state): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    if let Err(error) = authenticate(&state, &headers, true) {
        return response(error.0, json!({"error":error.1}));
    }
    let value: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return response(
                StatusCode::BAD_REQUEST,
                envelope(Err(RpcError::new("INVALID_INPUT", "Expected JSON."))),
            );
        }
    };
    if value["method"] != "call" {
        return response(
            StatusCode::BAD_REQUEST,
            envelope(Err(RpcError::new(
                "UNKNOWN_METHOD",
                "Agents may only invoke capabilities.",
            ))),
        );
    }
    let args = value["args"].as_array().cloned().unwrap_or_default();
    let result = state.execute("callAgent".into(), args).await;
    response(
        if result.is_ok() {
            StatusCode::OK
        } else {
            StatusCode::BAD_REQUEST
        },
        envelope(result),
    )
}
fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
async fn mcp(State(state): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    if let Err(error) = authenticate(&state, &headers, true) {
        return response(error.0, json!({"error":error.1}));
    }
    let request: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return response(
                StatusCode::BAD_REQUEST,
                rpc_error(Value::Null, -32700, "Invalid JSON"),
            );
        }
    };
    if request["jsonrpc"] != "2.0" || !request["method"].is_string() {
        return response(
            StatusCode::BAD_REQUEST,
            rpc_error(
                request["id"].clone(),
                -32600,
                "Expected a JSON-RPC 2.0 request",
            ),
        );
    }
    if request.get("id").is_none() {
        return StatusCode::ACCEPTED.into_response();
    }
    let id = request["id"].clone();
    let result = match request["method"].as_str().unwrap() {
        "initialize" => Ok(
            json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fluid-workspace","version":env!("CARGO_PKG_VERSION")},"instructions":"The user controls every grant. Use frontends.get to read source; publish with expectedVersion, then activate. New frontends have zero grants until the user approves them in the app."}),
        ),
        "ping" => Ok(json!({})),
        "tools/list" => match state
            .execute("tools.inspect".into(), vec![json!("external-agent")])
            .await
        {
            Ok(inspection) if inspection["enabled"] == true => {
                let tools:Vec<_>=inspection["tools"].as_array().unwrap().iter().filter(|t|t["exposed"]==true).map(|t|json!({"name":t["name"],"description":t["description"],"inputSchema":t["inputSchema"],"annotations":t["annotations"]})).collect();
                Ok(json!({"tools":tools}))
            }
            Ok(_) => Err(RpcError::new(
                "AGENT_DISABLED",
                "External agent access is disabled.",
            )),
            Err(error) => Err(error),
        },
        "tools/call" => {
            let params = &request["params"];
            match state
                .execute(
                    "callAgent".into(),
                    vec![
                        params["name"].clone(),
                        params.get("arguments").cloned().unwrap_or(json!({})),
                    ],
                )
                .await
            {
                Ok(value) => Ok(
                    json!({"content":[{"type":"text","text":value.to_string()}],"isError":false}),
                ),
                Err(error) => Ok(
                    json!({"content":[{"type":"text","text":format!("{}: {}",error.code,error.message)}],"isError":true}),
                ),
            }
        }
        _ => return response(StatusCode::OK, rpc_error(id, -32601, "Method not found")),
    };
    response(
        StatusCode::OK,
        match result {
            Ok(value) => json!({"jsonrpc":"2.0","id":id,"result":value}),
            Err(error) => {
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":error.message,"data":{"code":error.code}}})
            }
        },
    )
}
pub fn router(state: Shared) -> Router {
    Router::new()
        .route("/.well-known/fluid", get(discovery))
        .route("/mcp", post(mcp).get(unsupported).delete(unsupported))
        .route("/__fluid/agent", post(legacy))
        .layer(DefaultBodyLimit::max(fluid_protocol::MAX_REQUEST_BYTES))
        .with_state(state)
}

/// MCP stdio transport relaying JSON-RPC to the running app's native HTTP host.
pub fn stdio_client() -> std::result::Result<(), Box<dyn std::error::Error>> {
    use std::io::{BufRead, Write};
    let url = std::env::var("FLUID_URL")?;
    let token = std::env::var("FLUID_AGENT_TOKEN")?;
    let parsed = reqwest::Url::parse(&url)?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return Err("FLUID_URL must be the app's 127.0.0.1 connection URL".into());
    }
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let mut output = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        if line.len() > fluid_protocol::MAX_REQUEST_BYTES {
            return Err("MCP request exceeds the size limit".into());
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                writeln!(output, "{}", rpc_error(Value::Null, -32700, "Invalid JSON"))?;
                output.flush()?;
                continue;
            }
        };
        if request.get("id").is_none() {
            continue;
        }
        let id = request["id"].clone();
        let result = client
            .post(format!("{}/mcp", url.trim_end_matches('/')))
            .bearer_auth(&token)
            .header("Accept", "application/json, text/event-stream")
            .json(&request)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json::<Value>());
        let response = match result {
            Ok(value) => value,
            Err(_) => rpc_error(
                id,
                -32000,
                "Cannot reach the running app. Check its connection token and keep Fluid open.",
            ),
        };
        writeln!(output, "{response}")?;
        output.flush()?;
    }
    Ok(())
}
