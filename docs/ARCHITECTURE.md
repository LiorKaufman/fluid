# Reference architecture

## One native host per app

Fluid standardizes discovery, invocation, authorization, and frontend lifecycle. Each app implements its own domain and runs its own host. The task workspace is a reference implementation, not a mandatory task-shaped backend.

`crates/fluid-protocol` holds language-neutral wire types, manifests, tool definitions, and errors. `crates/fluid-host` owns the task model, validated registry, SQLite persistence, grants, sessions, history, audit, and MCP transports. Rust generates the TypeScript declarations and contract used by the shell and helper. A change to the registry reaches discovery and execution together.

The default list, board, focus view, imported HTML, WebMCP, and external MCP all invoke the same Rust execution path. `src/core/host.ts` is a child-process adapter; it has no parallel TypeScript task implementation. Management requests travel over the parent's private stdin/stdout channel. Public HTTP supports capability calls only.

## Storage and change delivery

SQLite stores tasks as rows, with indexes for status, project, and due date; primary-key updates touch a single task. Prepared statements are cached. Search uses Unicode-lowercased title and notes. Manifests, recent history, preferences, grants, and activity live in the same database.

Each mutation commits its data, audit entry, and revision atomically. WAL mode permits concurrent readers; synchronous FULL retains SQLite's durable commit behavior. The Rust host serializes its operations through one database owner. It is not a multi-user server. The desktop also takes a single-instance lock.

An uninitialized database imports legacy JSON in a transaction, without rewriting or deleting the original. Invalid legacy data aborts initialization. Shipped recovery interfaces refresh on startup without overwriting custom artifacts or expanding grants. The host rejects databases with a newer schema version.

Committed revisions generate invalidation signals through the parent process to frontends. Clients then query current state. Trusted-shell snapshots contain interface and history metadata, without HTML. Source is fetched on demand and cached by identity, version, and update timestamp. Snapshots are read directly so an MCP response arriving before its change notification cannot expose a stale cached snapshot. Browser preview polls the small revision value.

Database schema 2 stores interface metadata separately from source. Opening a schema-1 database transactionally populates the metadata columns while preserving source, history, grants, and task records. Older apps reject the newer schema rather than attempting a downgrade.

## User-owned frontend

The frontend artifact contains complete HTML, CSS, and JavaScript. Users can edit, import, export, fork, and restore it. Authorized agents can retrieve the same source through `frontends.get`, publish through `frontends.put`, and activate it. Updates require the expected current version. Stale writes fail rather than silently replacing another edit.

Full-canvas mode gives the artifact the whole app body. A trusted recovery button restores controls; the native title-bar area remains available to move the window. The helper button is optional. Custom code cannot remove recovery controls, grant permissions, read provider keys, or overwrite the shipped originals. New artifacts receive no grants. Updates retain only the intersection of existing grants and requested scopes and expire previous sessions.

The **Exposed tools** page reads the running host's registry for the selected frontend or external agent. It shows current grants, availability reasons, transports, annotations, and schemas. MCP `tools/list` filters this same registry to callable tools; every invocation checks grants again. All external clients currently share one agent profile and process token.

Capability inputs pass both JSON Schema validation and fallible typed decoding where numeric representation matters. A schema-valid floating-point representation cannot reach an unchecked integer unwrap. Internal storage errors retain their source chain; wire replies omit it. Native stderr diagnostics report error categories and numeric codes without SQL, paths, or record content.

## Frontend runtime

The trusted React shell creates a native host session and a MessageChannel, then loads the artifact into a sandboxed opaque-origin iframe. The injected SDK exposes `call` and `subscribe`. Frontend code cannot reach the parent DOM, Electron preload, local storage, or Node. The default frontend has no special data pathway.

The iframe CSP disables fetch, remote assets, nested frames, network form submissions, objects, and base URLs. Inline scripts and styles are allowed. JavaScript form events can use `preventDefault`; actual submissions remain blocked. Electron additionally denies new windows, webviews, iframe navigations, non-local network requests, and Chromium device permission requests. Preload exposes fixed request and notification channels only to the main frame, with context isolation and process sandboxing. Main-process IPC validates sender and frame identity.

Rust HTTP binds only to loopback on a random port, validates Host and browser Origin, limits request size, and compares a per-process bearer token in constant time. The public discovery document contains no token or records. MCP supports native stdio and stateless Streamable HTTP JSON responses. Optional WebMCP registers currently exposed tools under the active frontend's grants.

## Helper and credentials

The trusted Node helper remains separate from frontend capabilities. It handles provider discovery, generation, cancellation, and proposals. Supported adapters include signed-in Codex and Claude Code CLIs, OpenAI Responses, Anthropic Messages, compatible APIs, and Ollama. Subscription reuse requires a provider-supported integration; arbitrary browser subscriptions are not universal API credentials.

Generation receives frontend source, the contract, and recent conversation. It does not query task records. Code stays a proposal until the user applies it through normal permission review. Proposals bind to the original frontend version, preventing stale application. Local agents run in temporary directories; Codex uses a read-only sandbox and Claude Code runs with built-in and MCP tools disabled. Native agents remain trusted programs.

API keys stay outside workspace state. Electron supplies OS-backed `safeStorage` encryption when secure storage is available; otherwise entered keys remain in memory. Compatible keys bind to their base URL. Remote APIs require HTTPS, disallow embedded URL credentials/query strings, and do not follow redirects. Environment OpenAI/Anthropic keys are used only at their official endpoints. The browser preview keeps entered keys in memory.

## Practical limits

Electron remains the shell; this change does not remove Chromium's memory cost. Rust owns the domain and transport work. The app core, shell, local filesystem owner, and native programs are trusted. Frontend sandboxing has not had a full security audit, and arbitrary JavaScript can consume CPU or memory. Resource quotas and hostile-artifact fuzzing remain future work.

Workspace data is unencrypted local SQLite. On Unix, the database and existing WAL/shared-memory files receive mode 0600; new sidecars inherit the database mode. File-mode guarantees vary by platform. API keys use separate encrypted or session-only storage.

Browser preview's management endpoint requires a custom header and matching Origin/Host. Privileged local processes can call it; the desktop's IPC channel is the intended deployment. Browser CSP blocks subresources, while Electron supplies additional navigation controls.

There is no multi-user authentication, hosted service, synchronization, telemetry, background AI generation, or per-agent identity federation. Model requests occur when the user sends a helper message and use the chosen provider's account limits.

## Porting to another app

1. Define the app's entities and domain meanings.
2. Define tools with validated input schemas and explicit scopes.
3. Implement operations and persistence in an app-specific host crate.
4. Reuse the generic protocol types, generate client bindings, and add transports.
5. Adapt the shell, artifact validation, and grants to the app.
6. Ship materially different frontends against the same capabilities.

See [the protocol](PROTOCOL.md) and [Rust implementation and measurements](RUST.md).
