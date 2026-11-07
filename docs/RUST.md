# Why the core is Rust

The app has a stable authority and a fluid presentation. Rust owns that authority: the contract, validation, task operations, permissions, persistence, and transports. JavaScript remains useful for arbitrary user-written interfaces and the existing desktop/provider integrations.

## Module layout

| Location                             | Responsibility                                                       |
| ------------------------------------ | -------------------------------------------------------------------- |
| `crates/fluid-protocol`              | App-independent manifests, capability types, inspection, wire errors |
| `crates/fluid-host/src/model.rs`     | This app's task model and saved settings                             |
| `crates/fluid-host/src/contract.rs`  | Single executable tool registry and schemas                          |
| `crates/fluid-host/src/host.rs`      | Authorization, sessions, SQLite transactions, source lifecycle       |
| `crates/fluid-host/src/transport.rs` | Axum HTTP MCP, authentication, native stdio adapter                  |
| `src/core/host.ts`                   | Desktop/dev child-process adapter and notifications                  |
| `src/protocol/generated.ts`          | Generated Rust declarations, never hand-maintained                   |

`npm run native:build` compiles an explicit native Cargo target and exports TypeScript declarations, the contract, and defaults. Development binaries are staged under `.fluid/native/<os>-<arch>/`, independent of Cargo's output-directory settings. `npm run build` does this before compiling the shell. Packaging builds the selected Electron architecture and verifies the staged binary's version and checksum after copying it. A packaged app ships the executable at `Contents/Resources/native/fluid-host` on macOS. MCP stdio invokes that executable directly, without Node.

MSVC targets statically link the C runtime through `.cargo/config.toml`. Windows CI inspects the host's DLL imports and rejects a dependency on Visual C++ redistributable DLLs, which may be present on developer machines but absent on a clean user's computer.

## Concrete improvements

- **One implementation of authority.** Desktop IPC, HTML frontends, WebMCP, and MCP all reach Rust. Schemas compile once per host, and inspection uses the execution registry.
- **Incremental persistence.** SQLite transactions update rows instead of cloning and serializing the entire workspace after each task change. Data, audit, and revision succeed or fail together.
- **Cheaper repeated work.** Cached prepared statements, primary-key updates, indexed filters, precomputed search text, and metadata-only snapshots avoid repeated parsing and copying. Capability calls read frontend identity metadata without loading source. Interface source is fetched when rendering, editing, exporting, or generating a proposal.
- **Independent transports.** The native executable hosts MCP HTTP and acts as an MCP stdio client adapter. It can be reused without a JavaScript runtime.
- **Controlled concurrency.** Tokio handles transport IO; blocking database work runs outside async workers behind one host owner. This preserves consistent permissions and versions across concurrent callers.

The native process still exchanges JSON with the shell, and full task lists or frontend source must still be serialized when requested. Search uses substring matching rather than a full-text index. The host is optimized for a local single-user app, not an unbounded data service.

The alpha source/history regression uses one 400 KB custom interface with ten retained versions. Its snapshot after a small task creation decreased from approximately 4.4 MB to 5.4 KB. This is a payload-size measurement, not an end-to-end latency guarantee.

## Measurements

A release-mode manual benchmark on the development Mac completed 1,000 transactional task creates in approximately **84 ms**, then 100 filtered reads of 500 rows each in approximately **92 ms**. This exercises the real Rust host with schema validation, audit, revisions, and JSON value construction against an in-memory SQLite database. It excludes disk synchronization, IPC, frontend rendering, and provider latency. No controlled comparison with the old TypeScript implementation has been made.

Reproduce with:

```sh
cargo test --release measure_native_operations -- --ignored --nocapture
```

The alpha release executable is approximately **10 MB** on macOS arm64 with stripping and thin LTO, including the embedded commerce dataset. Electron and its dependencies remain the largest part of the packaged app. A future native shell could reduce that cost, but is a separate change requiring a new sandbox and platform-integration review.

## Validation

Rust tests cover rollback on a failed write, live grants, source versions, session invalidation, and legacy import failure. TypeScript integration tests launch the real native process, restart its SQLite database, and connect independent standard MCP clients over stdio and Streamable HTTP. Desktop tests exercise custom code, permission review, helper generation, full-canvas activation, recovery, and the live tools inspector.

Dependency references: [rusqlite](https://docs.rs/rusqlite/latest/rusqlite/), [Axum](https://docs.rs/axum/latest/axum/), [ts-rs](https://docs.rs/ts-rs/latest/ts_rs/), and [MCP transport specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).
