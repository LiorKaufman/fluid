import style from './views.css?raw';
import common from './shared.js?raw';
import table from './table.js?raw';
import feed from './feed.js?raw';
import { APP_ID, PROTOCOL_VERSION, type Frontend } from '../../protocol/index';

export const commerceFrontends: Frontend[] = [
  {
    id: 'commerce-table',
    name: 'Order desk',
    description: 'A precise table for people who think in rows.',
    script: table,
  },
  {
    id: 'commerce-feed',
    name: 'Action feed',
    description: 'One useful next step, with the order behind it.',
    script: feed,
  },
].map(({ script, ...frontend }) => ({
  ...frontend,
  author: 'Fluid · Common Goods demo',
  protocol: PROTOCOL_VERSION,
  appId: APP_ID,
  version: 1,
  builtin: true,
  permissions: ['orders:read', 'reviews:write'],
  html: `<style>${style}</style><main id="commerce"><p class="loading">Opening the shared shop…</p></main><div id="overlay"></div><div id="toast" role="status"></div><script>${common}\n${script}</script>`,
  updatedAt: '2026-11-03T00:00:00Z',
}));
