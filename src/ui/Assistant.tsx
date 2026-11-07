import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Code2,
  Eye,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import type { Frontend, FrontendSummary } from '../protocol/index';
import { backend } from '../runtime/backend';
import {
  defaultAssistantSettings,
  type ApiProvider,
  type AssistantSettings,
  type AssistantStatus,
  type Proposal,
  type ProviderId,
} from '../assistant/types';

const names: Record<ProviderId, string> = {
  auto: 'Automatic',
  codex: 'Codex',
  claude: 'Claude Code',
  openai: 'OpenAI API',
  anthropic: 'Anthropic API',
  compatible: 'Compatible API',
  ollama: 'Ollama',
};
type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  proposal?: Proposal;
  applied?: boolean;
  error?: boolean;
};
export function AssistantHelper({
  settings,
  active,
  openRequest,
  onSettings,
  onInstalled,
  onCode,
}: {
  settings: AssistantSettings;
  active: FrontendSummary;
  openRequest: number;
  onSettings: () => void;
  onInstalled: (frontend: Frontend) => Promise<void>;
  onCode: (frontend: Frontend) => void;
}) {
  const [open, setOpen] = useState(false),
    [prompt, setPrompt] = useState(''),
    [messages, setMessages] = useState<Message[]>([]),
    [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AssistantStatus>(),
    [connectionError, setConnectionError] = useState(''),
    [applying, setApplying] = useState<string>();
  const end = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!settings.helperVisible) setOpen(false);
  }, [settings.helperVisible]);
  useEffect(() => {
    if (openRequest && settings.helperVisible) setOpen(true);
  }, [openRequest]);
  useEffect(() => {
    if (!open) return;
    setConnectionError('');
    void backend
      .request<AssistantStatus>('assistant.status')
      .then(setStatus)
      .catch((error) => setConnectionError(error.message));
    input.current?.focus();
  }, [open, settings.provider, JSON.stringify(settings.connections)]);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy, open]);
  const selected =
    settings.provider === 'auto' ? status?.effective : settings.provider;
  const connection = status?.providers.find((p) => p.id === selected);
  const send = async () => {
    if (!prompt.trim() || busy) return;
    const value = prompt.trim();
    const history = messages
      .filter((m) => !m.error)
      .slice(-10)
      .map(({ role, content }) => ({ role, content }));
    setMessages((old) => [
      ...old,
      { id: crypto.randomUUID(), role: 'user', content: value },
    ]);
    setPrompt('');
    setBusy(true);
    try {
      const proposal = await backend.request<Proposal>('assistant.generate', {
        prompt: value,
        history,
      });
      setMessages((old) => [
        ...old,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: proposal.message,
          proposal,
        },
      ]);
    } catch (error) {
      setMessages((old) => [
        ...old,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: (error as Error).message,
          error: true,
        },
      ]);
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };
  const apply = async (message: Message) => {
    if (!message.proposal || applying) return;
    setApplying(message.id);
    try {
      const installed = await backend.request<Frontend>(
        'assistant.apply',
        message.proposal.id,
      );
      await onInstalled(installed);
      setMessages((old) =>
        old.map((m) => (m.id === message.id ? { ...m, applied: true } : m)),
      );
    } catch (error) {
      setMessages((old) => [
        ...old,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: (error as Error).message,
          error: true,
        },
      ]);
    } finally {
      setApplying(undefined);
    }
  };
  if (!settings.helperVisible) return null;
  return (
    <>
      {open && (
        <section
          className="helper-chat"
          role="dialog"
          aria-label="Interface helper"
        >
          <header className="helper-header">
            <span className="helper-mark">
              <Sparkles size={18} />
            </span>
            <div>
              <h2>A little help making it yours.</h2>
              <p>
                {status
                  ? connection?.available
                    ? `Using ${names[selected!]}${settings.provider === 'auto' ? ' · auto-connected' : ''}`
                    : 'Choose a connection to get started'
                  : connectionError || 'Finding your connections…'}
              </p>
            </div>
            <button
              className="icon-button"
              aria-label="Helper settings"
              onClick={() => {
                setOpen(false);
                onSettings();
              }}
            >
              <Settings2 size={15} />
            </button>
            <button
              className="icon-button"
              aria-label="Close helper"
              onClick={() => setOpen(false)}
            >
              <X size={16} />
            </button>
          </header>
          <div className="helper-context">
            <span className="status-dot" /> Editing {active.name}
            <span>v{active.version}</span>
          </div>
          <div className="helper-messages" aria-live="polite">
            {!messages.length && (
              <div className="helper-welcome">
                <span>✳</span>
                <h3>Your app can feel more like you.</h3>
                <p>
                  Tell me what would make your workspace better. I’ll prepare a
                  new interface for you to review.
                </p>
                <div className="helper-suggestions">
                  {[
                    'Make this a weekly planning board',
                    'Give me a calmer, minimal dark view',
                    'Put my high-priority tasks first',
                  ].map((text) => (
                    <button
                      key={text}
                      onClick={() => {
                        setPrompt(text);
                        input.current?.focus();
                      }}
                    >
                      {text}
                      <ArrowRight size={12} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((message) => (
              <article
                key={message.id}
                className={`helper-message ${message.role} ${message.error ? 'error' : ''}`}
              >
                <span className="helper-message-label">
                  {message.role === 'user' ? 'YOU' : 'FLUID HELPER'}
                </span>
                <p>{message.content}</p>
                {message.proposal && (
                  <div className="helper-proposal">
                    <div>
                      <Code2 size={17} />
                      <span>
                        <strong>{message.proposal.frontend.name}</strong>
                        <small>New interface · your existing workspace</small>
                      </span>
                    </div>
                    <div className="proposal-scopes">
                      {message.proposal.frontend.permissions.map((p) => (
                        <span key={p}>{p}</span>
                      ))}
                    </div>
                    <div className="helper-proposal-actions">
                      <button
                        className="button"
                        onClick={() => {
                          setOpen(false);
                          onCode(message.proposal!.frontend);
                        }}
                      >
                        <Code2 size={12} /> Review code
                      </button>
                      <button
                        className="button primary"
                        disabled={Boolean(applying) || message.applied}
                        onClick={() => {
                          void apply(message);
                        }}
                      >
                        {applying === message.id ? (
                          <Loader2 className="spin" size={13} />
                        ) : message.applied ? (
                          <Check size={13} />
                        ) : (
                          <Eye size={13} />
                        )}
                        {message.applied ? 'Saved' : 'Review & use'}
                      </button>
                    </div>
                  </div>
                )}
              </article>
            ))}
            {busy && (
              <div className="helper-working">
                <Loader2 className="spin" size={14} />
                <span>
                  Reimagining your interface…
                  <small>Your current workspace is still available.</small>
                </span>
              </div>
            )}
            <div ref={end} />
          </div>
          <form
            className="helper-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={input}
              aria-label="Tell the helper how to change your interface"
              placeholder="How should your workspace feel?"
              value={prompt}
              maxLength={8000}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div>
              <button
                type="button"
                className="helper-connection"
                onClick={() => {
                  setOpen(false);
                  onSettings();
                }}
              >
                <span
                  className={`status-dot ${connection?.available ? '' : 'offline'}`}
                />
                {selected ? names[selected] : 'Connect an agent'}
                <ChevronDown size={11} />
              </button>
              {busy ? (
                <button
                  type="button"
                  className="helper-send"
                  aria-label="Stop generating"
                  onClick={() => {
                    void backend.request('assistant.cancel');
                  }}
                >
                  <Square size={12} />
                </button>
              ) : (
                <button
                  type="submit"
                  className="helper-send"
                  aria-label="Send interface request"
                  disabled={!prompt.trim() || !connection?.available}
                >
                  <Send size={14} />
                </button>
              )}
            </div>
          </form>
          <footer className="helper-footer">
            <ShieldCheck size={11} />
            You review changes before they become your interface.
          </footer>
        </section>
      )}
      <button
        className={`helper-toggle ${open ? 'is-open' : ''}`}
        aria-label={open ? 'Hide interface helper' : 'Open interface helper'}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <X size={18} />
        ) : (
          <>
            <MessageCircle size={18} />
            <span>Make it yours</span>
            <span className="helper-toggle-spark">✳</span>
          </>
        )}
      </button>
    </>
  );
}

export function AssistantSettingsPage({
  settings,
  onUpdate,
  notify,
}: {
  settings: AssistantSettings;
  onUpdate: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [status, setStatus] = useState<AssistantStatus>(),
    [checking, setChecking] = useState(true),
    [saving, setSaving] = useState(false),
    [apiKey, setApiKey] = useState('');
  const [draft, setDraft] = useState(settings),
    [error, setError] = useState('');
  useEffect(() => {
    setDraft(settings);
  }, [settings]);
  const refresh = async (force = false) => {
    setChecking(true);
    try {
      setStatus(
        await backend.request<AssistantStatus>('assistant.status', force),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const persist = async (next: AssistantSettings, key?: string) => {
    setSaving(true);
    setError('');
    try {
      await backend.request('assistant.settings', next);
      if (
        key?.trim() &&
        ['openai', 'anthropic', 'compatible'].includes(next.provider)
      )
        await backend.request('assistant.key', next.provider, key);
      setApiKey('');
      await onUpdate();
      await refresh(true);
      notify('Your helper settings are saved.');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const api = ['openai', 'anthropic', 'compatible', 'ollama'].includes(
    draft.provider,
  )
    ? (draft.provider as ApiProvider)
    : undefined;
  return (
    <div className="assistant-settings">
      <div className="page-heading">
        <div>
          <div className="eyebrow">A LITTLE HELP, ON YOUR TERMS</div>
          <h1>Bring the intelligence you already use.</h1>
          <p>
            Reuse an agent’s existing sign-in, connect an API, or keep
            everything on this device with a local model.
          </p>
        </div>
        <button
          className="button"
          disabled={checking}
          onClick={() => {
            void refresh(true);
          }}
        >
          {checking ? (
            <Loader2 className="spin" size={13} />
          ) : (
            <RefreshCw size={13} />
          )}
          Refresh connections
        </button>
      </div>
      <section className="helper-preference">
        <span>
          <MessageCircle size={21} />
        </span>
        <div>
          <h2>Keep the little helper close</h2>
          <p>
            Show the chat button throughout the app. You can turn it back on
            here anytime.
          </p>
        </div>
        <button
          role="switch"
          aria-label="Show helper chat button"
          aria-checked={settings.helperVisible}
          className={`switch ${settings.helperVisible ? 'on' : ''}`}
          disabled={saving}
          onClick={() => {
            void persist({
              ...settings,
              helperVisible: !settings.helperVisible,
            });
          }}
        >
          <span />
        </button>
      </section>
      <div className="settings-section-heading">
        <h2>Your connections</h2>
        <p>
          Fluid only contacts a model when you send a request. Automatic prefers
          an existing agent sign-in.
        </p>
      </div>
      <div className="provider-grid">
        <button
          className={`provider-card auto ${draft.provider === 'auto' ? 'selected' : ''}`}
          onClick={() => {
            setDraft({ ...draft, provider: 'auto' });
            setApiKey('');
          }}
        >
          <div>
            <Sparkles size={20} />
            <span className="provider-radio">
              {draft.provider === 'auto' && <Check size={10} />}
            </span>
          </div>
          <h3>Automatic</h3>
          <p>
            {status?.effective
              ? `Ready to use ${names[status.effective]}.`
              : checking
                ? 'Looking for your existing connections…'
                : 'Chooses the first configured connection.'}
          </p>
          <small>EXISTING SIGN-IN FIRST</small>
        </button>
        {(
          status?.providers ??
          [
            'codex',
            'claude',
            'openai',
            'anthropic',
            'compatible',
            'ollama',
          ].map((id) => ({
            id,
            name: names[id as ProviderId],
            available: false,
            detail: 'Checking availability…',
          }))
        ).map((provider) => (
          <button
            key={provider.id}
            className={`provider-card ${draft.provider === provider.id ? 'selected' : ''}`}
            onClick={() => {
              setDraft({ ...draft, provider: provider.id as ProviderId });
              setApiKey('');
            }}
          >
            <div>
              <Code2 size={20} />
              <span className="provider-radio">
                {draft.provider === provider.id && <Check size={10} />}
              </span>
            </div>
            <h3>{provider.name}</h3>
            <p>{provider.detail}</p>
            <small className={provider.available ? 'ready' : ''}>
              <span
                className={`status-dot ${provider.available ? '' : 'offline'}`}
              />
              {provider.available ? 'AVAILABLE' : 'SETUP NEEDED'}
            </small>
          </button>
        ))}
      </div>
      {api && (
        <section className="api-configuration">
          <h2>Configure {names[api]}</h2>
          <p>
            {api === 'ollama'
              ? 'Choose a downloaded model, or leave the model blank to use the first available one.'
              : 'Use the model ID from your provider. Subscription sign-ins and API keys are separate connections.'}
          </p>
          <div className="api-fields">
            <label className="field">
              API base URL
              <input
                aria-label="API base URL"
                value={draft.connections[api].baseUrl}
                readOnly={api === 'openai' || api === 'anthropic'}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    connections: {
                      ...draft.connections,
                      [api]: {
                        ...draft.connections[api],
                        baseUrl: e.target.value,
                      },
                    },
                  })
                }
              />
            </label>
            <label className="field">
              Model
              <input
                aria-label="Provider model"
                value={draft.connections[api].model}
                placeholder={
                  api === 'ollama'
                    ? 'Automatic local model'
                    : 'Your provider’s model ID'
                }
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    connections: {
                      ...draft.connections,
                      [api]: {
                        ...draft.connections[api],
                        model: e.target.value,
                      },
                    },
                  })
                }
              />
            </label>
            {api !== 'ollama' && (
              <label className="field api-key-field">
                API key{' '}
                <span>
                  {status?.providers.find((p) => p.id === api)?.hasKey
                    ? 'A key is already available. Leave blank to keep it.'
                    : api === 'compatible'
                      ? 'Optional for local endpoints.'
                      : 'Required for this API connection.'}
                </span>
                <input
                  aria-label="Provider API key"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Paste a key to add or replace it"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </label>
            )}
          </div>
          <p className="credential-note">
            <ShieldCheck size={12} />
            {status?.credentialStorage === 'encrypted'
              ? 'Keys are encrypted with this device’s OS credential protection. They never enter frontend code.'
              : 'Keys stay in memory for this session. Existing agent sign-ins remain managed by their own app.'}
          </p>
        </section>
      )}
      {error && (
        <p className="assistant-settings-error" role="alert">
          {error}
        </p>
      )}
      <div className="assistant-settings-footer">
        <p>
          {draft.provider === 'auto'
            ? 'Automatic selection does not send a prompt or verify paid model access.'
            : `Your helper will use ${names[draft.provider]}.`}
        </p>
        <button
          className="button primary"
          disabled={saving}
          onClick={() => {
            void persist(draft, apiKey);
          }}
        >
          {saving ? (
            <Loader2 className="spin" size={13} />
          ) : (
            <Check size={13} />
          )}
          Save helper settings
        </button>
      </div>
      <div className="inline-note">
        <ShieldCheck size={17} />
        <div>
          <strong>Your subscriptions stay with their providers.</strong>
          <p>
            Fluid uses supported local agent sign-ins. Other subscriptions need
            an integration their provider supports; web chat login cookies are
            never copied.
          </p>
        </div>
      </div>
    </div>
  );
}
