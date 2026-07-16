import { RotateCcw } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { JobSummary } from '../api/types';
import { fileExt, formatBytes, timeAgo } from '../lib/format';
import { DevelopStrip } from './DevelopStrip';
import { FlagChip, StatusChip } from './StatusChip';

export function JobRow({
  job,
  onRetry,
  retrying,
}: {
  job: JobSummary;
  onRetry: (id: string) => void;
  retrying: boolean;
}) {
  return (
    <div
      className={`relative rounded-lg border bg-surface transition-colors hover:bg-raised ${
        job.flagged ? 'border-alarm/35' : 'border-edge'
      }`}
    >
      {/* Flagged jobs get the safelight bar — unmissable in a scan (spec: surfaced distinctly). */}
      {job.flagged && (
        <span className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-alarm" aria-hidden />
      )}

      <Link
        to={`/jobs/${job.id}`}
        className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-2 px-4 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_8rem_auto]"
      >
        <span className="flex size-9 items-center justify-center rounded border border-edge bg-raised font-mono text-[10px] font-semibold text-muted">
          {fileExt(job.file.originalName)}
        </span>

        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{job.file.originalName}</p>
          <p className="mt-0.5 truncate font-mono text-xs text-faint">
            {formatBytes(job.file.size)} · {timeAgo(job.createdAt)}
            {job.manualRetries > 0 && ` · retried ×${job.manualRetries}`}
          </p>
          {job.status === 'completed' && job.caption && (
            <p className="mt-1 truncate text-xs italic text-muted">“{job.caption}”</p>
          )}
          {job.status === 'failed' && job.error && (
            <p className="mt-1 truncate text-xs text-alarm/90">{job.error.message}</p>
          )}
        </div>

        <div className="hidden sm:block">
          <DevelopStrip stepStatuses={job.stepStatuses} />
        </div>

        <div className="col-span-3 flex items-center justify-end gap-2 sm:col-span-1">
          {job.flagged && <FlagChip categories={job.flaggedCategories} />}
          <StatusChip status={job.status} />
        </div>
      </Link>

      {job.status === 'failed' && (
        <div className="flex justify-end border-t border-edge/60 px-4 py-2">
          <button
            onClick={() => onRetry(job.id)}
            disabled={retrying}
            className="inline-flex items-center gap-1.5 rounded-md border border-amber/50 px-3 py-1.5 font-mono text-xs font-medium uppercase tracking-wider text-amber transition-colors hover:bg-amber/10 disabled:opacity-50"
          >
            <RotateCcw size={13} className={retrying ? 'animate-spin' : ''} />
            {retrying ? 'Queueing' : 'Retry'}
          </button>
        </div>
      )}
    </div>
  );
}
