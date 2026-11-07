import type {
  Frontend,
  ProviderId,
  AssistantSettings,
} from '../protocol/index.ts';
import defaults from '../protocol/defaults.json' with { type: 'json' };

export const providerIds = [
  'auto',
  'codex',
  'claude',
  'openai',
  'anthropic',
  'compatible',
  'ollama',
] as const;
export type {
  ProviderId,
  ProviderConfig,
  AssistantSettings,
} from '../protocol/generated.ts';
export type ApiProvider = Exclude<ProviderId, 'auto' | 'codex' | 'claude'>;
export const defaultAssistantSettings: AssistantSettings =
  defaults.assistant as AssistantSettings;
export interface ProviderStatus {
  id: Exclude<ProviderId, 'auto'>;
  name: string;
  available: boolean;
  detail: string;
  hasKey?: boolean;
  models?: string[];
}
export interface AssistantStatus {
  providers: ProviderStatus[];
  effective: Exclude<ProviderId, 'auto'> | null;
  credentialStorage: 'encrypted' | 'session';
}
export interface Proposal {
  id: string;
  message: string;
  frontend: Frontend;
  baseId: string;
  baseVersion: number;
}
export interface GenerationInput {
  prompt: string;
  history: { role: 'user' | 'assistant'; content: string }[];
}
export interface ModelRequest {
  prompt: string;
  signal: AbortSignal;
  schema: Record<string, unknown>;
}
