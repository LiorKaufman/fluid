# Fluid App Protocol — draft 0.1

Status: experimental, implemented by this repository. This document is a project protocol, not a web standard.

## Model

An app defines stable capabilities. A frontend is an installable artifact that calls those capabilities. The host binds each running frontend to its own identity and grants. An app ships a default frontend and may ship others. Each app runs its own host and retains its own native integrations.

## App contract

The discoverable contract contains:

- `protocol: "fluid-app"` and `version: "0.1"`.
- A stable `appId`, independent of frontend identity.
- Capabilities with `name`, `description`, `permission`, `inputSchema`, and `outputSchema`.
- Domain semantics for entity meanings, status values, dates, effects, and subscriptions.

The reference contract is defined in Rust at `crates/fluid-host/src/contract.rs`, generated into `src/protocol/contract.json`, available from `workspace.describe`, and downloadable in the app. Input schemas use JSON Schema, compiled once by Rust's `jsonschema` crate. The host validates every input; permission checks and business rules remain authoritative. Rust wire types generate the TypeScript client declarations.

## Frontend artifact

An artifact is a UTF-8 JSON file, conventionally named `name.fluid.json`:

```json
{
  "id": "my-workspace",
  "name": "My workspace",
  "description": "A view that works for me.",
  "author": "You",
  "appId": "org.fluidprotocol.workspace",
  "protocol": "0.1",
  "permissions": ["tasks:read", "tasks:write"],
  "html": "<h1>Hello</h1><script>fluid.call('tasks.list').then(console.log)</script>"
}
```

IDs contain 1–80 ASCII letters, digits, underscores, or hyphens. Names contain 1–80 characters. HTML is limited to 500,000 JavaScript string code units. Assets must be inline or data URLs. The host assigns a monotonically increasing `version` and `updatedAt` when installing. Artifact flags and requested scopes cannot grant authority. The app ID and protocol version must match exactly in 0.1. An ID matching a shipped interface cannot be overwritten; use a new ID to fork it.

Capability requests have a 4 MiB wire limit across MCP HTTP, MCP stdio, native management calls, and the browser development adapter. This accommodates the source limit even with UTF-8 expansion or JSON Unicode escapes, plus normal manifest overhead. Interface imports and exports use the same wire limit. Version fields are unsigned 32-bit integers; unsupported numeric representations return `INVALID_INPUT` rather than panicking.

The reference host reserves `external-agent`, `__proto__`, `constructor`, and `prototype` as artifact IDs.

Updating an existing custom ID replaces its code, increments its version, intersects existing grants with the new requested permissions, and invalidates previous sessions. Newly requested permissions are never granted automatically. A new ID starts with zero grants. An interface can be installed without immediately activating it. The reference host retains the last ten previous versions of each custom artifact. Restoring one installs its content as a new version, without expanding grants.

Agent publication requires `expectedVersion`: zero creates a new ID; the exact current version updates one. A mismatch returns `VERSION_CONFLICT`. Trusted-shell edits also carry the version they were based on. Source publication and activation are separate operations. Activation may specify `canvasMode: true`, filling the app body while retaining a trusted recovery control. It does not grant data access.

## Frontend SDK and transport

The host injects a frozen `window.fluid` object before frontend code runs:

```ts
interface Fluid {
  readonly version: '0.1';
  call<T = unknown>(name: string, input?: object): Promise<T>;
  subscribe(callback: () => void): () => void;
}
```

Calls queue until the host handshake completes. Requests time out after 12 seconds once connected. At most 100 calls may be pending per frontend. A rejected call is an Error with a machine-readable `code` and human-readable `message`.

The reference transport uses a sandboxed, opaque-origin `srcdoc` iframe and a dedicated MessageChannel. A per-document handshake ID prevents stale frames from taking a newer document's port. The shell verifies the message source, binds its port to a host-created session, and never accepts a client identity supplied by the frontend. Session tokens remain in the shell.

Frontend-to-host port messages:

```json
{ "id": "1", "capability": "tasks.list", "input": {} }
```

Host replies:

```json
{ "id": "1", "ok": true, "value": { "tasks": [], "revision": 1 } }
```

```json
{
  "id": "1",
  "ok": false,
  "error": { "code": "PERMISSION_DENIED", "message": "…" }
}
```

Change notifications are `{ "type": "changed" }`. They are invalidation signals, not a guaranteed event log. Subscribe, then query for current state. The reference runtime signals task changes and permission changes; audit-only reads/denials do not trigger unbounded re-query loops. Revisions are monotonically increasing within one persisted app state; a task-list revision may also advance after host management changes.

## Authorization

The trusted shell owns grants and removal. Users may also delegate source installation, activation, and history restoration through `frontends:write`; source retrieval requires `frontends:read`. Frontends and agents cannot grant themselves permissions. The host checks the session and current grants on every call, independent of button visibility. Revocation affects running sessions. A write grant does not imply a delete grant. Responses cross a serialized process transport, so a client cannot mutate core state by reference.

