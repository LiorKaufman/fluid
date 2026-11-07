//! One authoritative execution path for desktop, arbitrary frontends, and agents.
use crate::model::{
    APP_ID, Activity, AgentSettings, AssistantSettings, Initialize, Outcome, Priority, RuntimeInfo,
    SCOPES, Snapshot, Status, Task,
};
use crate::{commerce, contract, diagnostics::storage_error, input};
use chrono::{NaiveDate, Utc};
use fluid_protocol::{
    Capability, ExposedTool, Frontend, FrontendSummary, MAX_HTML_UNITS, Result, RpcError,
    ToolInspection, VERSION,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::Path,
};
use uuid::Uuid;

fn err(code: &str, message: impl Into<String>) -> RpcError {
    RpcError::new(code, message)
}
fn encode(value: &impl Serialize) -> Result<String> {
    serde_json::to_string(value).map_err(storage_error)
}
fn decode<T: DeserializeOwned>(value: &str) -> Result<T> {
    serde_json::from_str(value).map_err(|_| {
        err(
            "INVALID_STATE",
            "Saved workspace data is invalid; the original has been preserved.",
        )
    })
}
fn meta<T: DeserializeOwned>(db: &Connection, key: &str) -> Result<T> {
    let value: String = db
        .query_row("SELECT value FROM metadata WHERE key=?1", [key], |row| {
            row.get(0)
        })
        .map_err(storage_error)?;
    decode(&value)
}

fn set_meta(db: &Connection, key: &str, value: &impl Serialize) -> Result<()> {
    db.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,encode(value)?]).map_err(storage_error)?;
    Ok(())
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn uuid() -> String {
    Uuid::new_v4().to_string()
}
fn scopes(value: &Value) -> Result<Vec<String>> {
    let values: Vec<String> = serde_json::from_value(value.clone())
        .map_err(|_| err("INVALID_INPUT", "Expected a list of permission scopes."))?;
    if values.iter().any(|scope| !SCOPES.contains(&scope.as_str())) {
        return Err(err("INVALID_INPUT", "Unknown permission scope."));
    }
    let mut result = values;
    result.sort();
    result.dedup();
    Ok(result)
}
fn set_grants(db: &Connection, id: &str, grants: &[String]) -> Result<()> {
    db.execute("DELETE FROM grants WHERE client=?1", [id])
        .map_err(storage_error)?;
    for scope in grants {
        db.execute(
            "INSERT INTO grants(client,scope) VALUES(?1,?2)",
            params![id, scope],
        )
        .map_err(storage_error)?;
    }
    Ok(())
}
fn log(db: &Connection, frontend: &str, action: &str, detail: &str, outcome: &str) -> Result<()> {
    db.execute(
        "INSERT INTO activity(id,at,frontend,action,detail,outcome) VALUES(?1,?2,?3,?4,?5,?6)",
        params![uuid(), now(), frontend, action, detail, outcome],
    )
    .map_err(storage_error)?;
    db.execute("DELETE FROM activity WHERE rowid NOT IN (SELECT rowid FROM activity ORDER BY rowid DESC LIMIT 150)", []).map_err(storage_error)?;
    Ok(())
}
fn task_insert(db: &Connection, task: &Task, position: i64) -> Result<()> {
    let status = serde_json::to_value(&task.status).unwrap();
    let priority = serde_json::to_value(&task.priority).unwrap();
    db.execute("INSERT INTO tasks(id,title,notes,project,status,priority,due_date,created_at,updated_at,position,search_text) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![task.id,task.title,task.notes,task.project,status.as_str(),priority.as_str(),task.due_date,task.created_at,task.updated_at,position,format!("{} {}",task.title,task.notes).to_lowercase()]).map_err(storage_error)?;
    Ok(())
}
fn task_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        title: r.get(1)?,
        notes: r.get(2)?,
        project: r.get(3)?,
        status: match r.get::<_, String>(4)?.as_str() {
            "done" => Status::Done,
            "in-progress" => Status::InProgress,
            _ => Status::Todo,
        },
        priority: match r.get::<_, String>(5)?.as_str() {
            "high" => Priority::High,
            "low" => Priority::Low,
            _ => Priority::Medium,
        },
        due_date: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}
