import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Code2,
  Columns2,
  Database,
  ExternalLink,
  FileSpreadsheet,
  ListTodo,
  LockKeyhole,
  ShoppingBag,
  Users,
  X,
} from 'lucide-react';
import type { FrontendSummary, Snapshot } from '../protocol/index';
import { Surface } from '../runtime/Surface';
import { connectWebMcp } from '../runtime/webmcp';
import source from './data/source.json' with { type: 'json' };
import './commerce.css';
const clients = {
  maya: {
    name: 'Maya',
    role: 'Commercial analyst',
    initial: 'M',
    view: 'commerce-table',
  },
  leo: {
    name: 'Leo',
    role: 'Customer operations',
    initial: 'L',
    view: 'commerce-feed',
  },
};
type Client = keyof typeof clients;
function preference(client: Client) {
  try {
    return (
      localStorage.getItem(`fluid-commerce-view:${client}`) ??
      clients[client].view
    );
  } catch {
    return clients[client].view;
  }
}
export function CommerceDemo({
  snapshot,
  onBack,
  onEdit,
  onTools,
}: {
  snapshot: Snapshot;
  onBack(): void;
  onEdit(frontend: FrontendSummary): void;
  onTools(): void;
}) {
  const params = new URLSearchParams(location.search);
  const initialClient: Client = params.get('client') === 'leo' ? 'leo' : 'maya';
  const [client, setClient] = useState<Client>(initialClient);
  const [view, setView] = useState(
    params.get('view') ?? preference(initialClient),
  );
  const [compare, setCompare] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [error, setError] = useState('');
  const frontends = snapshot.frontends.filter((f) =>
    f.permissions.includes('orders:read'),
  );
  const active = frontends.find((f) => f.id === view) ?? frontends[0];
  useEffect(() => {
    if (!active) return;
    try {
      localStorage.setItem(`fluid-commerce-view:${client}`, active.id);
    } catch {}
    const query = new URLSearchParams(location.search);
    query.set('demo', 'commerce');
    query.set('client', client);
    query.set('view', active.id);
    history.replaceState(null, '', `${location.pathname}?${query}`);
  }, [client, active?.id]);
  useEffect(
    () => (active ? connectWebMcp(active.id) : undefined),
    [
      active?.id,
      active?.version,
      JSON.stringify(active ? snapshot.grants[active.id] : []),
    ],
  );
  const switchClient = (next: Client) => {
    setClient(next);
    setView(preference(next));
    setError('');
  };
  const back = () => {
    const query = new URLSearchParams(location.search);
    ['demo', 'client', 'view'].forEach((key) => query.delete(key));
    history.replaceState(
      null,
      '',
      `${location.pathname}${query.size ? `?${query}` : ''}`,
    );
    onBack();
  };
  if (!active)
    return (
      <div className="commerce-boot">
        <p>
          The commerce interfaces are not installed yet. Restart Fluid to load
          the demo.
        </p>
        <button onClick={back}>Back to workspace</button>
      </div>
    );
  const person = clients[client];
  const sharedGrants = snapshot.grants[active.id] ?? [];
  const table = frontends.find((f) => f.id === 'commerce-table')!;
  const feed = frontends.find((f) => f.id === 'commerce-feed')!;
  return (
    <div
      className={`commerce-demo ${window.fluidDesktop ? 'commerce-desktop' : ''}`}
    >
      <div className="commerce-titlebar">
        <button onClick={back}>
          <ArrowLeft size={12} /> Back to Fluid
        </button>
        <span>A WORKING EXAMPLE OF THE FLUID APP PROTOCOL</span>
        <button onClick={onTools}>
          <Code2 size={12} /> Exposed tools
        </button>
      </div>
      <header className="shop-header">
        <div className="shop-brand">
          <span className="shop-mark">
            <ShoppingBag size={23} strokeWidth={1.5} />
          </span>
          <div>
            <strong>
              common goods<span>DEMO</span>
            </strong>
            <small>One shop. A way of working for everyone.</small>
          </div>
        </div>
        <div className="shop-header-right">
          <span className="shop-live">
            <i /> Shared data, live across views
          </span>
          <button
            className="shop-source-button"
            onClick={() => setShowSource(true)}
          >
            <Database size={13} /> About the data <ExternalLink size={11} />
          </button>
        </div>
      </header>
      <div className="commerce-context">
        <div className="commerce-context-copy">
          <span className="demo-tag">REAL DATA DEMO</span>
          <h2>One app. Different people. Their own way in.</h2>
          <p>
            Same invoices and permissions. A personal interface for each demo
            client.
          </p>
        </div>
        <div className="commerce-client-controls">
          <div className="client-label">
            <Users size={12} /> TRY ANOTHER PERSON’S PERSPECTIVE
          </div>
          <div className="client-switcher">
            {(Object.keys(clients) as Client[]).map((id) => (
              <button
                key={id}
                aria-label={`Use ${clients[id].name}'s demo client`}
                aria-pressed={client === id}
                className={client === id ? 'selected' : ''}
                onClick={() => switchClient(id)}
              >
                <span className={`client-avatar ${id}`}>
                  {clients[id].initial}
                </span>
                <span>
                  {clients[id].name}
                  <small>{clients[id].role}</small>
                </span>
                {client === id && <Check size={13} />}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="commerce-view-bar">
        <div className="current-client">
          <span className={`client-avatar ${client}`}>{person.initial}</span>
          <span>
            {person.name}’s interface<small>Saved for this demo client</small>
          </span>
        </div>
        <div className="view-options">
          {frontends.slice(0, 2).map((f) => (
            <button
              key={f.id}
              aria-label={`Use ${f.name} view`}
              aria-pressed={!compare && active.id === f.id}
              className={!compare && active.id === f.id ? 'selected' : ''}
              onClick={() => {
                setView(f.id);
                setCompare(false);
              }}
            >
              {f.id === 'commerce-table' ? (
                <FileSpreadsheet size={14} />
              ) : (
                <ListTodo size={14} />
              )}
              {f.name}
            </button>
          ))}
          {frontends.length > 2 && (
            <select
              aria-label="Custom commerce interface"
              value={active.builtin ? '' : active.id}
              onChange={(e) => {
                if (e.target.value) {
                  setView(e.target.value);
                  setCompare(false);
                }
              }}
            >
              <option value="">Your interfaces…</option>
              {frontends
                .filter((f) => !f.builtin)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </select>
          )}
          <button
            aria-label="Compare both interfaces"
            disabled={!table || !feed}
            aria-pressed={compare}
            className={compare ? 'selected' : ''}
            onClick={() => setCompare(!compare)}
          >
            <Columns2 size={14} /> Side by side
          </button>
        </div>
        <button className="edit-commerce" onClick={() => onEdit(active)}>
          <Code2 size={13} /> Make this yours <ArrowRight size={12} />
        </button>
      </div>
      <div className={`commerce-surfaces ${compare ? 'compare' : ''}`}>
        {compare && table && feed ? (
          <>
            {[
              { frontend: table, name: 'Maya’s order desk', client: 'maya' },
              { frontend: feed, name: 'Leo’s action feed', client: 'leo' },
            ].map(({ frontend, name, client }) => (
              <section className="comparison-client" key={frontend.id}>
                <div className="comparison-label">
                  <span className={`client-avatar ${client}`}>
                    {client === 'maya' ? 'M' : 'L'}
                  </span>
                  <strong>{name}</strong>
                  <span>Same records · same access</span>
                </div>
                <Surface
                  frontend={frontend}
                  snapshot={snapshot}
                  onError={setError}
                />
              </section>
            ))}
          </>
        ) : (
          <Surface
            key={client}
            frontend={active}
            snapshot={snapshot}
            onError={setError}
          />
        )}
      </div>
      <footer className="commerce-footer">
        <span>
          <Database size={11} /> {source.sampleLineCount.toLocaleString()}{' '}
          source lines <ArrowRight size={10} /> {source.sampleInvoiceCount}{' '}
          shared invoices <ArrowRight size={10} /> suggested reviews
        </span>
        <span>
          <LockKeyhole size={10} />{' '}
          {sharedGrants.includes('orders:read')
            ? 'Read invoices'
            : 'Read access off'}{' '}
          ·{' '}
          {sharedGrants.includes('reviews:write')
            ? 'Update reviews'
            : 'Review access off'}
        </span>
        <button onClick={() => setShowSource(true)}>
          UCI Online Retail · CC BY 4.0
        </button>
      </footer>
      {error && (
        <div className="commerce-error" role="alert">
          {error}
          <button
            aria-label="Dismiss commerce error"
            onClick={() => setError('')}
          >
            <X size={12} />
          </button>
        </div>
      )}
      {showSource && (
        <div
          className="commerce-data-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowSource(false);
          }}
        >
          <section
            className="commerce-data-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Real data and transformation rules"
          >
            <div className="data-dialog-heading">
              <span className="demo-tag">FROM SOURCE TO SOMETHING USEFUL</span>
              <button
                aria-label="Close data details"
                onClick={() => setShowSource(false)}
              >
                <X size={18} />
              </button>
            </div>
            <h2>Real records. Useful transformations.</h2>
            <p>
              Common Goods is a fictional demo storefront using real, historical
              transactions from UCI’s Online Retail dataset.
            </p>
            <div className="data-pipeline">
              <div>
                <b>{source.fullLineCount.toLocaleString()}</b>
                <span>lines in the original workbook</span>
              </div>
              <ArrowRight size={18} />
              <div>
                <b>{source.sampleLineCount.toLocaleString()}</b>
                <span>source lines in this extract</span>
              </div>
              <ArrowRight size={18} />
              <div>
                <b>{source.sampleInvoiceCount}</b>
                <span>complete shared invoices</span>
              </div>
            </div>
            <h3>What the app actually does</h3>
            <ol>
              <li>
                Pulls the published workbook and preserves source row numbers.
              </li>
              <li>
                Groups line items by invoice number. Calculates quantities and
                values in integer pence, keeping negative cancellations.
              </li>
              <li>
                Suggests reviews for cancellations, missing customer IDs,
                non-positive prices, and sales of £1,000 or more.
              </li>
              <li>
                Stores review status and notes separately. Every view reads the
                same invoice and review.
              </li>
            </ol>
            <div className="data-notice">
              Historical records: 1–5 December 2010. Suggested tasks are a demo
              policy, not evidence of unfinished business. Reviewing an invoice
              never issues a refund or contacts a customer.
            </div>
            <p className="client-demo-notice">
              <strong>Two demo clients, one local host.</strong> Each has its
              own saved interface choice. These are demonstration profiles, not
              authenticated team accounts.
            </p>
            <details>
              <summary>
                Selection, money calculations & source verification{' '}
                <ChevronDown size={13} />
              </summary>
              <p>{source.selection}</p>
              <p>{source.moneyMethod}</p>
              <p>Archive SHA-256</p>
              <code>{source.archiveSha256}</code>
              <p>Workbook SHA-256</p>
              <code>{source.workbookSha256}</code>
            </details>
            <div className="data-attribution">
              <p>{source.citation}</p>
              <a href={source.url} target="_blank" rel="noreferrer">
                Original dataset <ExternalLink size={11} />
              </a>
              <a href={source.licenseUrl} target="_blank" rel="noreferrer">
                {source.license} <ExternalLink size={11} />
              </a>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
