import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Blocks,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Circle,
  Code2,
  Copy,
  ExternalLink,
  Expand,
  FileCode2,
  FolderOpen,
  GitBranch,
  Globe2,
  LayoutDashboard,
  LayoutGrid,
  Leaf,
  List,
  Loader2,
  LockKeyhole,
  Monitor,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  Radio,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Sprout,
  Terminal,
  Trash2,
  Upload,
  WandSparkles,
  X,
  Zap,
} from 'lucide-react';
import {
  APP_ID,
  MAX_REQUEST_BYTES,
  PROTOCOL_VERSION,
  capabilities,
  contract,
  permissions,
  type Frontend,
  type FrontendSummary,
  type Permission,
  type Snapshot,
} from '../protocol/index';
import { backend } from '../runtime/backend';
import { Surface } from '../runtime/Surface';
import { frontendSource } from '../runtime/frontend-source';
import { connectWebMcp, webMcpAvailable } from '../runtime/webmcp';
import type { Connection } from '../core/server';
import { AssistantHelper, AssistantSettingsPage } from './Assistant';
import { ExposedTools } from './ExposedTools';
import { CommerceDemo } from '../commerce/CommerceDemo';

type Page =
  | 'workspace'
  | 'interfaces'
  | 'capabilities'
  | 'permissions'
  | 'activity'
  | 'commerce'
  | 'settings';
