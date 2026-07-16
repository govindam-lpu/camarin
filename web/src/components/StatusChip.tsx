import type { JobStatus } from '../api/types';

const CONFIG: Record<JobStatus, { label: string; className: string; dot: string; blink?: boolean }> =
  {
    pending: { label: 'Queued', className: 'text-muted border-edge', dot: 'bg-muted' },
    processing: {
      label: 'Processing',
      className: 'text-amber border-amber/40',
      dot: 'bg-amber',
      blink: true,
    },
    completed: { label: 'Done', className: 'text-sage border-sage/40', dot: 'bg-sage' },
    failed: { label: 'Failed', className: 'text-alarm border-alarm/40', dot: 'bg-alarm' },
  };

export function StatusChip({ status }: { status: JobStatus }) {
  const cfg = CONFIG[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wider ${cfg.className}`}
    >
      <span className={`size-1.5 rounded-full ${cfg.dot} ${cfg.blink ? 'animate-blink' : ''}`} />
      {cfg.label}
    </span>
  );
}

export function FlagChip({ categories }: { categories: string[] }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-alarm/15 px-2.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-alarm">
      Flagged{categories.length > 0 ? ` · ${categories.join(', ')}` : ''}
    </span>
  );
}
