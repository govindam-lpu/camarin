import type { StepName, StepStatus } from '../api/types';

const STEP_ORDER: StepName[] = ['caption', 'labels', 'safety'];
const STEP_LABEL: Record<StepName, string> = {
  caption: 'caption',
  labels: 'labels',
  safety: 'safety',
};

const SEGMENT_CLASS: Record<StepStatus, string> = {
  pending: 'bg-edge',
  running: 'bg-amber animate-develop',
  completed: 'bg-sage',
  failed: 'bg-alarm',
};

/**
 * The signature element: every job carries its pipeline state as a three-segment
 * "develop strip" — caption | labels | safety — like frames moving through the baths.
 * Amber shimmer = in the bath, sage = fixed, alarm = ruined.
 */
export function DevelopStrip({
  stepStatuses,
  showLabels = false,
}: {
  stepStatuses: Record<StepName, StepStatus>;
  showLabels?: boolean;
}) {
  return (
    <div className="flex min-w-28 flex-col gap-1" aria-hidden={!showLabels}>
      <div className="flex h-1.5 gap-1">
        {STEP_ORDER.map((step) => (
          <div
            key={step}
            title={`${STEP_LABEL[step]}: ${stepStatuses[step]}`}
            className={`flex-1 rounded-full transition-colors duration-300 ${SEGMENT_CLASS[stepStatuses[step]]}`}
          />
        ))}
      </div>
      {showLabels && (
        <div className="flex justify-between font-mono text-[10px] uppercase tracking-wider text-faint">
          {STEP_ORDER.map((step) => (
            <span key={step}>{STEP_LABEL[step]}</span>
          ))}
        </div>
      )}
    </div>
  );
}