const labels: Record<Page, string> = {
  workspace: 'Workspace',
  interfaces: 'Interfaces',
  capabilities: 'Exposed tools',
  permissions: 'Permissions',
  activity: 'Activity',
  settings: 'Settings',
  commerce: 'Commerce demo',
};
const scopeInfo: Record<Permission, { title: string; description: string }> = {
  'tasks:read': {
    title: 'Read your tasks',
    description: 'View task names, notes, projects, and dates.',
  },
  'tasks:write': {
    title: 'Create and edit tasks',
    description: 'Add work, update details, and mark things complete.',
  },
  'tasks:delete': {
    title: 'Delete tasks',
    description: 'Permanently remove tasks from your workspace.',
  },
  'frontends:read': {
    title: 'Read interface source',
    description:
      'Read complete HTML, styles, scripts, and saved interface versions.',
  },
  'frontends:write': {
    title: 'Publish and switch interfaces',
    description:
      'Install, update, activate, and restore interfaces. Permission grants stay under your control.',
  },
  'orders:read': {
    title: 'Read commerce invoices',
    description:
      'Read the public retail dataset, source lines, calculated totals, and shared review status.',
  },
  'reviews:write': {
    title: 'Update shared commerce reviews',
    description:
      'Change demo review statuses and notes. Original transactions remain unchanged.',
  },
};
const blankHtml = `<style>
  body { margin: 0; padding: 48px; font: 15px system-ui; color: #244c3d; background: #f7f9f2; }
  h1 { font-size: 38px; font-weight: 500; letter-spacing: -1.5px; }
  button { cursor: pointer; padding: 10px 14px; border: 1px solid #dbe2d3; border-radius: 8px; background: white; color: inherit; }
  .task { padding: 16px 0; border-bottom: 1px solid #dbe2d3; display: flex; align-items: center; gap: 16px; }
  #message { color: #9b6050; }
</style>
<p>A WORKSPACE OF YOUR OWN</p>
<h1>Hello, possibility.</h1>
<p>This is your canvas. Make it feel like you.</p>
<div id="tasks"></div><p id="message"></p>
<script>
  async function render() {
    try {
      const { tasks } = await fluid.call('tasks.list');
      const container = document.getElementById('tasks');
      container.replaceChildren();
      for (const task of tasks) {
        const row = document.createElement('div'); row.className = 'task';
        const button = document.createElement('button');
        button.textContent = task.status === 'done' ? '✓' : '○';
        button.onclick = async () => {
          try { await fluid.call('tasks.update', { id: task.id, status: task.status === 'done' ? 'todo' : 'done' }); await render(); }
          catch (error) { document.getElementById('message').textContent = error.message; }
        };
        const title = document.createElement('span'); title.textContent = task.title;
        if (task.status === 'done') title.style.textDecoration = 'line-through';
        row.append(button, title); container.append(row);
      }
      document.getElementById('message').textContent = '';
    } catch (error) { document.getElementById('message').textContent = error.message; }
  }
  fluid.subscribe(render); render();
</script>`;
async function download(filename: string, value: unknown) {
  if (window.fluidDesktop) {
    await backend.request('saveFile', filename, JSON.stringify(value, null, 2));
    return;
  }
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`fluid-logo ${small ? 'small' : ''}`}>
      <span />
      <span />
      <span />
    </span>
  );
}
function Dialog({
  children,
  title,
  onClose,
  wide = false,
}: {
  children: ReactNode;
  title: string;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, textarea, select, [tabindex="0"]',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const elements = focusable(),
          first = elements[0],
          last = elements.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`dialog ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <div className="dialog-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Preview({ id, large = false }: { id: string; large?: boolean }) {
  const kind =
    id === 'board'
      ? 'board'
      : id === 'focus'
        ? 'focus'
        : id === 'studio'
          ? 'list'
          : 'custom';
  return (
    <div
      className={`interface-preview ${kind} ${large ? 'large' : ''}`}
      aria-hidden="true"
    >
      <div className="mini-sidebar">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="mini-main">
        <div className="mini-heading" />
        <div className="mini-subheading" />
        {kind === 'board' ? (
          <div className="mini-columns">
            {[1, 2, 3].map((n) => (
              <div key={n}>
                <span />
                <i />
                <i />
              </div>
            ))}
          </div>
        ) : kind === 'focus' ? (
          <>
            <div className="mini-focus">
              <span />
              <i />
              <i />
              <b />
            </div>
            <div className="mini-line" />
            <div className="mini-line" />
          </>
        ) : (
          <>
            <div className="mini-stats">
              <i />
              <i />
              <i />
            </div>
            {[1, 2, 3, 4].map((n) => (
              <div className="mini-row" key={n}>
                <i />
                <span />
                <b />
              </div>
            ))}
          </>
        )}
      </div>
      {kind === 'custom' && <Code2 className="preview-code" size={30} />}
    </div>
  );
}
export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [page, setPage] = useState<Page>(
    new URLSearchParams(location.search).get('demo') === 'commerce'
      ? 'commerce'
      : 'workspace',
  );
  const [panel, setPanel] = useState(true);
  const [toast, setToast] = useState('');
  const [fatal, setFatal] = useState('');
  const [connect, setConnect] = useState(false);
  const [commands, setCommands] = useState(false);
  const [editor, setEditor] = useState<Frontend>();
  const [consent, setConsent] = useState<Frontend>();
  const [helperOpenRequest, setHelperOpenRequest] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const notify = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 5000);
  }, []);
  const refresh = useCallback(async () => {
    try {
      const next = await backend.request<Snapshot>('snapshot');
      setFatal('');
      setSnapshot((old) => (old && old.revision >= next.revision ? old : next));
    } catch (error) {
      setFatal((error as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return backend.subscribe(() => {
      void refresh();
    });
  }, [refresh]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommands((value) => !value);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  const active = snapshot?.frontends.find((f) => f.id === snapshot.activeId);
  useEffect(() => {
    if (active && page !== 'commerce') return connectWebMcp(active.id);
  }, [
    active?.id,
    active?.version,
    page,
    JSON.stringify(active ? snapshot?.grants[active.id] : []),
  ]);
  const act = async (method: string, ...args: unknown[]) => {
    try {
      const result = await backend.request(method, ...args);
      await refresh();
      return result;
    } catch (error) {
      notify((error as Error).message);
      throw error;
    }
  };
  const activate = async (f: FrontendSummary) => {
    await act('activate', f.id);
    setPage('workspace');
    setEditor(undefined);
  };
  const newFrontend = async (base?: FrontendSummary) => {
    try {
      const source = base ? await frontendSource(base) : undefined;
      setEditor({
        id: `custom-${crypto.randomUUID().slice(0, 8)}`,
        name: base ? `${base.name}, reimagined` : 'My little workspace',
        description: 'An interface that feels like you.',
        author: 'You',
        protocol: PROTOCOL_VERSION,
        appId: APP_ID,
        permissions: base?.permissions ?? ['tasks:read', 'tasks:write'],
        version: 1,
        html: source?.html ?? blankHtml,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      notify((error as Error).message);
    }
  };
  const editFrontend = async (frontend: FrontendSummary) => {
    if (frontend.builtin) return newFrontend(frontend);
    try {
      setEditor(await frontendSource(frontend));
    } catch (error) {
      notify((error as Error).message);
    }
  };
  const save = async (f: Frontend) => {
    const installed = (await act('install', f)) as Frontend;
    setEditor(undefined);
    setPage('interfaces');
    setConsent(installed);
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    if (file.size > MAX_REQUEST_BYTES) {
      notify('Choose an interface file smaller than 4 MiB.');
      return;
    }
    try {
      const value = JSON.parse(await file.text());
      await save(value);
    } catch (error) {
      notify(
        error instanceof SyntaxError
          ? 'This file is not valid JSON.'
          : (error as Error).message,
      );
    }
  };
  if (!snapshot || !active)
    return (
      <div className="boot">
        <Logo />
        <h1>Making room for possibility.</h1>
        {fatal ? (
          <>
            <p role="alert">{fatal}</p>
            <button className="button" onClick={() => location.reload()}>
              Try again
            </button>
          </>
        ) : (
          <Loader2 className="spin" size={20} />
        )}
      </div>
    );
  if (page === 'commerce' && !editor)
    return (
      <CommerceDemo
        snapshot={snapshot}
        onBack={() => setPage('workspace')}
        onTools={() => setPage('capabilities')}
        onEdit={(frontend) => {
          newFrontend(frontend);
          setPage('interfaces');
        }}
      />
    );
  const nav = (id: Page, icon: ReactNode, suffix?: ReactNode) => (
    <button
      aria-label={labels[id]}
      className={`nav-item ${page === id && !editor ? 'active' : ''}`}
      onClick={() => {
        setPage(id);
        setEditor(undefined);
      }}
    >
      {icon}
      <span>{labels[id]}</span>
      {suffix}
    </button>
  );
  return (
    <div
      className={`app ${window.fluidDesktop ? 'desktop' : 'browser'} ${snapshot.canvasMode && page === 'workspace' && !editor ? 'canvas-mode' : ''}`}
    >
      {snapshot.canvasMode && page === 'workspace' && !editor && (
        <div className="canvas-recovery">
          <span aria-hidden="true">⠿</span>
          <button
            onClick={() => {
              void act('setCanvasMode', false).catch(() => {});
            }}
          >
            <ShieldCheck size={13} />
            Open app controls
          </button>
        </div>
      )}
      <aside className="sidebar">
        <div className="window-drag" />
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage('workspace');
            setEditor(undefined);
          }}
        >
          <Logo />
          <span>
            fluid<span className="brand-period">.</span>
          </span>
          <span className="alpha">ALPHA</span>
        </a>
        <button
          className="workspace-switch"
          onClick={() =>
            notify(
              'This is your local workspace. Everything is saved on this device.',
            )
          }
        >
          <span className="workspace-avatar">
            <Sprout size={17} />
          </span>
          <span>
            My workspace<small>A little space to create</small>
          </span>
          <ChevronDown size={13} />
        </button>
        <div className="nav-group">
          <span className="nav-label">YOUR SPACE</span>
          {nav('workspace', <LayoutDashboard size={16} />)}
          {nav(
            'interfaces',
            <Blocks size={16} />,
            <span className="nav-count">{snapshot.frontends.length}</span>,
          )}
          {nav('activity', <Radio size={16} />)}
          {nav('commerce', <ShoppingBag size={16} />)}
        </div>
        <div className="nav-group">
          <span className="nav-label">UNDER THE SURFACE</span>
          {nav('capabilities', <GitBranch size={16} />)}
          {nav('permissions', <ShieldCheck size={16} />)}
          {nav('settings', <Settings2 size={16} />)}
          <button className="nav-item" onClick={() => setConnect(true)}>
            <Terminal size={16} />
            <span>Connect an agent</span>
            <ArrowUpRight size={13} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="note-spark">✳</span>
            <p>
              Same app.
              <br />
              <strong>Endless ways to make it yours.</strong>
            </p>
            <button
              onClick={() => {
                setPage('interfaces');
                setEditor(undefined);
              }}
            >
              Explore interfaces <ArrowRight size={12} />
            </button>
          </div>
          <div className="local-status">
            <span className="status-dot" />
            <div>
              At home on this device<small>Local data. Yours to keep.</small>
            </div>
            <Monitor size={14} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>My workspace</span>
            <ChevronRight size={12} />
            <strong>{editor ? 'Interface studio' : labels[page]}</strong>
          </div>
          <div className="topbar-actions">
            <button
              className="command-button"
              aria-label="Open command menu"
              onClick={() => setCommands(true)}
            >
              <Search size={14} />
              <span>Jump to…</span>
              <kbd>⌘ K</kbd>
            </button>
            <span className="topbar-divider" />
            <span className="local-badge">
              <span />
              {editor ? 'Editing interface' : 'All changes saved'}
            </span>
            <span className="user-avatar" title="Your local workspace">
              Y
            </span>
          </div>
        </header>
        {editor ? (
          <Editor
            frontend={editor}
            onCancel={() => setEditor(undefined)}
            onSave={save}
            notify={notify}
          />
        ) : page === 'workspace' ? (
          <>
            <div className="workspace-bar">
              <div className="workspace-bar-label">
                <span className="workspace-bar-icon">
                  <Sprout size={16} />
                </span>
                <span>Everyday workspace</span>
                <span className="dot-separator">/</span>
                <span className="interface-name">{active.name}</span>
                <span className="version-badge">v{active.version}</span>
              </div>
              <div>
                <button
                  className="text-button"
                  onClick={() =>
                    snapshot.assistant.helperVisible
                      ? setHelperOpenRequest((value) => value + 1)
                      : newFrontend(active)
                  }
                >
                  <WandSparkles size={13} /> Make it yours
                </button>
                <button
                  className="icon-button"
                  aria-label="Use full canvas"
                  title="Let this interface fill the window"
                  onClick={() => {
                    void act('setCanvasMode', true).catch(() => {});
                  }}
                >
                  <Expand size={15} />
                </button>
                <span className="bar-divider" />
                <button
                  className="icon-button"
                  aria-label={
                    panel ? 'Hide interface panel' : 'Show interface panel'
                  }
                  onClick={() => setPanel((value) => !value)}
                >
                  {panel ? (
                    <PanelRightClose size={16} />
                  ) : (
                    <PanelRightOpen size={16} />
                  )}
                </button>
              </div>
            </div>
            <div className="workspace-stage">
              <div className="surface-wrap">
                <Surface
                  key={`${active.id}-${active.version}`}
                  frontend={active}
                  snapshot={snapshot}
                  onError={notify}
                />
              </div>
              {panel && (
                <aside className="interface-panel">
                  <div className="panel-eyebrow">
                    <span className="tiny-spark">✳</span> ROOM TO REIMAGINE
                  </div>
                  <h2>
                    Your workspace.
                    <br />
                    Your way.
                  </h2>
                  <p className="panel-intro">
                    One app, a world of possibilities.
                    <br />
                    Find a view that feels like you.
                  </p>
                  <div className="interface-options">
                    {snapshot.frontends.map((f) => (
                      <button
                        key={f.id}
                        className={`interface-option ${active.id === f.id ? 'selected' : ''}`}
                        onClick={() => {
                          void activate(f).catch(() => {});
                        }}
                      >
                        <Preview id={f.id} />
                        <div className="option-description">
                          <span>{f.name}</span>
                          <small>
                            {f.id === 'studio'
                              ? 'A home for all your moving parts'
                              : f.id === 'board'
                                ? 'A little more perspective'
                                : f.id === 'focus'
                                  ? 'A little less distraction'
                                  : 'Made by you'}
                          </small>
                        </div>
                        <span className="option-radio">
                          {active.id === f.id && <Check size={10} />}
                        </span>
                      </button>
                    ))}
                  </div>
                  <button
                    className="create-interface"
                    onClick={() => newFrontend()}
                  >
                    <Plus size={14} />
                    Create your own
                    <ArrowUpRight size={13} />
                  </button>
                  <div className="panel-bottom">
                    <div className="seed-art">
                      <span />
                      <span />
                      <span />
                      <span />
                    </div>
                    <h3>Let your tools adapt to you.</h3>
                    <p>
                      Switch the interface.
                      <br />
                      Your work comes with you.
                    </p>
                    <button onClick={() => setPage('capabilities')}>
                      See how it works <ArrowRight size={12} />
                    </button>
                  </div>
                </aside>
              )}
            </div>
          </>
        ) : (
          <div className="page-scroll">
            {page === 'settings' ? (
              <AssistantSettingsPage
                settings={snapshot.assistant}
                onUpdate={refresh}
                notify={notify}
              />
            ) : page === 'interfaces' ? (
              <>
                <PageHeading
                  eyebrow="A DIFFERENT POINT OF VIEW"
                  title="An interface that feels like you."
                  description="Same workspace. A fresh perspective. Find your rhythm, or create something entirely your own."
                >
                  <button
                    className="button"
                    onClick={() => fileInput.current?.click()}
                  >
                    <Upload size={14} /> Import interface
                  </button>
                  <button
                    className="button primary"
                    onClick={() => newFrontend()}
                  >
                    <Plus size={15} /> Create interface
                  </button>
                </PageHeading>
                <div className="section-label">
                  YOUR COLLECTION{' '}
                  <span>{snapshot.frontends.length} interfaces</span>
                </div>
                <div className="interface-grid">
                  {snapshot.frontends.map((f) => (
                    <article
                      className={`interface-card ${f.id === active.id ? 'in-use' : ''}`}
                      key={f.id}
                    >
                      <Preview id={f.id} large />
                      <div className="interface-card-body">
                        <div className="card-title">
                          <h2>{f.name}</h2>
                          <span
                            className={`small-badge ${f.builtin ? '' : 'custom'}`}
                          >
                            {f.builtin
                              ? f.id === 'studio'
                                ? 'DEFAULT'
                                : 'BY FLUID'
                              : 'BY YOU'}
                          </span>
                        </div>
                        <p>{f.description}</p>
                        <div className="interface-card-meta">
                          <span>
                            v{f.version} <i>·</i> {f.permissions.length}{' '}
                            permissions requested
                          </span>
                          <button
                            className="icon-button"
                            title={`Export ${f.name}`}
                            aria-label={`Export ${f.name}`}
                            onClick={() => {
                              void frontendSource(f)
                                .then((source) =>
                                  download(`${f.id}.fluid.json`, source),
                                )
                                .catch((error) => notify(error.message));
                            }}
                          >
                            <ArrowDownToLine size={14} />
                          </button>
                        </div>
                        <div className="interface-card-actions">
                          <button
                            className={`button ${f.id === active.id ? 'active-interface' : ''}`}
                            onClick={() => {
                              void activate(f).catch(() => {});
                            }}
                          >
                            {f.id === active.id ? (
                              <>
                                <Check size={13} /> In use
                              </>
                            ) : (
                              <>
                                Use interface <ArrowRight size={13} />
                              </>
                            )}
                          </button>
                          <button
                            className="icon-button"
                            aria-label={`Edit ${f.name}`}
                            title={
                              f.builtin
                                ? 'Make your own version'
                                : 'Edit interface'
                            }
                            onClick={() => {
                              void editFrontend(f);
                            }}
                          >
                            <Pencil size={14} />
                          </button>
                          {!f.builtin &&
                            Boolean(snapshot.history[f.id]?.length) && (
                              <button
                                className="icon-button"
                                aria-label={`Restore previous version of ${f.name}`}
                                title="Restore previous version"
                                onClick={() => {
                                  const previous =
                                    snapshot.history[f.id].at(-1)!;
                                  void act('restore', f.id, previous.version)
                                    .then(() =>
                                      notify(
                                        'Previous interface restored as a new version.',
                                      ),
                                    )
                                    .catch(() => {});
                                }}
                              >
                                <RotateCcw size={14} />
                              </button>
                            )}
                          {!f.builtin && (
                            <button
                              className="icon-button danger"
                              aria-label={`Remove ${f.name}`}
                              onClick={() => {
                                void act('remove', f.id).catch(() => {});
                              }}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  ))}
                  <button
                    className="new-interface-card"
                    onClick={() => newFrontend()}
                  >
                    <span>
                      <Plus size={25} strokeWidth={1} />
                    </span>
                    <h3>Make a little room for your ideas.</h3>
                    <p>
                      Start with a canvas.
                      <br />
                      Take it wherever you like.
                    </p>
                    <small>
                      Create an interface <ArrowUpRight size={12} />
                    </small>
                  </button>
                </div>
                <div className="inline-note">
                  <ShieldCheck size={17} />
                  <div>
                    <strong>Your data stays right where it belongs.</strong>
                    <p>
                      Each interface gets its own permissions. You decide what
                      it can read and change.
                    </p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setPage('permissions')}
                  >
                    Manage access <ArrowRight size={12} />
                  </button>
                </div>
              </>
            ) : page === 'permissions' ? (
              <>
                <PageHeading
                  eyebrow="YOU’RE IN CHARGE"
                  title="A little trust. Clear boundaries."
                  description="Decide what each interface can do. Changes take effect immediately, even while an interface is running."
                />
                <div className="permission-list">
                  {snapshot.frontends.map((f) => (
                    <article className="permission-card" key={f.id}>
                      <div className="permission-card-heading">
                        <span className="permission-icon">
                          <Blocks size={19} />
                        </span>
                        <div>
                          <h2>{f.name}</h2>
                          <p>
                            {f.builtin
                              ? 'Included with Fluid'
                              : `By ${f.author}`}{' '}
                            <span>·</span> version {f.version}
                          </p>
                        </div>
                        <span className="small-badge">
                          {(snapshot.grants[f.id] ?? []).length} GRANTED
                        </span>
                      </div>
                      {f.permissions.map((scope) => (
                        <div className="permission-row" key={scope}>
                          <div>
                            <strong>{scopeInfo[scope].title}</strong>
                            <p>{scopeInfo[scope].description}</p>
                          </div>
                          <button
                            role="switch"
                            aria-checked={(
                              snapshot.grants[f.id] ?? []
                            ).includes(scope)}
                            aria-label={`${f.name}: ${scopeInfo[scope].title}`}
                            className={`switch ${(snapshot.grants[f.id] ?? []).includes(scope) ? 'on' : ''}`}
                            onClick={() => {
                              const current = snapshot.grants[f.id] ?? [];
                              void act(
                                'setGrants',
                                f.id,
                                current.includes(scope)
                                  ? current.filter((p) => p !== scope)
                                  : [...current, scope],
                              ).catch(() => {});
                            }}
                          >
                            <span />
                          </button>
                        </div>
                      ))}
                    </article>
                  ))}
                </div>
              </>
            ) : page === 'capabilities' ? (
              <ExposedTools
                snapshot={snapshot}
                onConnect={() => setConnect(true)}
                onSource={(id) => {
                  const frontend =
                    snapshot.frontends.find((f) => f.id === id) ?? active;
                  void editFrontend(frontend);
                }}
                notify={notify}
              />
            ) : (
              <>
                <PageHeading
                  eyebrow="A CLEAR VIEW OF WHAT HAPPENED"
                  title="Small steps, recorded."
                  description="A shared history of changes, permission decisions, and the interfaces that made them."
                />
                <div className="activity-summary">
                  <span className="status-dot" /> Recording locally{' '}
                  <span>{snapshot.activity.length} events</span>
                </div>
                <div className="activity-list">
                  {snapshot.activity.length ? (
                    snapshot.activity.map((event) => (
                      <article className="activity-row" key={event.id}>
                        <span className={`activity-icon ${event.outcome}`}>
                          {event.outcome === 'denied' ? (
                            <LockKeyhole size={15} />
                          ) : event.outcome === 'allowed' ? (
                            <Check size={15} />
                          ) : (
                            <Blocks size={15} />
                          )}
                        </span>
                        <div>
                          <strong>{event.detail}</strong>
                          <p>
                            {event.frontend}
                            <span>·</span>
                            <code>{event.action}</code>
                          </p>
                        </div>
                        <span className={`event-outcome ${event.outcome}`}>
                          {event.outcome === 'system' ? 'App' : event.outcome}
                        </span>
                        <time dateTime={event.at}>
                          {new Date(event.at).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </time>
                      </article>
                    ))
                  ) : (
                    <div className="empty-state">
                      <Radio size={28} />
                      <h2>A fresh start.</h2>
                      <p>
                        Change a task or try another interface. Your story will
                        appear here.
                      </p>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        <footer className="statusbar">
          <span>
            <span className="status-dot" /> Local workspace <i>·</i> Fluid
            Protocol {PROTOCOL_VERSION}
          </span>
          <span>
            <ShieldCheck size={11} /> Permissions enforced <i>·</i>{' '}
            {webMcpAvailable()
              ? 'WebMCP available'
              : snapshot.agent.enabled
                ? 'Agent access enabled'
                : 'Ready for your agent'}
          </span>
        </footer>
      </div>
      <AssistantHelper
        settings={snapshot.assistant}
        active={active}
        openRequest={helperOpenRequest}
        onSettings={() => {
          setPage('settings');
          setEditor(undefined);
        }}
        onInstalled={async (frontend) => {
          await refresh();
          setConsent(frontend);
        }}
        onCode={(frontend) => setEditor(frontend)}
      />
      <input
        ref={fileInput}
        type="file"
        accept=".json,.fluid.json"
        hidden
        onChange={(e) => {
          void importFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {toast && (
        <div className="app-toast" role="status">
          <CheckCheck size={15} />
          <span>{toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast('')}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {fatal && (
        <div className="connection-error" role="alert">
          Connection interrupted: {fatal}
          <button onClick={() => location.reload()}>Reconnect</button>
        </div>
      )}
      {connect && (
        <AgentDialog
          snapshot={snapshot}
          onClose={() => setConnect(false)}
          act={act}
          notify={notify}
        />
      )}
      {consent && (
        <Consent
          frontend={consent}
          current={snapshot.grants[consent.id] ?? []}
          onClose={() => setConsent(undefined)}
          onAllow={async (grants) => {
            await act('setGrants', consent.id, grants);
            await activate(consent);
            setConsent(undefined);
            notify('Your interface is ready. Make yourself at home.');
          }}
        />
      )}
      {commands && (
        <Commands
          snapshot={snapshot}
          onClose={() => setCommands(false)}
          onPage={(id) => {
            setPage(id);
            setEditor(undefined);
            setCommands(false);
          }}
          onActivate={(f) => {
            void activate(f).catch(() => {});
            setCommands(false);
          }}
        />
      )}
    </div>
  );
}
function PageHeading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children && <div className="page-heading-actions">{children}</div>}
    </div>
  );
}
function Editor({
  frontend,
  onCancel,
  onSave,
  notify,
}: {
  frontend: Frontend;
  onCancel: () => void;
  onSave: (f: Frontend) => Promise<void>;
  notify: (message: string) => void;
}) {
  const [name, setName] = useState(frontend.name),
    [html, setHtml] = useState(frontend.html),
    [scopes, setScopes] = useState(frontend.permissions),
    [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await onSave({ ...frontend, name, html, permissions: scopes });
    } catch {
      setBusy(false);
    }
  };
  const brief = `Create a Fluid frontend for ${APP_ID}, protocol ${PROTOCOL_VERSION}. Return a .fluid.json file with fields id (unique letters/digits/hyphens), name, description, author, appId, protocol, permissions, html. The html is arbitrary self-contained HTML/CSS/JavaScript. It runs offline in a sandbox. Use window.fluid.call(name, input) for all app access and window.fluid.subscribe(callback) to re-read after changes. No imports, network, Node, storage or parent DOM access. Capability contract:\n${JSON.stringify(contract, null, 2)}\nCurrent HTML:\n${html}`;
  return (
    <div className="editor-screen">
      <div className="editor-toolbar">
        <button className="text-button" onClick={onCancel}>
          <ArrowLeft size={14} /> Back to your workspace
        </button>
        <div>
          <button
            className="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(brief)
                .then(() =>
                  notify(
                    'Agent brief copied. Paste it into your preferred coding agent.',
                  ),
                )
                .catch(() =>
                  notify(
                    'Clipboard is unavailable. Export the contract from Capabilities.',
                  ),
                );
            }}
          >
            <Copy size={13} /> Copy agent brief
          </button>
          <button
            className="button primary"
            onClick={() => {
              void save();
            }}
            disabled={busy || !name.trim() || !html.trim()}
          >
            {busy ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Check size={14} />
            )}{' '}
            Save & review access
          </button>
        </div>
      </div>
      <div className="editor-layout">
        <div className="code-panel">
          <div className="code-panel-heading">
            <span>
              <FileCode2 size={14} /> interface.html
            </span>
            <span>HTML + CSS + JavaScript</span>
          </div>
          <textarea
            aria-label="Interface source code"
            spellCheck={false}
            value={html}
            onChange={(e) => setHtml(e.target.value)}
          />
        </div>
        <aside className="editor-guide">
          <div className="eyebrow">YOUR OWN LITTLE CORNER</div>
          <h2>
            Make something
            <br />
            that works for you.
          </h2>
          <p>
            Bring your own code, or copy a brief to your agent and let it help
            you find a new perspective.
          </p>
          <label className="field">
            Interface name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          </label>
          <div className="editor-permissions">
            <h3>Requested access</h3>
            {permissions.map((scope) => (
              <label key={scope}>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(e) =>
                    setScopes(
                      e.target.checked
                        ? [...scopes, scope]
                        : scopes.filter((p) => p !== scope),
                    )
                  }
                />
                <span>{scopeInfo[scope].title}</span>
              </label>
            ))}
          </div>
          <div className="sdk-card">
            <span>THE ENTIRE FRONTEND SDK</span>
            <pre>{`await fluid.call('tasks.list');\n\nawait fluid.call('tasks.update', {\n  id: task.id, status: 'done'\n});\n\nfluid.subscribe(refresh);`}</pre>
          </div>
          <div className="editor-hint">
            <ShieldCheck size={16} />
            <p>
              Save your interface, review its access, then try it with your real
              workspace. Studio is always one click away.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
function Consent({
  frontend,
  current,
  onClose,
  onAllow,
}: {
  frontend: Frontend;
  current: Permission[];
  onClose: () => void;
  onAllow: (grants: Permission[]) => Promise<void>;
}) {
  const [grants, setGrants] = useState<Permission[]>(
    current.length
      ? current
      : frontend.permissions.filter((p) => p !== 'tasks:delete'),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Dialog title="A little introduction." onClose={onClose}>
      <div className="consent-icon">
        <Blocks size={24} />
      </div>
      <h3 className="dialog-title">Let {frontend.name} into your workspace?</h3>
      <p className="dialog-description">
        Choose what this interface can access. You can change your mind at any
        time in Permissions.
      </p>
      <div className="consent-scopes">
        {frontend.permissions.map((scope) => (
          <label key={scope}>
            <input
              type="checkbox"
              checked={grants.includes(scope)}
              onChange={(e) =>
                setGrants(
                  e.target.checked
                    ? [...grants, scope]
                    : grants.filter((p) => p !== scope),
                )
              }
            />
            <span>
              <strong>{scopeInfo[scope].title}</strong>
              <small>{scopeInfo[scope].description}</small>
            </span>
          </label>
        ))}
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="dialog-footer">
        <button className="button" onClick={onClose}>
          Keep for later
        </button>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onAllow(grants).catch((error) => {
              setError(error.message);
              setBusy(false);
            });
          }}
        >
          {busy ? <Loader2 className="spin" size={14} /> : <Check size={14} />}{' '}
          Allow selected & use
        </button>
      </div>
    </Dialog>
  );
}
function AgentDialog({
  snapshot,
  onClose,
  act,
  notify,
}: {
  snapshot: Snapshot;
  onClose: () => void;
  act: (method: string, ...args: unknown[]) => Promise<unknown>;
  notify: (message: string) => void;
}) {
  const [connection, setConnection] = useState<Connection>();
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [pendingAgent, setPendingAgent] = useState<Snapshot['agent']>();
  const agent = pendingAgent ?? snapshot.agent;
  const updateAgent = async (next: Snapshot['agent']) => {
    setPendingAgent(next);
    try {
      await act('setAgent', next.enabled, next.permissions);
    } catch {
      // act displays the host error; clearing the draft restores persisted grants.
    } finally {
      setPendingAgent(undefined);
    }
  };
  useEffect(() => {
    void backend
      .request<Connection>('connection')
      .then(setConnection)
      .catch((error) => notify(error.message));
  }, []);
  const config = JSON.stringify(
    transport === 'http'
      ? {
          mcpServers: {
            'fluid-workspace': {
              url: connection?.mcpUrl ?? '',
              headers: { Authorization: `Bearer ${connection?.token ?? ''}` },
            },
          },
        }
      : {
          mcpServers: {
            'fluid-workspace': {
              command: connection?.nativePath ?? '/absolute/path/to/fluid-host',
              args: ['mcp'],
              env: {
                FLUID_URL: connection?.url ?? '',
                FLUID_AGENT_TOKEN: connection?.token ?? '',
              },
            },
          },
        },
    null,
    2,
  );
  return (
    <Dialog title="Bring your own agent." onClose={onClose} wide>
      <div className="agent-intro">
        <span>
          <Terminal size={25} />
        </span>
        <div>
          <h3>Your workspace, within reach.</h3>
          <p>
            Connect any MCP-compatible agent to the running Rust host. It uses
            the same capabilities as your interfaces.
          </p>
        </div>
      </div>
      <p className="dialog-caption">
        For frontend control, enable Read interface source and Publish and
        switch interfaces. Agents can never grant themselves permissions or
        access provider keys.
      </p>
      <div className="agent-enable">
        <div>
          <strong>External agent access</strong>
          <p>
            {agent.enabled
              ? 'Enabled for this app. The connection token changes after a restart.'
              : 'Disabled. Enable it when you’re ready to connect.'}
          </p>
        </div>
        <button
          role="switch"
          aria-label="External agent access"
          aria-checked={agent.enabled}
          disabled={!!pendingAgent}
          className={`switch ${agent.enabled ? 'on' : ''}`}
          onClick={() => {
            void updateAgent({ ...agent, enabled: !agent.enabled });
          }}
        >
          <span />
        </button>
      </div>
      {agent.enabled && (
        <>
          <div className="agent-scopes">
            {permissions.map((scope) => (
              <label key={scope}>
                <input
                  type="checkbox"
                  checked={agent.permissions.includes(scope)}
                  disabled={!!pendingAgent}
                  onChange={(e) => {
                    void updateAgent({
                      enabled: true,
                      permissions: e.target.checked
                        ? [...agent.permissions, scope]
                        : agent.permissions.filter((p) => p !== scope),
                    });
                  }}
                />
                {scopeInfo[scope].title}
              </label>
            ))}
          </div>
          <div className="connection-transports">
            <button
              className={transport === 'stdio' ? 'selected' : ''}
              onClick={() => setTransport('stdio')}
            >
              Native stdio
            </button>
            <button
              className={transport === 'http' ? 'selected' : ''}
              onClick={() => setTransport('http')}
            >
              Streamable HTTP
            </button>
          </div>
          <div className="config-heading">
            <span>MCP CONNECTION CONFIGURATION</span>
            <button
              className="text-button"
              disabled={!connection}
              onClick={() => {
                void navigator.clipboard
                  .writeText(config)
                  .then(() => notify('Connection configuration copied.'))
                  .catch(() =>
                    notify('Select and copy the configuration below.'),
                  );
              }}
            >
              <Copy size={12} /> Copy
            </button>
          </div>
          <pre className="connection-config">
            {connection ? config : 'Preparing your connection…'}
          </pre>
          <p className="dialog-caption">
            {transport === 'stdio'
              ? 'The native adapter needs no Node runtime.'
              : 'Connect directly to the standard MCP HTTP endpoint with the bearer token.'}{' '}
            Keep Fluid open while connected. Treat the connection token as a
            password.
          </p>
        </>
      )}
      <div className="webmcp-note">
        <Globe2 size={17} />
        <div>
          <strong>
            WebMCP {webMcpAvailable() ? 'is available' : 'adapter included'}
          </strong>
          <p>
            {webMcpAvailable()
              ? 'This environment exposes the active interface’s capabilities through WebMCP.'
              : 'When the host browser supports WebMCP, Fluid registers the active interface’s capabilities automatically.'}
          </p>
        </div>
      </div>
    </Dialog>
  );
}
function Commands({
  snapshot,
  onClose,
  onPage,
  onActivate,
}: {
  snapshot: Snapshot;
  onClose: () => void;
  onPage: (id: Page) => void;
  onActivate: (f: FrontendSummary) => void;
}) {
  const [query, setQuery] = useState('');
  return (
    <Dialog title="Find a little direction." onClose={onClose}>
      <input
        autoFocus
        className="command-input"
        aria-label="Search commands"
        placeholder="Where would you like to go?"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="command-results">
        {(Object.entries(labels) as [Page, string][])
          .filter(([, label]) =>
            label.toLowerCase().includes(query.toLowerCase()),
          )
          .map(([id, label]) => (
            <button key={id} onClick={() => onPage(id)}>
              <FolderOpen size={15} />
              <span>{label}</span>
              <ArrowRight size={13} />
            </button>
          ))}
        {snapshot.frontends
          .filter((f) => f.name.toLowerCase().includes(query.toLowerCase()))
          .map((f) => (
            <button key={f.id} onClick={() => onActivate(f)}>
              <Blocks size={15} />
              <span>Use {f.name}</span>
              <ArrowRight size={13} />
            </button>
          ))}
      </div>
    </Dialog>
  );
}
