import {
  FluidError,
  type Frontend,
  type FrontendSummary,
} from '../protocol/index';
import { backend } from './backend';

// Source changes only with its version. Data revisions do not invalidate this cache.
const sources = new Map<
  string,
  { version: number; updatedAt: string; source: Promise<Frontend> }
>();

export function frontendSource(frontend: FrontendSummary): Promise<Frontend> {
  const cached = sources.get(frontend.id);
  if (
    cached?.version === frontend.version &&
    cached.updatedAt === frontend.updatedAt
  )
    return cached.source;
  const source = backend
    .request<Frontend>('frontendSource', frontend.id)
    .then((value) => {
      if (
        value.version !== frontend.version ||
        value.updatedAt !== frontend.updatedAt
      )
        throw new FluidError(
          'VERSION_CONFLICT',
          'The interface changed. Try again.',
        );
      return value;
    });
  sources.set(frontend.id, {
    version: frontend.version,
    updatedAt: frontend.updatedAt,
    source,
  });
  void source.catch(() => {
    if (sources.get(frontend.id)?.source === source)
      sources.delete(frontend.id);
  });
  if (sources.size > 16) sources.delete(sources.keys().next().value!);
  return source;
}
