import { ApiError } from '../api/transport';
import type { ActivityApi } from '../activity/resources';

export type ActivityDataflow = Readonly<{ ownerInputApi: ActivityApi; noSaveApi: ActivityApi; dispose(): void }>;
const id = '[A-Za-z0-9_-]{1,80}';
const readPaths = [
  /^\/v1\/activity\/(?:capabilities|calendar|catalog|exercises|plans|schedule|entries|adherence)$/,
  new RegExp(`^/v1/activity/(?:exercises|plans|entries)/${id}$`),
];
const postPaths = [
  /^\/v1\/activity\/(?:calendar|exercises|plans|schedule|entries)$/,
  /^\/v1\/activity\/plans\/import-legacy$/,
  new RegExp(`^/v1/activity/exercises/${id}/retire$`),
  new RegExp(`^/v1/activity/plans/${id}/archive$`),
  new RegExp(`^/v1/activity/entries/${id}/void$`),
  /^\/v1\/activity\/schedule\/days\/\d{4}-\d{2}-\d{2}\/correct$/,
];
function allowed(path: string, method: string): boolean {
  if (typeof path !== 'string' || path.length > 2048 || path.includes('#')) return false;
  const query = path.indexOf('?');
  if (query !== -1 && method !== 'GET') return false;
  const pathname = query === -1 ? path : path.slice(0, query);
  if (method === 'GET') return readPaths.some(pattern => pattern.test(pathname));
  if (method === 'POST') return postPaths.some(pattern => pattern.test(pathname));
  return method === 'PATCH' && new RegExp(`^/v1/activity/(?:exercises|plans|entries)/${id}$`).test(pathname);
}

// Root retains this factory result. No-save inputs cannot promote themselves by changing body/source/review flags.
export function createActivityDataflow(input: Readonly<{
  sessionGeneration: string;
  isCurrentSession(): boolean;
  api: ActivityApi;
}>): ActivityDataflow {
  let disposed = false;
  const current = (): boolean => !disposed && input.isCurrentSession();
  const changed = (originalEffectUnknown = false): ApiError => new ApiError(409, 'session_changed',
    'The account session changed. Check the original account before repeating a change.', false, originalEffectUnknown);
  const ownerInputApi: ActivityApi = Object.freeze({
    async request<T>(path: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
      if (!current()) throw changed();
      if (!allowed(path, method)) throw new ApiError(403, 'activity_route_not_allowed', 'Use the dedicated Activity input API.');
      try {
        const value = await input.api.request<T>(path, method, body, key);
        if (!current()) throw changed(method !== 'GET');
        return value;
      } catch (error) {
        if (!current()) throw changed(method !== 'GET' ||
          (error instanceof ApiError && (error.effectUnknown || error.originalEffectUnknown)));
        throw error;
      }
    },
  });
  const noSaveApi: ActivityApi = Object.freeze({
    async request<T>(_path: string, _method?: string, _body?: unknown, _key?: string): Promise<T> {
      throw new ApiError(403, 'activity_no_save_channel', 'This flow does not retain Activity inputs.');
    },
  });
  return Object.freeze({ ownerInputApi, noSaveApi, dispose(): void { disposed = true; } });
}