`workspace.describe` and `tools.inspect` need no data scope; they return no task records or source code. External clients must still be enabled and authenticated. Stable errors include `PERMISSION_DENIED`, `INVALID_INPUT`, `NOT_FOUND`, `UNKNOWN_CAPABILITY`, `SESSION_EXPIRED`, `INCOMPATIBLE_FRONTEND`, `INVALID_FRONTEND`, `BUILTIN_FRONTEND`, `VERSION_CONFLICT`, and `STORAGE_ERROR`.

## Reference tools

| Tool                 | Required scope    | Behavior                                           |
| -------------------- | ----------------- | -------------------------------------------------- |
| `workspace.describe` | None              | Contract, meanings, current grants, runtime        |
| `tools.inspect`      | None              | Actual tool exposure, reasons, schemas, transports |
| `tasks.list`         | `tasks:read`      | Shared tasks; status, project, and search filters  |
| `tasks.create`       | `tasks:write`     | Create a validated task                            |
| `tasks.update`       | `tasks:write`     | Update provided fields, preserve omitted fields    |
| `tasks.delete`       | `tasks:delete`    | Permanently delete a task                          |
| `frontends.list`     | `frontends:read`  | Installed metadata, active ID, versions            |
| `frontends.get`      | `frontends:read`  | Full current or historical source artifact         |
| `frontends.put`      | `frontends:write` | Publish source with `expectedVersion`              |
| `frontends.activate` | `frontends:write` | Activate, optionally in full-canvas mode           |
| `frontends.restore`  | `frontends:write` | Restore history with `expectedVersion`             |

For example, an authorized agent can retrieve a shipped interface, change its source, publish a fork, then activate it:

```js
const base = await call('frontends.get', { id: 'studio' });
const saved = await call('frontends.put', {
  frontend: {
    ...base,
    id: 'my-canvas',
    name: 'My canvas',
    html: '<h1>Yours</h1>',
  },
  expectedVersion: 0,
});
await call('frontends.activate', { id: saved.id, canvasMode: true });
```

The new ID starts without data grants. Users review and grant requested access through the trusted Permissions page. Inspection and execution use the same registry and grant checks. The **Exposed tools** page additionally lets users inspect any installed frontend or the shared external-agent profile; the `tools.inspect` capability itself reports only its caller.

## Commerce reference domain

The real-data demo adds `orders.list`, `orders.get`, and `orders.summary` under `orders:read`, and version-checked `reviews.update` under `reviews:write`. These use the same registry, execution, source-artifact lifecycle, and MCP transports as the task domain. Historical source records stay immutable; mutable review state is separate and shared by all clients. See [the commerce guide](COMMERCE-DEMO.md).

## Agent adapters

The WebMCP adapter registers callable capabilities and executes them under the active frontend's grants. It feature-detects `document.modelContext` and refreshes registration when source or grants change.

The Rust host exposes MCP over native stdio and Streamable HTTP. Its HTTP listener binds to `127.0.0.1` on a random port, requires a per-process bearer token, and allows no capabilities until enabled in the shell. All external clients share one agent profile, whose grants are checked per call. `tools/list` returns only currently callable definitions; `tools/call` checks grants again, so a previously listed tool can be denied after revocation.

The standard `/mcp` endpoint implements JSON-RPC initialization, ping, tool listing, and invocation, using protocol revision `2025-06-18`. It is a stateless Streamable HTTP transport using JSON responses; GET/DELETE return 405 and no SSE stream is required. `fluid-host mcp` uses stdin/stdout JSON-RPC and relays to this endpoint. It reads `FLUID_URL` and `FLUID_AGENT_TOKEN` from the environment. It requires no Node runtime. The app's Connect dialog generates either configuration.

`GET /.well-known/fluid` returns public protocol and transport metadata without records, source, keys, or tokens. It does not scan devices or connect accounts. The connection token is displayed only in trusted controls and rotates after a host restart.

The compatibility endpoint `/__fluid/agent` accepts only capability calls with the same authentication and grants:

```json
{ "method": "call", "args": ["tasks.list", {}] }
```

Neither HTTP endpoint exposes privileged host management, grant changes, provider settings, or keys. Frontend source lifecycle is available only through its explicitly granted capabilities. Requests with an unexpected Host or browser Origin are rejected. The token never enters frontend HTML or the frontend SDK.

WebMCP is an independent evolving specification. Fluid's `postMessage` wire contract and external stdio adapter do not depend on WebMCP being present.

## Deferred

Compatibility ranges, named queries across different app domains, transactions across multiple capabilities, identity federation, signed artifacts, remote distribution, and negotiated network access are outside 0.1. Hosts should document their support before accepting artifacts that depend on them.
