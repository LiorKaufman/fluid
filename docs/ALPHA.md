# Alpha 0.3.0-alpha.1

Fluid is an experimental desktop reference app and runtime for replaceable interfaces. It is not yet a published general-purpose SDK. This alpha supports one local user, SQLite persistence, offline self-contained frontends, and the task and commerce reference domains.

## Platform status

| Platform            | Native target              | Verification                                                   |
| ------------------- | -------------------------- | -------------------------------------------------------------- |
| macOS Apple Silicon | `aarch64-apple-darwin`     | Local archive build and all five packaged desktop tests passed |
| macOS Intel         | `x86_64-apple-darwin`      | CI configured; runner verification pending                     |
| Windows x64         | `x86_64-pc-windows-msvc`   | CI configured; runner verification pending                     |
| Linux x64           | `x86_64-unknown-linux-gnu` | CI configured on Ubuntu 22.04; runner verification pending     |

Only claim a platform is verified after its native build, integration tests, and packaged desktop tests pass. Check the [Alpha validation workflow](https://github.com/LiorKaufman/fluid/actions/workflows/alpha.yml) for current runner results. Linux ARM64 and Windows ARM64 have target mappings but are outside this alpha's verified matrix. Universal macOS packages and cross-OS builds are not supported by the alpha packaging hooks.

## Build and verify

Build on the operating system you intend to distribute. Development requires Rust 1.97+ (CI uses 1.97.1), a C/C++ toolchain for bundled SQLite, and Node 24 with npm. Packaged apps include their runtimes and need no separate Rust or Node installation.

```sh
npm ci
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
npm run build
npm test
npm run format:check
npm run package:alpha
npm run test:packaged -- --archive
```

On headless Linux, run the final command with `xvfb-run -a`. The packaged tests use temporary data directories and exercise interface replacement, permissions, persistence, native MCP, helper proposals through a local test provider, full-canvas recovery, and shared commerce reviews. They do not make paid model requests.

`npm run package` creates an unpacked app. `npm run package:alpha` creates a ZIP on macOS/Windows or a `tar.gz` on Linux, plus `release/SHA256SUMS.txt`. Archive names include version, OS, and architecture. `npm run test:packaged -- --archive` verifies the archive checksum, extracts a fresh copy, and tests that executable. Plain `npm run test:packaged` tests the unpacked staging app. You can also pass an executable path with `npm run test:packaged -- "/path/to/executable"` or set `FLUID_PACKAGED_APP`.

For another architecture on the same OS, install its Rust target with `rustup target add <target>`, then pass the corresponding Electron flag, for example `npm run package:alpha -- --x64`. Binding generation runs with the build machine's executable; packaging separately compiles the requested target. Packaging rejects unsupported targets and verifies the copied native host's target, version, and checksum.

## Distribution and data

Archives are unsigned and macOS builds are not notarized. They are intended for technical alpha testers and may require operating-system approval to open. Automatic updates and installers are outside this alpha. Distribute the archive with its checksum and this scope statement.

Before testing with an existing workspace, quit Fluid and back up its entire user-data directory, including any SQLite sidecars. The alpha upgrades schema 1 to schema 2. Older builds reject that upgraded database. To keep experiments separate, launch with `FLUID_DATA_DIR` pointing at a new directory.

No AI account is required for tasks or manual interface editing. The helper needs a configured provider for real generation. Frontend sandboxing has not had a full security audit; the native app, local processes, and filesystem owner remain trusted. External agents currently share one permission profile.

## Local validation record

Local verification on 2026-11-07 passed nine native tests (one manual benchmark intentionally ignored), all 33 TypeScript integration/packaging tests, TypeScript checking, Clippy with warnings denied, Rust formatting, and Prettier. All five desktop tests also passed against a fresh extraction of `Fluid-0.3.0-alpha.1-mac-arm64.zip` after checksum verification. Regression coverage includes numeric input, Unicode and escaped source through both MCP transports, storage-error privacy, and schema-1 migration.

The local source/history reproduction dropped from approximately 4.4 MB to 5.4 KB per snapshot after a small task creation. Packaging verification also rejected an ARM host staged for an Intel target. Review found no remaining actionable findings in the implemented changes.

The release gate for the other three platforms remains their first green CI run. The workflow uploads archives only after the packaged desktop tests pass and never publishes a release automatically.
