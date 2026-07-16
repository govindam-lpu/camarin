import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  CircleDashed,
  Flag,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiRequestError } from '../api/client';
import type { JobDetail, Likelihood, SafetyCategory, StepStatus } from '../api/types';
import { useToasts } from '../components/Toasts';
import { FlagChip, StatusChip } from '../components/StatusChip';
import { fileExt, formatBytes, formatDuration } from '../lib/format';

const LIKELIHOOD_SCALE: Likelihood[] = [
  'VERY_UNLIKELY',
  'UNLIKELY',
  'POSSIBLE',
  'LIKELY',
  'VERY_LIKELY',
];
const SAFETY_ORDER: SafetyCategory[] = ['adult', 'violence', 'racy', 'medical', 'spoof'];

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'completed') return <CheckCircle2 size={17} className="text-sage" />;
  if (status === 'failed') return <XCircle size={17} className="text-alarm" />;
  if (status === 'running')
    return <CircleDashed size={17} className="animate-spin text-amber" style={{ animationDuration: '2.5s' }} />;
  return <Circle size={17} className="text-edge-strong" />;
}

function useJobImage(jobId: string | undefined, ready: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!jobId || !ready) return;
    let revoked: string | null = null;
    api
      .fetchImageUrl(jobId)
      .then((u) => {
        revoked = u;
        setUrl(u);
      })
      .catch(() => setUrl(null));
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [jobId, ready]);
  return url;
}

const STEP_META: { key: 'caption' | 'labels' | 'safety'; title: string; blurb: string }[] = [
  { key: 'caption', title: 'Caption', blurb: 'natural-language description' },
  { key: 'labels', title: 'Labels', blurb: 'objects & concepts detected' },
  { key: 'safety', title: 'Safety check', blurb: 'SafeSearch verdict' },
];

