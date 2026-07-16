import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Aperture, ChevronLeft, ChevronRight, FlaskConical, LogOut } from 'lucide-react';
import { useState } from 'react';
import { api, ApiRequestError } from '../api/client';
import type { JobListFilters, JobStatus } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { JobRow } from '../components/JobRow';
import { NotificationsBell } from '../components/NotificationsBell';
import { useToasts } from '../components/Toasts';
import { UploadDropzone } from '../components/UploadDropzone';

type FilterTab = 'all' | 'processing' | 'completed' | 'failed' | 'flagged';

const TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'processing', label: 'Processing' },
  { key: 'completed', label: 'Done' },
  { key: 'failed', label: 'Failed' },
  { key: 'flagged', label: 'Flagged' },
];

function filtersFor(tab: FilterTab, page: number): JobListFilters {
  if (tab === 'flagged') return { flagged: true, page };
  if (tab === 'all') return { page };
  return { status: tab as JobStatus, page };
}

export function DashboardPage() {
  const { user, logout } = useAuth();
  const { push } = useToasts();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<FilterTab>('all');
  const [page, setPage] = useState(1);

  const { data, isPending } = useQuery({
    queryKey: ['jobs', tab, page],
    queryFn: () => api.listJobs(filtersFor(tab, page)),
    // Poll only while something is actually moving; stop entirely when settled (D-006).
    refetchInterval: (query) => ((query.state.data?.activeCount ?? 0) > 0 ? 2500 : false),
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });

  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 });

  const retryMutation = useMutation({
    mutationFn: api.retryJob,
    onSuccess: (_res, id) => {
      push('info', 'Job re-queued — developing again');
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['job', id] });
    },
    onError: (err) =>
      push('error', err instanceof ApiRequestError ? err.message : 'Retry failed — try again'),
  });

  const jobs = data?.jobs ?? [];

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-edge bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-2.5">
            <span className="text-amber">
              <Aperture size={20} />
            </span>
            <span className="text-sm font-semibold tracking-tight">Darkroom</span>
            {data && data.activeCount > 0 && (
              <span className="ml-1 rounded-full border border-amber/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-amber">
                {data.activeCount} developing
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <NotificationsBell />
            <div className="hidden items-center gap-2.5 sm:flex">
              <span className="max-w-48 truncate font-mono text-xs text-muted">{user?.email}</span>
              <button
                onClick={logout}
                aria-label="Log out"
                className="flex size-9 items-center justify-center rounded-md border border-edge bg-surface text-muted transition-colors hover:text-ink"
              >
                <LogOut size={15} />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-16 pt-6">
        <UploadDropzone />

        <div className="mt-8 flex items-center justify-between gap-3">
          <div className="flex gap-1 overflow-x-auto rounded-md border border-edge bg-surface p-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => {
                  setTab(t.key);
                  setPage(1);
                }}
                className={`whitespace-nowrap rounded px-3 py-1.5 font-mono text-xs font-medium uppercase tracking-wider transition-colors ${
                  tab === t.key
                    ? t.key === 'flagged'
                      ? 'bg-alarm/15 text-alarm'
                      : 'bg-raised text-ink'
                    : 'text-faint hover:text-muted'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {data && (
            <span className="hidden font-mono text-xs text-faint sm:block">
              {data.total} job{data.total === 1 ? '' : 's'}
            </span>
          )}
        </div>

        <div className="mt-4 flex flex-col gap-2.5">
          {isPending && (
            <div className="rounded-lg border border-edge bg-surface px-4 py-10 text-center font-mono text-xs uppercase tracking-wider text-faint">
              Loading jobs…
            </div>
          )}

          {!isPending && jobs.length === 0 && (
            <div className="rounded-lg border border-dashed border-edge-strong px-4 py-14 text-center">
              <p className="text-sm text-muted">
                {tab === 'all'
                  ? 'The lab is empty. Drop an image above to start the pipeline.'
                  : `No ${tab === 'flagged' ? 'flagged' : tab} jobs.`}
              </p>
            </div>
          )}

          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              onRetry={(id) => retryMutation.mutate(id)}
              retrying={retryMutation.isPending && retryMutation.variables === job.id}
            />
          ))}
        </div>

        {data && data.totalPages > 1 && (
          <div className="mt-6 flex items-center justify-center gap-3">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              aria-label="Previous page"
              className="flex size-8 items-center justify-center rounded-md border border-edge bg-surface text-muted transition-colors hover:text-ink disabled:opacity-40"
            >
              <ChevronLeft size={15} />
            </button>
            <span className="font-mono text-xs text-muted">
              page {data.page} / {data.totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
              disabled={page >= data.totalPages}
              aria-label="Next page"
              className="flex size-8 items-center justify-center rounded-md border border-edge bg-surface text-muted transition-colors hover:text-ink disabled:opacity-40"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        )}

        {health?.aiProvider === 'mock' && (
          <div className="mt-10 flex items-start gap-3 rounded-lg border border-edge bg-surface/60 px-4 py-3.5">
            <FlaskConical size={15} className="mt-0.5 shrink-0 text-amber" />
            <p className="text-xs leading-relaxed text-muted">
              <span className="font-mono font-semibold uppercase tracking-wider text-amber">
                Mock AI mode
              </span>{' '}
              — no API keys configured, results are simulated. Filenames drive demo scenarios:{' '}
              <code className="text-ink">flagme.png</code> gets flagged,{' '}
              <code className="text-ink">flaky.png</code> fails once then recovers via automatic
              retry, <code className="text-ink">failme.png</code> exhausts retries and can be
              retried manually, <code className="text-ink">badreq.png</code> fails permanently.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
