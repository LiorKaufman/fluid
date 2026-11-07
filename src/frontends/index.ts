import style from './workspace.css?raw';
import script from './workspace.js?raw';
import { APP_ID, PROTOCOL_VERSION, type Frontend } from '../protocol/index';
import { commerceFrontends } from '../commerce/frontends';

function html(mode: string) {
  return `<style>${style}</style><div id="app"><div class="loading">Making room for your work…</div></div><script>window.FRONTEND_MODE=${JSON.stringify(mode)};${script}</script>`;
}
const workspaceFrontends: Frontend[] = [
  {
    id: 'studio',
    name: 'Studio',
    description: 'A little structure. A lot of breathing room.',
    author: 'Fluid',
    mode: 'list',
  },
  {
    id: 'board',
    name: 'Flow board',
    description: 'See the bigger picture, one step at a time.',
    author: 'Fluid',
    mode: 'board',
  },
  {
    id: 'focus',
    name: 'Focus',
    description: 'One thing in front of you. Everything else can wait.',
    author: 'Fluid',
    mode: 'focus',
  },
].map((f) => ({
  id: f.id,
  name: f.name,
  description: f.description,
  author: f.author,
  protocol: PROTOCOL_VERSION,
  appId: APP_ID,
  version: 1,
  builtin: true,
  permissions: ['tasks:read', 'tasks:write', 'tasks:delete'],
  html: html(f.mode),
  updatedAt: '2026-11-03T00:00:00Z',
}));
export const builtins: Frontend[] = [
  ...workspaceFrontends,
  ...commerceFrontends,
];