export function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { push } = useToasts();
  const queryClient = useQueryClient();

  const { data, isPending, error } = useQuery({
    queryKey: ['job', id],
    queryFn: () => api.getJob(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.job.status;
      return status === 'pending' || status === 'processing' ? 1500 : false;
    },
  });

  const job: JobDetail | undefined = data?.job;
  const imageUrl = useJobImage(id, !!job);

  const retryMutation = useMutation({
    mutationFn: () => api.retryJob(id!),
    onSuccess: () => {
      push('info', 'Job re-queued — developing again');
      void queryClient.invalidateQueries({ queryKey: ['job', id] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (err) =>
      push('error', err instanceof ApiRequestError ? err.message : 'Retry failed — try again'),
  });

  if (isPending) {
    return (
      <Shell>
        <div className="rounded-lg border border-edge bg-surface px-4 py-16 text-center font-mono text-xs uppercase tracking-wider text-faint">
          Loading job…
        </div>
      </Shell>
    );
  }

  if (error || !job) {
    return (
      <Shell>
        <div className="rounded-lg border border-edge bg-surface px-4 py-16 text-center">
          <p className="text-sm text-muted">This job does not exist or is not yours.</p>
          <Link to="/" className="mt-3 inline-block font-mono text-xs uppercase tracking-wider text-amber hover:underline">
            Back to all jobs
          </Link>
        </div>
      </Shell>
    );
  }

  const likelihoods = job.steps.safety.likelihoods;

  return (
    <Shell>
      {/* Title row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight">
            {job.file.originalName}
          </h1>
          <p className="mt-1 font-mono text-xs text-faint">
            job <span className="select-all text-muted">{job.id}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {job.flagged && <FlagChip categories={job.flaggedCategories} />}
          <StatusChip status={job.status} />
          {job.status === 'failed' && (
            <button
              onClick={() => retryMutation.mutate()}
              disabled={retryMutation.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-amber px-3.5 py-2 text-xs font-semibold text-black transition-colors hover:bg-amber/90 disabled:opacity-60"
            >
              <RotateCcw size={13} className={retryMutation.isPending ? 'animate-spin' : ''} />
              Retry job
            </button>
          )}
        </div>
      </div>

      {job.flagged && (
        <div className="mt-4 flex items-start gap-3 rounded-lg border border-alarm/40 bg-alarm/10 px-4 py-3.5">
          <Flag size={16} className="mt-0.5 shrink-0 text-alarm" />
          <div>
            <p className="text-sm font-medium text-alarm">
              This image was flagged for: {job.flaggedCategories.join(', ')}
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-alarm/80">
              SafeSearch returned LIKELY or VERY_LIKELY for the categories above. The full matrix
              is below.
            </p>
          </div>
        </div>
      )}

      {job.status === 'failed' && job.error && (
        <div className="mt-4 rounded-lg border border-alarm/40 bg-alarm/10 px-4 py-3.5">
          <p className="font-mono text-[11px] uppercase tracking-wider text-alarm">
            {job.error.code ?? 'ERROR'}
            {job.error.retryable === false && ' · not auto-retryable'}
          </p>
          <p className="mt-1 text-sm text-alarm/90">{job.error.message}</p>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* Left: the print + its metadata */}
        <div>
          <div className="overflow-hidden rounded-lg border border-edge bg-surface">
            {imageUrl ? (
              <img
                src={imageUrl}
                alt={job.steps.caption.text ?? job.file.originalName}
                className="max-h-96 w-full object-contain"
              />
            ) : (
              <div className="flex h-56 items-center justify-center font-mono text-xs uppercase tracking-wider text-faint">
                {fileExt(job.file.originalName)} · preview unavailable
              </div>
            )}
          </div>

          <dl className="mt-3 space-y-1.5 rounded-lg border border-edge bg-surface px-4 py-3.5 font-mono text-xs">
            {(
              [
                ['size', formatBytes(job.file.size)],
                ['type', job.file.mime],
                ['uploaded', new Date(job.createdAt).toLocaleString()],
                ['attempt', `${job.attemptsMade || '—'}${job.manualRetries ? ` (manual ×${job.manualRetries})` : ''}`],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4">
                <dt className="uppercase tracking-wider text-faint">{k}</dt>
                <dd className="truncate text-muted">{v}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Right: pipeline + results */}
        <div className="min-w-0">
          <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-muted">
            Pipeline
          </h2>
          <ol className="mt-3 space-y-0">
            {STEP_META.map((meta, i) => {
              const step = job.steps[meta.key];
              return (
                <li key={meta.key} className="relative flex gap-3 pb-5 last:pb-0">
                  {i < STEP_META.length - 1 && (
                    <span className="absolute left-[8px] top-6 h-full w-px bg-edge" aria-hidden />
                  )}
                  <span className="relative z-10 mt-0.5 bg-bg">
                    <StepIcon status={step.status} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <p className="text-sm font-medium">
                        {meta.title}
                        <span className="ml-2 text-xs font-normal text-faint">{meta.blurb}</span>
                      </p>
                      <p className="font-mono text-[11px] text-faint">
                        {step.status === 'completed' && formatDuration(step.durationMs)}
                        {step.attempts > 1 && ` · ${step.attempts} attempts`}
                      </p>
                    </div>
                    {step.status === 'failed' && step.error && (
                      <p className="mt-1 text-xs text-alarm/90">{step.error}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          {job.steps.caption.text && (
            <section className="mt-7">
              <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-muted">
                Caption
              </h2>
              <blockquote className="mt-2.5 rounded-lg border border-edge bg-surface px-5 py-4 text-base italic leading-relaxed">
                “{job.steps.caption.text}”
              </blockquote>
            </section>
          )}

          {job.steps.labels.items && job.steps.labels.items.length > 0 && (
            <section className="mt-7">
              <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-muted">
                Labels
              </h2>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {job.steps.labels.items.map((label) => (
                  <span
                    key={label.name}
                    className="inline-flex items-center gap-2 rounded-md border border-edge bg-surface px-2.5 py-1.5"
                  >
                    <span className="text-xs font-medium">{label.name}</span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-1 w-10 overflow-hidden rounded-full bg-edge">
                        <span
                          className="block h-full rounded-full bg-amber"
                          style={{ width: `${Math.round(label.score * 100)}%` }}
                        />
                      </span>
                      <span className="font-mono text-[10px] text-faint">
                        {Math.round(label.score * 100)}%
                      </span>
                    </span>
                  </span>
                ))}
              </div>
            </section>
          )}

          {job.steps.safety.status === 'completed' && likelihoods && (
            <section className="mt-7">
              <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-muted">
                Safety matrix
              </h2>
              <div className="mt-2.5 space-y-2.5 rounded-lg border border-edge bg-surface px-4 py-4">
                {SAFETY_ORDER.map((category) => {
                  const value = likelihoods[category] ?? 'UNKNOWN';
                  const level = LIKELIHOOD_SCALE.indexOf(value); // -1 for UNKNOWN
                  const flagging = value === 'LIKELY' || value === 'VERY_LIKELY';
                  return (
                    <div key={category} className="flex items-center gap-3">
                      <span className="w-16 shrink-0 text-xs font-medium capitalize">
                        {category}
                      </span>
                      <div className="flex flex-1 gap-1">
                        {LIKELIHOOD_SCALE.map((_, i) => (
                          <span
                            key={i}
                            className={`h-1.5 flex-1 rounded-full ${
                              level >= i
                                ? flagging
                                  ? 'bg-alarm'
                                  : value === 'POSSIBLE'
                                    ? 'bg-amber'
                                    : 'bg-sage/70'
                                : 'bg-edge'
                            }`}
                          />
                        ))}
                      </div>
                      <span
                        className={`w-28 shrink-0 text-right font-mono text-[10px] uppercase tracking-wide ${
                          flagging ? 'font-semibold text-alarm' : 'text-faint'
                        }`}
                      >
                        {value}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-edge bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center px-4">
          <Link
            to="/"
            className="inline-flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted transition-colors hover:text-ink"
          >
            <ArrowLeft size={15} />
            All jobs
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 pb-16 pt-6">{children}</main>
    </div>
  );
}
