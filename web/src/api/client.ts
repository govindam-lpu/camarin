import type {
  HealthResponse,
  JobDetail,
  JobListFilters,
  JobListResponse,
  JobSummary,
  NotificationsResponse,
  User,
} from './types';

const TOKEN_KEY = 'darkroom_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** Registered by the auth provider: called on any 401 so the app can log out cleanly. */
let onUnauthorized: (() => void) | null = null;
export function registerUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  formData?: FormData;
  /** Login/signup legitimately return 401 — don't nuke the session for those. */
  skipUnauthorizedHandler?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.formData ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
  } catch {
    throw new ApiRequestError(0, 'NETWORK_ERROR', 'Cannot reach the server — check your connection');
  }

  if (res.status === 401 && !opts.skipUnauthorizedHandler) {
    onUnauthorized?.();
  }

  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiRequestError(
      res.status,
      payload?.error?.code ?? 'UNKNOWN',
      payload?.error?.message ?? `Request failed (${res.status})`,
    );
  }

  return (await res.json()) as T;
}

export const api = {
  signup: (email: string, password: string) =>
    request<{ token: string; user: User }>('/auth/signup', {
      method: 'POST',
      body: { email, password },
      skipUnauthorizedHandler: true,
    }),

  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: { email, password },
      skipUnauthorizedHandler: true,
    }),

  me: () => request<{ user: User }>('/auth/me'),

  uploadJob: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return request<{ job: JobSummary }>('/jobs', { method: 'POST', formData });
  },

  listJobs: (filters: JobListFilters = {}) => {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.flagged !== undefined) params.set('flagged', String(filters.flagged));
    if (filters.page) params.set('page', String(filters.page));
    if (filters.limit) params.set('limit', String(filters.limit));
    const qs = params.toString();
    return request<JobListResponse>(`/jobs${qs ? `?${qs}` : ''}`);
  },

  getJob: (id: string) => request<{ job: JobDetail }>(`/jobs/${id}`),

  retryJob: (id: string) => request<{ job: JobSummary }>(`/jobs/${id}/retry`, { method: 'POST' }),

  /** The <img> tag can't carry the Bearer header — fetch to a blob URL instead (D-013). */
  fetchImageUrl: async (id: string): Promise<string> => {
    const token = getToken();
    const res = await fetch(`/api/jobs/${id}/image`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiRequestError(res.status, 'IMAGE_FETCH_FAILED', 'Could not load image');
    return URL.createObjectURL(await res.blob());
  },

  notifications: () => request<NotificationsResponse>('/notifications'),

  markNotificationsRead: (payload: { ids?: string[]; all?: boolean }) =>
    request<{ ok: boolean }>('/notifications/read', { method: 'POST', body: payload }),

  health: () => request<HealthResponse>('/health'),
};