fn frontend_row(db: &Connection, id: &str) -> Result<Frontend> {
    let value: Option<String> = db
        .query_row("SELECT manifest FROM frontends WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(storage_error)?;
    decode(&value.ok_or_else(|| err("NOT_FOUND", "This interface is no longer installed."))?)
}

fn frontend_summary(db: &Connection, id: &str) -> Result<FrontendSummary> {
    let value: Option<String> = db
        .query_row("SELECT summary FROM frontends WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(storage_error)?;
    decode(&value.ok_or_else(|| err("NOT_FOUND", "This interface is no longer installed."))?)
}

pub struct Host {
    db: Connection,
    sessions: HashMap<String, String>,
    registry: Vec<Capability>,
    validators: HashMap<String, jsonschema::Validator>,
    default_id: String,
}
#[derive(Deserialize)]
struct FrontendQuery {
    id: String,
    version: Option<u32>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrontendPublication {
    frontend: Value,
    expected_version: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrontendRestoration {
    id: String,
    version: u32,
    expected_version: u32,
}
impl Host {
    pub fn open(init: Initialize) -> Result<Self> {
        if init.frontends.is_empty() {
            return Err(err(
                "INVALID_INPUT",
                "The app must ship a recovery interface.",
            ));
        }
        if let Some(path) = &init.data_path
            && let Some(parent) = Path::new(path).parent()
        {
            fs::create_dir_all(parent).map_err(storage_error)?;
        }
        #[cfg(unix)]
        if let Some(path) = &init.data_path {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .mode(0o600)
                .open(path)
                .map_err(storage_error)?;
            for file in [path.clone(), format!("{path}-wal"), format!("{path}-shm")] {
                if Path::new(&file).exists() {
                    fs::set_permissions(file, fs::Permissions::from_mode(0o600))
                        .map_err(storage_error)?;
                }
            }
        }
        let db = match &init.data_path {
            Some(path) => Connection::open(path),
            None => Connection::open_in_memory(),
        }
        .map_err(storage_error)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;").map_err(storage_error)?;
        let version: u32 = db
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(storage_error)?;
        if version > 2 {
            return Err(err(
                "UNSUPPORTED_DATABASE",
                "This workspace was created by a newer version of Fluid.",
            ));
        }
        db.execute_batch("BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,notes TEXT NOT NULL,project TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('todo','in-progress','done')),priority TEXT NOT NULL CHECK(priority IN ('low','medium','high')),due_date TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,position INTEGER NOT NULL,search_text TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status); CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project); CREATE INDEX IF NOT EXISTS tasks_due ON tasks(due_date);
            CREATE TABLE IF NOT EXISTS frontends(id TEXT PRIMARY KEY,manifest TEXT NOT NULL,position INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS frontend_history(id TEXT NOT NULL,version INTEGER NOT NULL,manifest TEXT NOT NULL,PRIMARY KEY(id,version));
            CREATE TABLE IF NOT EXISTS grants(client TEXT NOT NULL,scope TEXT NOT NULL,PRIMARY KEY(client,scope));
            CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY,at TEXT NOT NULL,frontend TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,outcome TEXT NOT NULL);
            COMMIT;").map_err(storage_error)?;
        if version < 2 {
            // Version 1 stored full source in every manifest; metadata now has its own column.
            db.execute_batch(
                "BEGIN IMMEDIATE;
                ALTER TABLE frontends ADD COLUMN summary TEXT NOT NULL DEFAULT '{}';
                ALTER TABLE frontend_history ADD COLUMN summary TEXT NOT NULL DEFAULT '{}';
                UPDATE frontends SET summary=json_remove(manifest,'$.html');
                UPDATE frontend_history SET summary=json_remove(manifest,'$.html');
                PRAGMA user_version=2; COMMIT;",
            )
            .map_err(storage_error)?;
        }
        commerce::schema(&db)?;
        let initialized: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM metadata WHERE key='revision')",
                [],
                |r| r.get(0),
            )
            .map_err(storage_error)?;
        let registry = contract::capabilities();
        let validators = registry
            .iter()
            .map(|c| {
                jsonschema::validator_for(&c.input_schema)
                    .map(|v| (c.name.clone(), v))
                    .map_err(|e| err("INVALID_CONTRACT", e.to_string()))
            })
            .collect::<Result<HashMap<_, _>>>()?;
        let mut host = Self {
            db,
            sessions: HashMap::new(),
            registry,
            validators,
            default_id: init.frontends[0].id.clone(),
        };
        if !initialized {
            let legacy = if let Some(value) = init.legacy_state {
                Some(value)
            } else if let Some(path) = &init.legacy_path {
                if Path::new(path).exists() {
                    Some(decode::<Value>(
                        &fs::read_to_string(path).map_err(storage_error)?,
                    )?)
                } else {
                    None
                }
            } else {
                None
            };
            host.initialize(&init.frontends, &init.tasks, legacy)?;
        }
        // Update shipped recovery copies without changing custom artifacts or existing grants.
        let tx = host.db.transaction().map_err(storage_error)?;
        for (index, f) in init.frontends.iter().enumerate() {
            let installed: Option<String> = tx
                .query_row("SELECT manifest FROM frontends WHERE id=?1", [&f.id], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(storage_error)?;
            if let Some(saved) = &installed
                && decode::<Frontend>(saved)?.builtin != Some(true)
            {
                // An app update must never replace a user artifact with the same ID.
                continue;
            }
            if installed.is_none() {
                set_grants(&tx, &f.id, &f.permissions)?;
            }
            tx.execute("INSERT INTO frontends(id,manifest,position,summary) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET manifest=excluded.manifest,summary=excluded.summary",params![f.id,encode(f)?,index as i64,encode(&FrontendSummary::from(f))?]).map_err(storage_error)?;
        }
        let active: String = meta(&tx, "activeId")?;
        tx.execute(
            "INSERT OR IGNORE INTO metadata(key,value) VALUES('canvasMode','false')",
            [],
        )
        .map_err(storage_error)?;
        if frontend_row(&tx, &active).is_err() {
            set_meta(&tx, "activeId", &host.default_id)?;
        }
        tx.commit().map_err(storage_error)?;
        Ok(host)
    }
    fn initialize(
        &mut self,
        defaults: &[Frontend],
        seed: &[Task],
        legacy: Option<Value>,
    ) -> Result<()> {
        let tx = self.db.transaction().map_err(storage_error)?;
        let (frontends, tasks, grants, history, activity, agent, assistant, active, revision) =
            if let Some(value) = legacy {
                let read = |key: &str| {
                    value.get(key).cloned().ok_or_else(|| {
                        err(
                            "INVALID_STATE",
                            format!("Legacy workspace is missing {key}; it was not modified."),
                        )
                    })
                };
                let f: Vec<Frontend> =
                    serde_json::from_value(read("frontends")?).map_err(|_| {
                        err(
                            "INVALID_STATE",
                            "Invalid legacy interfaces; the original was preserved.",
                        )
                    })?;
                let t: Vec<Task> = serde_json::from_value(read("tasks")?).map_err(|_| {
                    err(
                        "INVALID_STATE",
                        "Invalid legacy tasks; the original was preserved.",
                    )
                })?;
                let g: BTreeMap<String, Vec<String>> = serde_json::from_value(read("grants")?)
                    .map_err(|_| err("INVALID_STATE", "Invalid legacy grants."))?;
                let h: BTreeMap<String, Vec<Frontend>> =
                    serde_json::from_value(value.get("history").cloned().unwrap_or(json!({})))
                        .map_err(storage_error)?;
                let a: Vec<Activity> =
                    serde_json::from_value(read("activity")?).map_err(storage_error)?;
                let agent: AgentSettings =
                    serde_json::from_value(read("agent")?).map_err(storage_error)?;
                let assistant: AssistantSettings = serde_json::from_value(
                    value
                        .get("assistant")
                        .cloned()
                        .unwrap_or(serde_json::to_value(AssistantSettings::default()).unwrap()),
                )
                .map_err(storage_error)?;
                (
                    f,
                    t,
                    g,
                    h,
                    a,
                    agent,
                    assistant,
                    read("activeId")?
                        .as_str()
                        .ok_or_else(|| err("INVALID_STATE", "Invalid active interface."))?
                        .to_owned(),
                    value["revision"].as_u64().unwrap_or(1),
                )
            } else {
                (
                    defaults.to_vec(),
                    seed.to_vec(),
                    defaults
                        .iter()
                        .map(|f| (f.id.clone(), f.permissions.clone()))
                        .collect(),
                    BTreeMap::new(),
                    Vec::new(),
                    AgentSettings::default(),
                    AssistantSettings::default(),
                    self.default_id.clone(),
                    1,
                )
            };
        for (index, task) in tasks.iter().enumerate() {
            task_insert(&tx, task, index as i64)?;
        }
        for (index, f) in frontends.iter().enumerate() {
            tx.execute(
                "INSERT INTO frontends(id,manifest,position,summary) VALUES(?1,?2,?3,?4)",
                params![
                    f.id,
                    encode(f)?,
                    index as i64,
                    encode(&FrontendSummary::from(f))?
                ],
            )
            .map_err(storage_error)?;
        }
        for (id, grant) in grants {
            set_grants(&tx, &id, &grant)?;
        }
        for (id, versions) in history {
            for f in versions.into_iter().rev().take(10) {
                tx.execute(
                    "INSERT OR IGNORE INTO frontend_history(id,version,manifest,summary) VALUES(?1,?2,?3,?4)",
                    params![id, f.version, encode(&f)?, encode(&FrontendSummary::from(&f))?],
                )
                .map_err(storage_error)?;
            }
        }
        for event in activity.iter().take(150).rev() {
            tx.execute("INSERT INTO activity(id,at,frontend,action,detail,outcome) VALUES(?1,?2,?3,?4,?5,?6)",params![event.id,event.at,event.frontend,event.action,event.detail,serde_json::to_value(&event.outcome).unwrap().as_str()]).map_err(storage_error)?;
        }
        set_meta(&tx, "revision", &revision)?;
        set_meta(&tx, "activeId", &active)?;
        set_meta(&tx, "agent", &agent)?;
        set_meta(&tx, "assistant", &assistant)?;
        tx.commit().map_err(storage_error)
    }
    pub fn revision(&self) -> Result<u64> {
        meta(&self.db, "revision")
    }
    fn commit<T>(&self, operation: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        let tx = self.db.unchecked_transaction().map_err(storage_error)?;
        let result = operation(&tx)?;
        let revision: u64 = meta(&tx, "revision")?;
        set_meta(&tx, "revision", &(revision + 1))?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }
    fn grants(&self, id: &str) -> Result<Vec<String>> {
        self.db
            .prepare_cached("SELECT scope FROM grants WHERE client=?1 ORDER BY scope")
            .map_err(storage_error)?
            .query_map([id], |row| row.get(0))
            .map_err(storage_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage_error)
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        let frontends = self
            .db
            .prepare_cached("SELECT summary FROM frontends ORDER BY position,rowid")
            .map_err(storage_error)?
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage_error)?
            .into_iter()
            .map(|v| decode(&v))
            .collect::<Result<Vec<FrontendSummary>>>()?;
        let mut history: BTreeMap<String, Vec<FrontendSummary>> = BTreeMap::new();
        let mut stmt = self
            .db
            .prepare_cached("SELECT id,summary FROM frontend_history ORDER BY version")
            .map_err(storage_error)?;
        for row in stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(storage_error)?
        {
            let (id, value) = row.map_err(storage_error)?;
            history.entry(id).or_default().push(decode(&value)?);
        }
        let grants = frontends
            .iter()
            .map(|f| self.grants(&f.id).map(|g| (f.id.clone(), g)))
            .collect::<Result<_>>()?;
        let mut stmt = self
            .db
            .prepare_cached(
                "SELECT id,at,frontend,action,detail,outcome FROM activity ORDER BY rowid DESC",
            )
            .map_err(storage_error)?;
        let activity = stmt
            .query_map([], |r| {
                Ok(Activity {
                    id: r.get(0)?,
                    at: r.get(1)?,
                    frontend: r.get(2)?,
                    action: r.get(3)?,
                    detail: r.get(4)?,
                    outcome: match r.get::<_, String>(5)?.as_str() {
                        "allowed" => Outcome::Allowed,
                        "denied" => Outcome::Denied,
                        _ => Outcome::System,
                    },
                })
            })
            .map_err(storage_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        Ok(Snapshot {
            revision: self.revision()?,
            active_id: meta(&self.db, "activeId")?,
            canvas_mode: meta(&self.db, "canvasMode")?,
            frontends,
            history,
            grants,
            activity,
            agent: meta(&self.db, "agent")?,
            assistant: meta(&self.db, "assistant")?,
            runtime: RuntimeInfo {
                engine: "Rust".into(),
                storage: "SQLite · WAL".into(),
                protocol_source: "fluid-protocol + fluid-host".into(),
                schema_version: 2,
            },
        })
    }
    pub fn inspect(&self, id: &str) -> Result<ToolInspection> {
        let (enabled, name, grants, transports) = if id == "external-agent" {
            let agent: AgentSettings = meta(&self.db, "agent")?;
            (
                agent.enabled,
                "External agents".into(),
                agent.permissions,
                vec![
                    "MCP · Streamable HTTP".into(),
                    "MCP · stdio".into(),
                    "Authenticated JSON RPC".into(),
                ],
            )
        } else {
            let f = frontend_summary(&self.db, id)?;
            (
                true,
                f.name,
                self.grants(id)?,
                vec![
                    "Frontend SDK · MessageChannel".into(),
                    "WebMCP · when supported".into(),
                ],
            )
        };
        let tools = self
            .registry
            .iter()
            .map(|cap| {
                let exposed = enabled
                    && cap
                        .permission
                        .as_ref()
                        .is_none_or(|scope| grants.contains(scope));
                let reason = if !enabled {
                    "Agent access is disabled".into()
                } else if exposed {
                    "Available with current grants".into()
                } else {
                    format!("Requires {}", cap.permission.as_deref().unwrap_or("access"))
                };
                ExposedTool {
                    capability: cap.clone(),
                    exposed,
                    reason,
                }
            })
            .collect();
        Ok(ToolInspection {
            client_id: id.into(),
            name,
            enabled,
            grants,
            tools,
            transports,
            engine: "Rust".into(),
        })
    }
    pub fn call_agent(&mut self, name: &str, input: Value) -> Result<Value> {
        let agent: AgentSettings = meta(&self.db, "agent")?;
        if !agent.enabled {
            return Err(err("AGENT_DISABLED", "External agent access is disabled."));
        }
        self.execute(
            "external-agent",
            "External agent",
            agent.permissions,
            name,
            input,
        )
    }
    pub fn call(&mut self, token: &str, name: &str, input: Value) -> Result<Value> {
        let id = self.sessions.get(token).cloned().ok_or_else(|| {
            err(
                "SESSION_EXPIRED",
                "This interface session has ended. Reload the interface.",
            )
        })?;
        let f = frontend_summary(&self.db, &id)?;
        self.execute(&id, &f.name, self.grants(&id)?, name, input)
    }
    fn execute(
        &mut self,
        client: &str,
        label: &str,
        grants: Vec<String>,
        name: &str,
        input: Value,
    ) -> Result<Value> {
        let cap = self
            .registry
            .iter()
            .find(|c| c.name == name)
            .ok_or_else(|| err("UNKNOWN_CAPABILITY", format!("Unknown capability: {name}")))?;
        if let Some(scope) = &cap.permission
            && !grants.contains(scope)
        {
            let detail = format!("Requires {scope}");
            let recent: bool = self.db.query_row("SELECT EXISTS(SELECT 1 FROM activity WHERE rowid=(SELECT MAX(rowid) FROM activity) AND frontend=?1 AND action=?2 AND outcome='denied' AND at>?3)",params![label,name,(Utc::now()-chrono::Duration::seconds(5)).to_rfc3339()],|r|r.get(0)).map_err(storage_error)?;
            if !recent {
                self.commit(|tx| log(tx, label, name, &detail, "denied"))?;
            }
            return Err(err(
                "PERMISSION_DENIED",
                format!("Access to {scope} is disabled. Change it in Permissions."),
            ));
        }
        if let Err(error) = self.validators[name].validate(&input) {
            return Err(err("INVALID_INPUT", error.to_string()));
        }
        match name {
            "workspace.describe" => {
                let mut value = contract::contract();
                value["grantedPermissions"] = json!(grants);
                value["clientId"] = json!(client);
                value["runtime"] = json!({"engine":"Rust","storage":"SQLite"});
                Ok(value)
            }
            "tools.inspect" => serde_json::to_value(self.inspect(client)?).map_err(storage_error),
            "tasks.list" => self.list_tasks(&input),
            "tasks.create" | "tasks.update" | "tasks.delete" => {
                self.mutate_task(label, name, input)
            }
            "orders.list" => {
                serde_json::to_value(commerce::list(&self.db, &input)?).map_err(storage_error)
            }
            "orders.get" => {
                serde_json::to_value(commerce::get(&self.db, input["id"].as_str().unwrap())?)
                    .map_err(storage_error)
            }
            "orders.summary" => {
                serde_json::to_value(commerce::summary(&self.db)?).map_err(storage_error)
            }
            "reviews.update" => {
                // Import outside the review transaction; source data is immutable afterwards.
                commerce::get(&self.db, input["id"].as_str().unwrap())?;
                self.commit(|tx| {
                    let review = commerce::update_review(tx, &input, label, &now())?;
                    log(
                        tx,
                        label,
                        name,
                        &format!(
                            "Invoice {} · {}",
                            input["id"].as_str().unwrap(),
                            review.status
                        ),
                        "allowed",
                    )?;
                    serde_json::to_value(review).map_err(storage_error)
                })
            }
            "frontends.list" => {
                let items = self
                    .db
                    .prepare_cached("SELECT summary FROM frontends ORDER BY position,rowid")
                    .map_err(storage_error)?
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(storage_error)?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(storage_error)?
                    .into_iter()
                    .map(|v| decode::<Value>(&v))
                    .collect::<Result<Vec<_>>>()?;
                Ok(json!({"activeId":meta::<String>(&self.db,"activeId")?,"frontends":items}))
            }
            "frontends.get" => {
                let query: FrontendQuery = input::parse(input)?;
                if let Some(version) = query.version {
                    let current = frontend_row(&self.db, &query.id)?;
                    if current.version == version {
                        return Ok(json!(current));
                    }
                    return self.history_version(&query.id, u64::from(version));
                }
                Ok(json!(frontend_row(&self.db, &query.id)?))
            }
            "frontends.put" => {
                let publication: FrontendPublication = input::parse(input)?;
                Ok(json!(self.install(
                    publication.frontend,
                    Some(u64::from(publication.expected_version)),
                    label
                )?))
            }
            "frontends.activate" => {
                self.activate(
                    input["id"].as_str().unwrap(),
                    label,
                    input["canvasMode"].as_bool(),
                )?;
                Ok(
                    json!({"activeId":input["id"],"canvasMode":meta::<bool>(&self.db,"canvasMode")?}),
                )
            }
            "frontends.restore" => {
                let restoration: FrontendRestoration = input::parse(input)?;
                let current = frontend_row(&self.db, &restoration.id)?;
                if current.version != restoration.expected_version {
                    return Err(err(
                        "VERSION_CONFLICT",
                        "The interface changed. Read its current source before restoring.",
                    ));
                }
                let version =
                    self.history_version(&restoration.id, u64::from(restoration.version))?;
                Ok(json!(self.install(
                    version,
                    Some(current.version as u64),
                    label
                )?))
            }
            _ => Err(err("UNKNOWN_CAPABILITY", "Unknown capability.")),
        }
    }
    fn list_tasks(&self, input: &Value) -> Result<Value> {
        let mut sql = String::from(
            "SELECT id,title,notes,project,status,priority,due_date,created_at,updated_at FROM tasks WHERE 1=1",
        );
        let mut values = Vec::<String>::new();
        for field in ["status", "project"] {
            if let Some(value) = input[field].as_str() {
                sql.push_str(&format!(" AND {field}=?"));
                values.push(value.to_owned());
            }
        }
        if let Some(search) = input["search"].as_str().filter(|s| !s.is_empty()) {
            sql.push_str(" AND instr(search_text,?)>0");
            values.push(search.to_lowercase());
        }
        sql.push_str(" ORDER BY position");
        let mut statement = self.db.prepare_cached(&sql).map_err(storage_error)?;
        let tasks = statement
            .query_map(rusqlite::params_from_iter(values.iter()), task_from_row)
            .map_err(storage_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        Ok(json!({"tasks":tasks,"revision":self.revision()?}))
    }
    fn mutate_task(&self, label: &str, name: &str, input: Value) -> Result<Value> {
        if input
            .get("title")
            .and_then(Value::as_str)
            .is_some_and(|s| s.trim().is_empty())
        {
            return Err(err("INVALID_INPUT", "Task title cannot be empty."));
        }
        if let Some(date) = input["dueDate"].as_str()
            && NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err()
        {
            return Err(err("INVALID_INPUT", "Choose a valid calendar date."));
        }
        self.commit(|tx| {
            if name=="tasks.create" {
                let mut value=json!({"id":uuid(),"title":"","notes":"","project":"General","status":"todo","priority":"medium","dueDate":null,"createdAt":now(),"updatedAt":now()});
                for (key,v) in input.as_object().unwrap(){value[key]=v.clone();}
                value["title"]=json!(value["title"].as_str().unwrap().trim());
                let task:Task=serde_json::from_value(value.clone()).map_err(storage_error)?;
                let position:i64=tx.query_row("SELECT COALESCE(MIN(position),0)-1 FROM tasks",[],|r|r.get(0)).map_err(storage_error)?;
                task_insert(tx,&task,position)?;log(tx,label,name,&task.title,"allowed")?;Ok(value)
            }else{
                let id=input["id"].as_str().unwrap();
                let old=tx.query_row("SELECT id,title,notes,project,status,priority,due_date,created_at,updated_at FROM tasks WHERE id=?1",[id],task_from_row).optional().map_err(storage_error)?.ok_or_else(||err("NOT_FOUND","This task no longer exists."))?;
                let old=json!(old);
                if name=="tasks.delete"{tx.execute("DELETE FROM tasks WHERE id=?1",[id]).map_err(storage_error)?;log(tx,label,name,old["title"].as_str().unwrap(),"allowed")?;return Ok(json!({"deleted":id}));}
                let mut value=old;for(key,v)in input.as_object().unwrap(){if key!="id"{value[key]=v.clone();}}
                value["title"]=json!(value["title"].as_str().unwrap().trim());value["updatedAt"]=json!(now());
                tx.execute("UPDATE tasks SET title=?1,notes=?2,project=?3,status=?4,priority=?5,due_date=?6,updated_at=?7,search_text=?8 WHERE id=?9",params![value["title"].as_str(),value["notes"].as_str(),value["project"].as_str(),value["status"].as_str(),value["priority"].as_str(),value["dueDate"].as_str(),value["updatedAt"].as_str(),format!("{} {}",value["title"].as_str().unwrap(),value["notes"].as_str().unwrap()).to_lowercase(),id]).map_err(storage_error)?;
                log(tx,label,name,value["title"].as_str().unwrap(),"allowed")?;Ok(value)
            }
        })
    }
    fn history_version(&self, id: &str, version: u64) -> Result<Value> {
        let version = i64::try_from(version)
            .map_err(|_| err("INVALID_INPUT", "Invalid interface version."))?;
        let value: Option<String> = self
            .db
            .query_row(
                "SELECT manifest FROM frontend_history WHERE id=?1 AND version=?2",
                params![id, version],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        decode(&value.ok_or_else(|| {
            err(
                "NOT_FOUND",
                "This interface version is no longer in history.",
            )
        })?)
    }
    fn install(&mut self, value: Value, expected: Option<u64>, label: &str) -> Result<Frontend> {
        if value["appId"] != APP_ID || value["protocol"] != VERSION {
            return Err(err(
                "INCOMPATIBLE_FRONTEND",
                "This interface targets a different app or protocol version.",
            ));
        }
        let mut frontend: Frontend = serde_json::from_value(value).map_err(|_| {
            err(
                "INVALID_FRONTEND",
                "An interface needs an ID, name, source, and known permissions.",
            )
        })?;
        if frontend.id.is_empty()
            || frontend.id.len() > 80
            || !frontend
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || ["__proto__", "constructor", "prototype", "external-agent"]
                .contains(&frontend.id.as_str())
            || frontend.name.trim().is_empty()
            || frontend.name.chars().count() > 80
            || frontend.html.trim().is_empty()
            || frontend.html.encode_utf16().count() > MAX_HTML_UNITS
            || frontend
                .permissions
                .iter()
                .any(|s| !SCOPES.contains(&s.as_str()))
        {
            return Err(err(
                "INVALID_FRONTEND",
                "Use a valid ID, name, known permissions, and HTML up to 500,000 UTF-16 units.",
            ));
        }
        let previous = frontend_row(&self.db, &frontend.id).ok();
        if previous.as_ref().is_some_and(|f| f.builtin == Some(true)) {
            return Err(err(
                "BUILTIN_FRONTEND",
                "Use a new ID to fork this shipped recovery copy. Your replacement can be freely edited and activated.",
            ));
        }
        let current = previous.as_ref().map_or(0, |f| f.version as u64);
        if expected.is_some_and(|v| v != current) {
            return Err(err(
                "VERSION_CONFLICT",
                format!("The current version is {current}. Read it before publishing an update."),
            ));
        }
        frontend.version = (current as u32)
            .checked_add(1)
            .ok_or_else(|| err("VERSION_CONFLICT", "Version limit reached."))?;
        frontend.builtin = None;
        frontend.updated_at = now();
        frontend.name = frontend.name.trim().to_owned();
        frontend.description = frontend.description.chars().take(240).collect();
        frontend.author = frontend.author.chars().take(80).collect();
        frontend.permissions.sort();
        frontend.permissions.dedup();
        let grants = self
            .grants(&frontend.id)?
            .into_iter()
            .filter(|s| frontend.permissions.contains(s))
            .collect::<Vec<_>>();
        self.commit(|tx|{
            if let Some(old)=previous {tx.execute("INSERT INTO frontend_history(id,version,manifest,summary) VALUES(?1,?2,?3,?4)",params![old.id,old.version,encode(&old)?,encode(&FrontendSummary::from(&old))?]).map_err(storage_error)?;tx.execute("DELETE FROM frontend_history WHERE id=?1 AND version NOT IN(SELECT version FROM frontend_history WHERE id=?1 ORDER BY version DESC LIMIT 10)",[&old.id]).map_err(storage_error)?;}
            tx.execute("INSERT INTO frontends(id,manifest,position,summary) VALUES(?1,?2,(SELECT COALESCE(MAX(position),0)+1 FROM frontends),?3) ON CONFLICT(id) DO UPDATE SET manifest=excluded.manifest,summary=excluded.summary",params![frontend.id,encode(&frontend)?,encode(&FrontendSummary::from(&frontend))?]).map_err(storage_error)?;
            set_grants(tx,&frontend.id,&grants)?;log(tx,label,"frontend.install",&format!("{} · version {}",frontend.name,frontend.version),"system")?;Ok(())
        })?;
        self.sessions.retain(|_, id| id != &frontend.id);
        Ok(frontend)
    }
    fn activate(&self, id: &str, label: &str, canvas_mode: Option<bool>) -> Result<()> {
        let f = frontend_summary(&self.db, id)?;
        if meta::<String>(&self.db, "activeId")? == id
            && canvas_mode
                .is_none_or(|mode| meta::<bool>(&self.db, "canvasMode").ok() == Some(mode))
        {
            return Ok(());
        }
        self.commit(|tx| {
            set_meta(tx, "activeId", &id)?;
            if let Some(mode) = canvas_mode {
                set_meta(tx, "canvasMode", &mode)?;
            }
            log(
                tx,
                label,
                "frontend.activate",
                &format!("Switched to {}", f.name),
                "system",
            )
        })
    }
    pub fn dispatch(&mut self, method: &str, args: &[Value]) -> Result<Value> {
        let arg = |n: usize| args.get(n).cloned().unwrap_or(Value::Null);
        let string = |n: usize| {
            args.get(n)
                .and_then(Value::as_str)
                .ok_or_else(|| err("INVALID_INPUT", "Expected a string argument."))
        };
        match method {
            "snapshot" => Ok(json!(self.snapshot()?)),
            "frontendSource" => Ok(json!(frontend_row(&self.db, string(0)?)?)),
            "revision" => Ok(json!(self.revision()?)),
            "contract" => Ok(contract::contract()),
            "openSession" => {
                let id = string(0)?;
                frontend_summary(&self.db, id)?;
                let token = uuid();
                self.sessions.insert(token.clone(), id.into());
                Ok(json!(token))
            }
            "closeSession" => {
                self.sessions.remove(string(0)?);
                Ok(Value::Null)
            }
            "call" => self.call(
                string(0)?,
                string(1)?,
                args.get(2).cloned().unwrap_or(json!({})),
            ),
            "callAgent" => self.call_agent(string(0)?, args.get(1).cloned().unwrap_or(json!({}))),
            "tools.inspect" => Ok(json!(self.inspect(string(0)?)?)),
            "install" => {
                let value = arg(0);
                let previous = value["id"]
                    .as_str()
                    .and_then(|id| frontend_row(&self.db, id).ok());
                let expected = if previous.is_some() {
                    Some(value["version"].as_u64().ok_or_else(|| {
                        err(
                            "VERSION_CONFLICT",
                            "Read the current interface version before updating its source.",
                        )
                    })?)
                } else {
                    Some(0)
                };
                Ok(json!(self.install(value, expected, "App")?))
            }
            "activate" => {
                self.activate(string(0)?, "App", None)?;
                Ok(Value::Null)
            }
            "setCanvasMode" => {
                let mode = arg(0)
                    .as_bool()
                    .ok_or_else(|| err("INVALID_INPUT", "Expected canvas mode to be a boolean."))?;
                self.commit(|tx| {
                    set_meta(tx, "canvasMode", &mode)?;
                    log(
                        tx,
                        "App",
                        "frontend.canvas",
                        if mode {
                            "Full canvas enabled"
                        } else {
                            "App controls restored"
                        },
                        "system",
                    )
                })?;
                Ok(Value::Null)
            }
            "restore" => {
                let value = self.history_version(
                    string(0)?,
                    arg(1)
                        .as_u64()
                        .ok_or_else(|| err("INVALID_INPUT", "Expected a version."))?,
                )?;
                Ok(json!(self.install(value, None, "App")?))
            }
            "setGrants" => {
                let id = string(0)?;
                let f = frontend_summary(&self.db, id)?;
                let grants = scopes(&arg(1))?;
                if grants.iter().any(|s| !f.permissions.contains(s)) {
                    return Err(err(
                        "INVALID_INPUT",
                        "Only scopes requested by this interface can be granted.",
                    ));
                }
                self.commit(|tx| {
                    set_grants(tx, id, &grants)?;
                    log(
                        tx,
                        "App",
                        "permissions.update",
                        &format!("{}: {}", f.name, grants.join(", ")),
                        "system",
                    )
                })?;
                Ok(Value::Null)
            }
            "setAgent" => {
                let enabled = arg(0)
                    .as_bool()
                    .ok_or_else(|| err("INVALID_INPUT", "Expected enabled to be a boolean."))?;
                let grants = if args.len() > 1 && !args[1].is_null() {
                    scopes(&args[1])?
                } else {
                    meta::<AgentSettings>(&self.db, "agent")?.permissions
                };
                self.commit(|tx| {
                    set_meta(
                        tx,
                        "agent",
                        &AgentSettings {
                            enabled,
                            permissions: grants,
                        },
                    )?;
                    log(
                        tx,
                        "App",
                        "agent.access",
                        if enabled {
                            "External agent access enabled"
                        } else {
                            "External agent access disabled"
                        },
                        "system",
                    )
                })?;
                Ok(Value::Null)
            }
            "setAssistantSettings" => {
                let settings: AssistantSettings = serde_json::from_value(arg(0))
                    .map_err(|_| err("INVALID_INPUT", "Invalid helper settings."))?;
                self.commit(|tx| set_meta(tx, "assistant", &settings))?;
                Ok(Value::Null)
            }
            "remove" => {
                let id = string(0)?;
                let f = frontend_summary(&self.db, id)?;
                if f.builtin == Some(true) {
                    return Err(err(
                        "BUILTIN_FRONTEND",
                        "Shipped recovery copies remain available.",
                    ));
                }
                self.commit(|tx| {
                    tx.execute("DELETE FROM frontends WHERE id=?1", [id])
                        .map_err(storage_error)?;
                    tx.execute("DELETE FROM frontend_history WHERE id=?1", [id])
                        .map_err(storage_error)?;
                    tx.execute("DELETE FROM grants WHERE client=?1", [id])
                        .map_err(storage_error)?;
                    if meta::<String>(tx, "activeId")? == id {
                        set_meta(tx, "activeId", &self.default_id)?;
                    }
                    log(tx, "App", "frontend.remove", &f.name, "system")
                })?;
                self.sessions.retain(|_, client| client != id);
                Ok(Value::Null)
            }
            _ => Err(err("UNKNOWN_METHOD", "Unknown host method.")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn initialize(path: Option<String>) -> Initialize {
        serde_json::from_value(json!({"frontends":[{"id":"default","name":"Default","appId":APP_ID,"protocol":VERSION,"permissions":SCOPES,"html":"<h1>User-owned source</h1>","version":1,"builtin":true}],"tasks":[],"dataPath":path})).unwrap()
    }
    fn host() -> Host {
        Host::open(initialize(None)).unwrap()
    }
    fn agent(host: &mut Host) {
        host.dispatch("setAgent", &[json!(true), json!(SCOPES)])
            .unwrap();
    }
    fn artifact() -> Value {
        json!({"id":"mine","name":"Mine","appId":APP_ID,"protocol":VERSION,"permissions":["tasks:read"],"html":"<h1>Any HTML, CSS, and JavaScript</h1>","version":0})
    }
    #[test]
    fn numeric_versions_return_errors_without_panicking() {
        let mut host = host();
        agent(&mut host);
        for version in [json!(0.0), json!(-0.0), json!(1e100)] {
            let error = host
                .call_agent(
                    "frontends.put",
                    json!({"frontend":artifact(),"expectedVersion":version}),
                )
                .unwrap_err();
            assert_eq!(error.code, "INVALID_INPUT");
            assert!(host.snapshot().is_ok());
        }
    }
    #[test]
    fn snapshots_do_not_repeat_interface_source_or_history() {
        let mut host = host();
        agent(&mut host);
        let html = format!("<main>{}</main>", "a".repeat(400_000));
        for version in 0..11 {
            let mut frontend = artifact();
            frontend["html"] = json!(html);
            host.call_agent(
                "frontends.put",
                json!({"frontend":frontend,"expectedVersion":version}),
            )
            .unwrap();
        }
        host.call_agent("tasks.create", json!({"title":"Small change"}))
            .unwrap();
        let snapshot = serde_json::to_value(host.snapshot().unwrap()).unwrap();
        assert!(snapshot["frontends"][0].get("html").is_none());
        assert!(snapshot["history"]["mine"][0].get("html").is_none());
        assert!(snapshot.to_string().len() < 20_000);
        assert_eq!(snapshot["history"]["mine"].as_array().unwrap().len(), 10);
        assert_eq!(
            host.call_agent("frontends.get", json!({"id":"mine"}))
                .unwrap()["html"],
            html
        );
    }
    #[test]
    fn version_one_database_migrates_source_history_and_grants() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("version-one.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE frontends(id TEXT PRIMARY KEY,manifest TEXT NOT NULL,position INTEGER NOT NULL);
            CREATE TABLE frontend_history(id TEXT NOT NULL,version INTEGER NOT NULL,manifest TEXT NOT NULL,PRIMARY KEY(id,version));
            CREATE TABLE grants(client TEXT NOT NULL,scope TEXT NOT NULL,PRIMARY KEY(client,scope));
            PRAGMA user_version=1;").unwrap();
        let mut current: Frontend = serde_json::from_value(artifact()).unwrap();
        current.version = 2;
        let mut old = current.clone();
        old.version = 1;
        old.html = "<main>Earlier source</main>".into();
        db.execute(
            "INSERT INTO frontends VALUES(?1,?2,0)",
            params![current.id, encode(&current).unwrap()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO frontend_history VALUES(?1,1,?2)",
            params![old.id, encode(&old).unwrap()],
        )
        .unwrap();
        set_meta(&db, "revision", &12_u64).unwrap();
        set_meta(&db, "activeId", &current.id).unwrap();
        set_meta(&db, "agent", &AgentSettings::default()).unwrap();
        set_meta(&db, "assistant", &AssistantSettings::default()).unwrap();
        set_grants(&db, &current.id, &["tasks:read".into()]).unwrap();
        drop(db);
        let mut host = Host::open(initialize(Some(path.to_string_lossy().into_owned()))).unwrap();
        agent(&mut host);
        let snapshot = host.snapshot().unwrap();
        assert_eq!(snapshot.runtime.schema_version, 2);
        assert_eq!(snapshot.active_id, "mine");
        assert_eq!(snapshot.history["mine"][0].version, 1);
        assert_eq!(snapshot.grants["mine"], ["tasks:read"]);
        assert_eq!(
            host.call_agent("frontends.get", json!({"id":"mine"}))
                .unwrap()["html"],
            current.html
        );
        assert_eq!(
            host.call_agent("frontends.get", json!({"id":"mine","version":1}))
                .unwrap()["html"],
            old.html
        );
        let session = host.dispatch("openSession", &[json!("mine")]).unwrap();
        assert!(
            host.call(session.as_str().unwrap(), "tasks.list", json!({}))
                .is_ok()
        );
    }
    #[test]
    fn storage_failures_retain_internal_causes_without_serializing_them() {
        use std::error::Error;
        let directory = tempfile::tempdir().unwrap();
        let error = Host::open(initialize(Some(
            directory.path().to_string_lossy().into_owned(),
        )))
        .err()
        .expect("A directory cannot be used as a database file");
        assert_eq!(error.code, "STORAGE_ERROR");
        assert!(error.source().is_some());
        let wire = serde_json::to_value(error).unwrap();
        assert_eq!(wire.as_object().unwrap().len(), 2);
        assert!(
            !wire
                .to_string()
                .contains(directory.path().to_str().unwrap())
        );
    }
    #[test]
    fn transaction_rolls_back_data_revision_and_audit_on_failure() {
        let mut host = host();
        agent(&mut host);
        let before = host.revision().unwrap();
        host.db.execute_batch("CREATE TEMP TRIGGER reject_audit BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT,'simulated write failure'); END;").unwrap();
        assert!(
            host.call_agent("tasks.create", json!({"title":"Must roll back"}))
                .is_err()
        );
        assert_eq!(host.revision().unwrap(), before);
        assert_eq!(
            host.call_agent("tasks.list", json!({})).unwrap()["tasks"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }
    #[test]
    fn source_is_editable_grants_are_separate_and_stale_edits_fail() {
        let mut host = host();
        agent(&mut host);
        host.call_agent(
            "frontends.put",
            json!({"frontend":artifact(),"expectedVersion":0}),
        )
        .unwrap();
        assert!(host.grants("mine").unwrap().is_empty());
        let first = host
            .call_agent("frontends.get", json!({"id":"mine"}))
            .unwrap();
        assert_eq!(first["version"], 1);
        let mut changed = first.clone();
        changed["html"] = json!("<h1>Agent replacement</h1>");
        host.call_agent(
            "frontends.put",
            json!({"frontend":changed,"expectedVersion":1}),
        )
        .unwrap();
        assert_eq!(
            host.call_agent(
                "frontends.put",
                json!({"frontend":first,"expectedVersion":1})
            )
            .unwrap_err()
            .code,
            "VERSION_CONFLICT"
        );
        host.call_agent("frontends.activate", json!({"id":"mine"}))
            .unwrap();
        assert_eq!(host.snapshot().unwrap().active_id, "mine");
        let token = host.dispatch("openSession", &[json!("mine")]).unwrap();
        assert_eq!(
            host.call(token.as_str().unwrap(), "tasks.list", json!({}))
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );
        host.dispatch("setGrants", &[json!("mine"), json!(["tasks:read"])])
            .unwrap();
        assert!(
            host.call(token.as_str().unwrap(), "tasks.list", json!({}))
                .is_ok()
        );
        host.call_agent(
            "frontends.restore",
            json!({"id":"mine","version":1,"expectedVersion":2}),
        )
        .unwrap();
        assert_eq!(
            host.call_agent("frontends.get", json!({"id":"mine"}))
                .unwrap()["version"],
            3
        );
        assert_eq!(host.grants("mine").unwrap(), vec!["tasks:read"]);
    }
    #[test]
    fn discovery_and_execution_share_current_grants() {
        let mut host = host();
        agent(&mut host);
        assert!(
            host.inspect("external-agent")
                .unwrap()
                .tools
                .iter()
                .find(|t| t.capability.name == "frontends.get")
                .unwrap()
                .exposed
        );
        host.dispatch("setAgent", &[json!(true), json!(["tasks:read"])])
            .unwrap();
        assert!(
            !host
                .inspect("external-agent")
                .unwrap()
                .tools
                .iter()
                .find(|t| t.capability.name == "frontends.get")
                .unwrap()
                .exposed
        );
        assert_eq!(
            host.call_agent("frontends.get", json!({"id":"default"}))
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );
    }
    #[test]
    fn damaged_legacy_file_is_preserved_and_cannot_partially_migrate() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.json");
        let database = directory.path().join("workspace.sqlite");
        let original = "{\"frontends\":[]}";
        fs::write(&path, original).unwrap();
        let mut init = initialize(Some(database.to_string_lossy().into_owned()));
        init.legacy_path = Some(path.to_string_lossy().into_owned());
        assert!(Host::open(init).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), original);
        let db = Connection::open(database).unwrap();
        let count: u32 = db
            .query_row("SELECT COUNT(*) FROM metadata", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
    #[test]
    #[ignore = "manual measurement, not a portable performance assertion"]
    fn measure_native_operations() {
        let mut host = host();
        agent(&mut host);
        let start = std::time::Instant::now();
        for i in 0..1000 {
            host.call_agent(
                "tasks.create",
                json!({"title":format!("Task {i}"),"project":if i%2==0{"Even"}else{"Odd"}}),
            )
            .unwrap();
        }
        let writes = start.elapsed();
        let start = std::time::Instant::now();
        for _ in 0..100 {
            let result = host
                .call_agent("tasks.list", json!({"project":"Even"}))
                .unwrap();
            assert_eq!(result["tasks"].as_array().unwrap().len(), 500);
        }
        eprintln!(
            "Rust/SQLite in-memory: 1000 transactional creates = {:?}; 100 filtered reads of 500 rows = {:?}. Includes schema validation and JSON value construction; excludes IPC and disk sync.",
            writes,
            start.elapsed()
        );
    }
}
