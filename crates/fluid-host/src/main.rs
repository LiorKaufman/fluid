use fluid_host::{
    commerce::{
        CommerceSource, CommerceSummary, OrderItem, OrderReview, RetailOrder, RetailOrderDetail,
        RetailOrderPage, ReviewReason,
    },
    contract,
    host::Host,
    model::{
        APP_ID, Activity, AgentSettings, AssistantSettings, Connections, Initialize, Outcome,
        Priority, ProviderConfig, ProviderId, RuntimeInfo, SCOPES, Snapshot, Status, Task,
    },
    transport::{self, Shared},
};
use fluid_protocol::{
    Capability, ExposedTool, Frontend, FrontendSummary, RpcError, ToolAnnotations, ToolInspection,
    envelope,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use ts_rs::TS;

fn export() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let mut output =
        String::from("// Generated from Rust by `npm run protocol:generate`. Do not edit.\n");
    let config = ts_rs::Config::default();
    macro_rules! declarations {($($t:ty),*)=>{$(output.push_str("export ");output.push_str(&<$t>::decl(&config));output.push('\n');)*};}
    declarations!(
        Frontend,
        FrontendSummary,
        ToolAnnotations,
        Capability,
        ExposedTool,
        ToolInspection,
        RpcError,
        Status,
        Priority,
        Task,
        ProviderId,
        ProviderConfig,
        Connections,
        AssistantSettings,
        AgentSettings,
        Outcome,
        Activity,
        RuntimeInfo,
        Snapshot,
        CommerceSource,
        OrderItem,
        ReviewReason,
        OrderReview,
        RetailOrder,
        RetailOrderDetail,
        RetailOrderPage,
        CommerceSummary
    );
    std::fs::create_dir_all("src/protocol")?;
    std::fs::write("src/protocol/generated.ts", output)?;
    std::fs::write(
        "src/protocol/contract.json",
        serde_json::to_string_pretty(&contract::contract())? + "\n",
    )?;
    std::fs::write(
        "src/protocol/defaults.json",
        serde_json::to_string_pretty(
            &json!({"appId":APP_ID,"protocol":fluid_protocol::VERSION,"permissions":SCOPES,"assistant":AssistantSettings::default(),"limits":{"htmlUnits":fluid_protocol::MAX_HTML_UNITS,"requestBytes":fluid_protocol::MAX_REQUEST_BYTES}}),
        )? + "\n",
    )?;
    Ok(())
}
fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    match std::env::args().nth(1).as_deref() {
        Some("export") => export(),
        Some("mcp") => transport::stdio_client(),
        _ => tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?
            .block_on(serve()),
    }
}
async fn serve() -> std::result::Result<(), Box<dyn std::error::Error>> {
    use std::future::IntoFuture;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let first = lines
        .next_line()
        .await?
        .ok_or("Expected host initialization")?;
    let request: Value = serde_json::from_str(&first)?;
    let id = request["id"].clone();
    let init = serde_json::from_value::<Initialize>(request["args"][0].clone());
    let result = init
        .map_err(|e| RpcError::new("INVALID_INPUT", e.to_string()))
        .and_then(Host::open);
    let mut stdout = tokio::io::stdout();
    let host = match result {
        Ok(host) => host,
        Err(error) => {
            fluid_host::diagnostics::report(&error);
            stdout
                .write_all(format!("{}\n", json!({"id":id,"ok":false,"error":error})).as_bytes())
                .await?;
            return Ok(());
        }
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let (sender, mut receiver) = mpsc::unbounded_channel::<Value>();
    let state = Shared {
        host: Arc::new(Mutex::new(host)),
        token: token.clone(),
        port,
        events: sender.clone(),
    };
    let server =
        tokio::spawn(axum::serve(listener, transport::router(state.clone())).into_future());
    let writer = tokio::spawn(async move {
        while let Some(value) = receiver.recv().await {
            if stdout
                .write_all(format!("{value}\n").as_bytes())
                .await
                .is_err()
            {
                break;
            }
            let _ = stdout.flush().await;
        }
    });
    sender.send(json!({"id":id,"ok":true,"value":{"url":format!("http://127.0.0.1:{port}"),"mcpUrl":format!("http://127.0.0.1:{port}/mcp"),"discoveryUrl":format!("http://127.0.0.1:{port}/.well-known/fluid"),"token":token,"engine":"Rust"}}))?;
    while let Some(line) = lines.next_line().await? {
        if line.len() > fluid_protocol::MAX_REQUEST_BYTES {
            let id = serde_json::from_str::<Value>(&line)
                .ok()
                .map(|request| request["id"].clone());
            sender.send(json!({"id":id,"ok":false,"error":{"code":"INVALID_INPUT","message":"Request exceeds the 4 MiB wire limit."}}))?;
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = request["id"].clone();
        let result = if let (Some(method), Some(args)) =
            (request["method"].as_str(), request["args"].as_array())
        {
            state.execute(method.to_owned(), args.clone()).await
        } else {
            Err(RpcError::new("INVALID_INPUT", "Expected method and args."))
        };
        let mut reply = envelope(result);
        reply["id"] = id;
        sender.send(reply)?;
    }
    server.abort();
    writer.abort();
    drop(state);
    drop(sender);
    let _ = server.await;
    let _ = writer.await;
    Ok(())
}
