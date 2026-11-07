use crate::model::{APP_ID, SCOPES};
use fluid_protocol::{Capability, ToolAnnotations, VERSION};
use serde_json::{Value, json};

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
pub fn capabilities() -> Vec<Capability> {
    let text = json!({"type":"string","minLength":1,"maxLength":240});
    let id = json!({"type":"string","minLength":1,"maxLength":80,"pattern":"^[a-zA-Z0-9_-]+$"});
    let status = json!({"type":"string","enum":["todo","in-progress","done"]});
    let fields = json!({
        "title":text,"notes":{"type":"string","maxLength":8000},
        "project":{"type":"string","minLength":1,"maxLength":80},"status":status,
        "priority":{"type":"string","enum":["low","medium","high"]},
        "dueDate":{"anyOf":[{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$"},{"type":"null"}]}
    });
    let mut task_fields = fields.clone();
    task_fields["id"] = text.clone();
    task_fields["createdAt"] = json!({"type":"string"});
    task_fields["updatedAt"] = json!({"type":"string"});
    let task = object(
        task_fields,
        &[
            "id",
            "title",
            "notes",
            "project",
            "status",
            "priority",
            "dueDate",
            "createdAt",
            "updatedAt",
        ],
    );
    let manifest = object(
        json!({
            "id":id,"name":{"type":"string","minLength":1,"maxLength":80},"description":{"type":"string","maxLength":240},
            "author":{"type":"string","maxLength":80},"appId":{"const":APP_ID},"protocol":{"const":VERSION},
            "permissions":{"type":"array","items":{"type":"string","enum":SCOPES}},
            "html":{"type":"string","minLength":1,"maxLength":500000},"version":{"type":"integer","minimum":0},
            "updatedAt":{"type":"string"},"builtin":{"type":"boolean"}
        }),
        &["id", "name", "appId", "protocol", "permissions", "html"],
    );
    let build = |name: &str,
                 description: &str,
                 scope: Option<&str>,
                 input: Value,
                 output: Value,
                 destructive: bool| Capability {
        name: name.into(),
        description: description.into(),
        permission: scope.map(str::to_owned),
        input_schema: input,
        output_schema: output,
        annotations: ToolAnnotations {
            read_only_hint: scope.is_none() || scope.is_some_and(|s| s.ends_with(":read")),
            destructive_hint: destructive,
            open_world_hint: false,
        },
    };
    let mut update = fields.clone();
    update["id"] = text.clone();
    let mut result = vec![
        build(
            "workspace.describe",
            "Discover the app contract, domain meanings, your current grants, and protocol runtime.",
            None,
            object(json!({}), &[]),
            json!({"type":"object"}),
            false,
        ),
        build(
            "tools.inspect",
            "See exactly which tools this client can invoke, including schemas, grants, and reasons for unavailable tools.",
            None,
            object(json!({}), &[]),
            json!({"type":"object"}),
            false,
        ),
        build(
            "tasks.list",
            "Read shared tasks. Filter by status, project, or case-insensitive title and notes search.",
            Some("tasks:read"),
            object(
                json!({"status":status,"project":text,"search":{"type":"string","maxLength":240}}),
                &[],
            ),
            json!({"type":"object","properties":{"tasks":{"type":"array","items":task},"revision":{"type":"integer"}},"required":["tasks","revision"]}),
            false,
        ),
        build(
            "tasks.create",
            "Create a task. Defaults: todo status, medium priority, General project, and no due date.",
            Some("tasks:write"),
            object(fields, &["title"]),
            task.clone(),
            false,
        ),
        build(
            "tasks.update",
            "Update provided task fields. Omitted fields are preserved. Done means completed; in-progress means actively being worked on.",
            Some("tasks:write"),
            object(update, &["id"]),
            task,
            false,
        ),
        build(
            "tasks.delete",
            "Permanently delete a task. Requires a separate delete grant.",
            Some("tasks:delete"),
            object(json!({"id":text}), &["id"]),
            json!({"type":"object","properties":{"deleted":{"type":"string"}},"required":["deleted"]}),
            true,
        ),
        build(
            "frontends.list",
            "List installed interfaces and their versions. Source is available through frontends.get.",
            Some("frontends:read"),
            object(json!({}), &[]),
            json!({"type":"object"}),
            false,
        ),
        build(
            "frontends.get",
            "Read the complete editable HTML/CSS/JavaScript source and manifest of an interface. Omit version to read the current version.",
            Some("frontends:read"),
            object(
                json!({"id":id,"version":{"type":"integer","minimum":1}}),
                &["id"],
            ),
            json!({"type":"object"}),
            false,
        ),
        build(
            "frontends.put",
            "Publish a complete interface artifact. Use a new ID to fork shipped defaults. Updates require expectedVersion to prevent lost edits. Installation grants no new permissions and does not activate or execute code.",
            Some("frontends:write"),
            object(
                json!({"frontend":manifest,"expectedVersion":{"type":"integer","minimum":0}}),
                &["frontend", "expectedVersion"],
            ),
            json!({"type":"object"}),
            false,
        ),
        build(
            "frontends.activate",
            "Activate an installed interface. Optional canvasMode fills the window with user-owned UI while recovery controls remain accessible. Existing user-granted permissions apply; this tool cannot grant additional access.",
            Some("frontends:write"),
            object(json!({"id":id,"canvasMode":{"type":"boolean"}}), &["id"]),
            json!({"type":"object"}),
            false,
        ),
        build(
            "frontends.restore",
            "Restore a saved interface version as a new revision. expectedVersion must match the current revision. Grants cannot expand.",
            Some("frontends:write"),
            object(
                json!({"id":id,"version":{"type":"integer","minimum":1},"expectedVersion":{"type":"integer","minimum":1}}),
                &["id", "version", "expectedVersion"],
            ),
            json!({"type":"object"}),
            false,
        ),
    ];
    result.extend([
        build("orders.list", "Read real UCI retail invoices, grouped from source lines. Filters and sorting run on the host. Review status is a separate demo workflow, not an original source fact.", Some("orders:read"), object(json!({
            "search":{"type":"string","maxLength":240},"country":{"type":"string","maxLength":80},
            "kind":{"enum":["sale","cancellation"]},"needsReview":{"type":"boolean"},
            "reviewStatus":{"enum":["all","active","open","in-progress","resolved"]},
            "sort":{"enum":["date","priority","value"]},"limit":{"type":"integer","minimum":1,"maximum":100},
            "offset":{"type":"integer","minimum":0,"maximum":1000000}
        }), &[]), json!({"type":"object","properties":{"orders":{"type":"array","items":{"type":"object"}},"total":{"type":"integer"},"offset":{"type":"integer"},"limit":{"type":"integer"}},"required":["orders","total","offset","limit"]}), false),
        build("orders.get", "Read one complete invoice, source spreadsheet row numbers, immutable line items, computed review reasons, and current shared review status.", Some("orders:read"), object(json!({"id":text}), &["id"]), json!({"type":"object","properties":{"order":{"type":"object"},"items":{"type":"array","items":{"type":"object"}}},"required":["order","items"]}), false),
        build("orders.summary", "Get dataset provenance, transformation rules, exact integer-pence totals, countries, and shared review counts. Historical retail data is not a live order system.", Some("orders:read"), object(json!({}), &[]), json!({"type":"object"}), false),
        build("reviews.update", "Update the shared review overlay for a flagged invoice. Use its current expectedVersion (initially 0). Both the order table and work feed see the same update. This never changes historical source data, issues refunds, or contacts customers.", Some("reviews:write"), object(json!({"id":text,"status":{"enum":["open","in-progress","resolved"]},"note":{"type":"string","maxLength":2000},"expectedVersion":{"type":"integer","minimum":0,"maximum":4294967295u64}}), &["id","status","expectedVersion"]), json!({"type":"object"}), false),
    ]);
    result
}
pub fn contract() -> Value {
    json!({"protocol":"fluid-app","version":VERSION,"appId":APP_ID,"name":"Fluid Workspace","capabilities":capabilities(),
    "semantics":{
        "task":"A unit of work. Every frontend and agent shares the same records.",
        "status":{"todo":"Not started","in-progress":"Actively being worked on","done":"Completed"},
        "dates":"dueDate is YYYY-MM-DD without a timezone. Timestamps are ISO 8601 UTC.",
        "permissions":"Grants are checked on every call. Write does not imply delete. Frontend access cannot modify grants, keys, or native shell controls.",
        "frontends":"The frontend belongs to the user. Any authorized agent can retrieve, publish, activate, or restore complete source. Shipped originals remain available as recovery copies. New artifacts start with no grants; requested scopes need user authorization.",
        "subscriptions":"fluid.subscribe(callback) is an invalidation signal: query current state again.",
        "concurrency":"For frontends.put use expectedVersion 0 when creating and the current version when updating. Stale writes return VERSION_CONFLICT. reviews.update also requires its current expectedVersion.",
        "commerce":"Real UCI Online Retail data: complete invoices grouped from source lines. Monetary amounts use integer pence. C-prefixed invoices and negative quantities are cancellations. Source data is immutable; review rules and statuses are a demo overlay shared by every frontend and agent. No shipping status or live business event is invented."
    }})
}
