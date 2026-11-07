import { useEffect, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Cpu,
  GitBranch,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import type { Snapshot, ToolInspection } from '../protocol/index';
import { backend } from '../runtime/backend';

export function ExposedTools({
  snapshot,
  onConnect,
  onSource,
  notify,
}: {
  snapshot: Snapshot;
  onConnect: () => void;
  onSource: (id: string) => void;
  notify: (message: string) => void;
}) {
  const [client, setClient] = useState('external-agent'),
    [inspection, setInspection] = useState<ToolInspection>(),
    [search, setSearch] = useState(''),
    [exposedOnly, setExposedOnly] = useState(false),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    if (
      client !== 'external-agent' &&
      !snapshot.frontends.some((f) => f.id === client)
    ) {
      setClient('external-agent');
      return;
    }
    void backend
      .request<ToolInspection>('tools.inspect', client)
      .then((value) => {
        if (!cancelled) {
          setInspection(value);
          setError('');
        }
      })
      .catch((error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [client, snapshot.revision, refresh]);
  const copy = (value: unknown) => {
    void navigator.clipboard
      .writeText(JSON.stringify(value, null, 2))
      .then(() => notify('Tool definition copied.'))
      .catch(() =>
        notify('Clipboard is unavailable. Use Export tool manifest.'),
      );
  };
  const exportManifest = async () => {
    if (!inspection) return;
    const manifest = {
      protocol: 'fluid-app',
      engine: inspection.engine,
      client: inspection.clientId,
      enabled: inspection.enabled,
      grantedPermissions: inspection.grants,
      transports: inspection.transports,
      tools: inspection.tools.filter((t) => t.exposed),
    };
    const content = JSON.stringify(manifest, null, 2);
    if (window.fluidDesktop) {
      await backend.request('saveFile', 'fluid-exposed-tools.json', content);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([content], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'fluid-exposed-tools.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const exposed = inspection?.tools.filter((t) => t.exposed).length ?? 0;
  const tools =
    inspection?.tools.filter(
      (t) =>
        (!exposedOnly || t.exposed) &&
        `${t.name} ${t.description} ${t.permission ?? ''}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    ) ?? [];
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">AN OPEN CONTRACT. A CLEAR VIEW.</div>
          <h1>See what your agent can actually do.</h1>
          <p>
            Live discovery from the Rust host. The same grants and schemas
            govern your interface, WebMCP, and external agents.
          </p>
        </div>
        <div className="page-heading-actions">
          <button
            className="button"
            onClick={() => {
              void exportManifest().catch((error) => notify(error.message));
            }}
          >
            <ArrowDownToLine size={14} />
            Export tool manifest
          </button>
          <button className="button primary" onClick={onConnect}>
            <Terminal size={14} />
            Connect an agent
          </button>
        </div>
      </div>
      <div className="tools-runtime">
        <span className="rust-mark">
          <Cpu size={23} />
        </span>
        <div>
          <strong>One native host. One source of truth.</strong>
          <p>
            Rust protocol · SQLite transactions · generated TypeScript bindings
          </p>
        </div>
        <span className="small-badge">LIVE REGISTRY</span>
      </div>
      <div className="tools-selector">
        <label>
          Inspect access for
          <select
            aria-label="Inspect tools for client"
            value={client}
            onChange={(e) => setClient(e.target.value)}
          >
            <option value="external-agent">External agents · MCP</option>
            {snapshot.frontends.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
                {snapshot.activeId === f.id
                  ? ' · active interface'
                  : ' · interface'}
              </option>
            ))}
          </select>
        </label>
        <div className="tools-count">
          <strong>{exposed}</strong>
          <span>exposed tools</span>
          <small>{(inspection?.tools.length ?? 0) - exposed} unavailable</small>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh exposed tools"
          onClick={() => setRefresh((n) => n + 1)}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      {inspection && !inspection.enabled && (
        <div className="tools-disabled">
          <LockKeyhole size={17} />
          <div>
            <strong>External agent access is off.</strong>
            <p>
              Enable access and choose exactly what to expose in Connect an
              agent. No tools are callable while access is disabled.
            </p>
          </div>
          <button className="text-button" onClick={onConnect}>
            Manage access
            <ArrowRight size={12} />
          </button>
        </div>
      )}
      {inspection && (
        <div className="tools-grants">
          <span>CURRENT GRANTS</span>
          {inspection.grants.length ? (
            inspection.grants.map((scope) => <code key={scope}>{scope}</code>)
          ) : (
            <small>No permission grants</small>
          )}
          <div>
            {inspection.transports.map((transport) => (
              <small key={transport}>{transport}</small>
            ))}
          </div>
        </div>
      )}
      <div className="tools-filter">
        <label>
          <Search size={14} />
          <input
            aria-label="Search exposed tools"
            placeholder="Find a tool or permission…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="exposed-only">
          <input
            type="checkbox"
            checked={exposedOnly}
            onChange={(e) => setExposedOnly(e.target.checked)}
          />
          Exposed only
        </label>
      </div>
      {error && (
        <p className="assistant-settings-error" role="alert">
          {error}
        </p>
      )}
      <div className="capability-list tools-list">
        {tools.map((tool) => (
          <details
            className={`capability-card ${tool.exposed ? 'tool-exposed' : 'tool-blocked'}`}
            key={tool.name}
          >
            <summary>
              <span
                className={`tool-availability ${tool.exposed ? 'available' : ''}`}
              >
                {tool.exposed ? <Check size={14} /> : <LockKeyhole size={13} />}
              </span>
              <div>
                <code>{tool.name}</code>
                <p>{tool.description}</p>
              </div>
              <span
                className={`tool-exposure-label ${tool.exposed ? 'available' : ''}`}
              >
                {tool.exposed ? 'Exposed' : 'Unavailable'}
              </span>
              <ChevronDown size={14} />
            </summary>
            <div className="tool-detail">
              <div className="tool-authority">
                <span>
                  <ShieldCheck size={13} />
                  {tool.reason}
                </span>
                <code>
                  {tool.permission ?? 'Public contract · no scope required'}
                </code>
              </div>
              <div className="tool-schema-grid">
                <div className="schema-block">
                  <div>
                    <span>INPUT SCHEMA</span>
                    <button
                      className="text-button"
                      onClick={() =>
                        copy({ name: tool.name, inputSchema: tool.inputSchema })
                      }
                    >
                      <Copy size={11} />
                      Copy
                    </button>
                  </div>
                  <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                </div>
                <div className="schema-block">
                  <span>OUTPUT SCHEMA</span>
                  <pre>{JSON.stringify(tool.outputSchema, null, 2)}</pre>
                  <div className="tool-hints">
                    <small>
                      {tool.annotations.readOnlyHint
                        ? 'Read only'
                        : 'Can change app state'}
                    </small>
                    {tool.annotations.destructiveHint && (
                      <small>Permanent deletion</small>
                    )}
                    <small>Network access: no</small>
                  </div>
                </div>
              </div>
            </div>
          </details>
        ))}
      </div>
      {!tools.length && (
        <div className="empty-state">
          <Search size={25} />
          <h2>No matching tools.</h2>
          <p>Try another filter or inspect another client.</p>
        </div>
      )}
      <div className="frontend-control-note">
        <Code2 size={23} />
        <div>
          <h2>The frontend belongs to you.</h2>
          <p>
            An authorized agent can read complete source, publish a replacement
            with version checks, activate it, and restore an earlier version.
            You control its permissions.
          </p>
          <div>
            <code>frontends.get</code>
            <ArrowRight size={11} />
            <code>frontends.put</code>
            <ArrowRight size={11} />
            <code>frontends.activate</code>
          </div>
        </div>
        <button
          className="button"
          onClick={() =>
            onSource(client === 'external-agent' ? snapshot.activeId : client)
          }
        >
          Open frontend source
          <ArrowRight size={12} />
        </button>
      </div>
      <div className="architecture-note">
        <span>USER GRANTS</span>
        <GitBranch size={14} />
        <span>RUST CAPABILITY HOST</span>
        <ArrowRight size={14} />
        <span>ANY AUTHORIZED CLIENT</span>
      </div>
    </>
  );
}
