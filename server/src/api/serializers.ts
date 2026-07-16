import type { JobDoc } from '../models/Job';
import type { NotificationDoc } from '../models/Notification';
import type { UserDoc } from '../models/User';

/**
 * Explicit DTO functions instead of toJSON transforms: the API shape is a deliberate,
 * greppable contract — not whatever the schema happens to contain.
 */

export function serializeUser(user: UserDoc) {
  return { id: user.id as string, email: user.email, createdAt: user.createdAt };
}

function serializeStepBase(step: {
  status: string;
  attempts: number;
  startedAt?: Date | null;
  completedAt?: Date | null;
  durationMs?: number | null;
  error?: string | null;
}) {
  return {
    status: step.status,
    attempts: step.attempts,
    startedAt: step.startedAt ?? null,
    completedAt: step.completedAt ?? null,
    durationMs: step.durationMs ?? null,
    error: step.error ?? null,
  };
}

/** Slim shape for the list view. */
export function serializeJobSummary(job: JobDoc) {
  return {
    id: job.id as string,
    status: job.status,
    // Per-step statuses power the list's live pipeline strip without the full payload.
    stepStatuses: {
      caption: job.steps.caption.status,
      labels: job.steps.labels.status,
      safety: job.steps.safety.status,
    },
    flagged: job.flagged,
    flaggedCategories: job.flaggedCategories,
    file: {
      originalName: job.file.originalName,
      mime: job.file.mime,
      size: job.file.size,
    },
    caption: job.steps.caption.text ?? null,
    error: job.error?.message
      ? {
          code: job.error.code ?? null,
          message: job.error.message,
          retryable: job.error.retryable ?? null,
        }
      : null,
    attemptsMade: job.attemptsMade,
    manualRetries: job.manualRetries,
    createdAt: job.createdAt,
    completedAt: job.completedAt ?? null,
  };
}

/** Full shape for the detail view: everything the pipeline recorded. */
export function serializeJobDetail(job: JobDoc) {
  return {
    ...serializeJobSummary(job),
    queuedAt: job.queuedAt ?? null,
    startedAt: job.startedAt ?? null,
    steps: {
      caption: {
        ...serializeStepBase(job.steps.caption),
        text: job.steps.caption.text ?? null,
      },
      labels: {
        ...serializeStepBase(job.steps.labels),
        items: job.steps.labels.items ?? null,
      },
      safety: {
        ...serializeStepBase(job.steps.safety),
        safe: job.steps.safety.safe ?? null,
        likelihoods: job.steps.safety.likelihoods ?? null,
      },
    },
  };
}

export function serializeNotification(n: NotificationDoc) {
  return {
    id: n.id as string,
    jobId: String(n.jobId),
    type: n.type,
    message: n.message,
    read: n.read,
    createdAt: n.createdAt,
  };
}
