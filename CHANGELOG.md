# Changelog

## 0.3.0-alpha.1

- Reject unsupported numeric version representations without crashing or disabling the host.
- Separate interface metadata from source, with a transactional schema-1 migration preserving source, history, and grants.
- Load interface source only when needed; task edits no longer transfer every historical source version.
- Keep shell snapshots current after external MCP writes.
- Preserve internal storage error causes and report safe diagnostic categories.
- Accept large Unicode and escaped interface source consistently across transports.
- Build and verify architecture-specific Rust hosts for desktop packages.
- Link the Windows host's C runtime statically and verify DLL imports in CI.
- Add unsigned alpha archives, SHA-256 checksums, packaged desktop verification, and a macOS/Windows/Linux CI matrix.

The app is experimental, local, and single-user. Protocol 0.1 remains experimental. See [alpha scope and platform status](docs/ALPHA.md).
