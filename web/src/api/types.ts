export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed';
export type StepName = 'caption' | 'labels' | 'safety';
export type SafetyCategory = 'adult' | 'spoof' | 'medical' | 'violence' | 'racy';
export type Likelihood =
  | 'UNKNOWN'
  | 'VERY_UNLIKELY'
  | 'UNLIKELY'
  | 'POSSIBLE'
  | 'LIKELY'
  | 'VERY_LIKELY';

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

export interface JobError {
  code: string | null;
  message: string;
  retryable: boolean | null;
}

export interface JobSummary {
  id: string;
  status: JobStatus;
  stepStatuses: Record<StepName, StepStatus>;
  flagged: boolean;
  flaggedCategories: SafetyCategory[];
  file: { originalName: string; mime: string; size: number };
  caption: string | null;
  error: JobError | null;
  attemptsMade: number;
  manualRetries: number;
  createdAt: string;
  completedAt: string | null;
}

export interface StepBase {
  status: StepStatus;
  attempts: number;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

export interface JobDetail extends JobSummary {
  queuedAt: string | null;
  startedAt: string | null;
  steps: {
    caption: StepBase & { text: string | null };
    labels: StepBase & { items: { name: string; score: number }[] | null };
    safety: StepBase & {
      safe: boolean | null;
      likelihoods: Partial<Record<SafetyCategory, Likelihood>> | null;
    };
  };
}

export interface JobListResponse {
  jobs: JobSummary[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  activeCount: number;
}

export interface AppNotification {
  id: string;
  jobId: string;
  type: 'job_flagged' | 'job_failed';
  message: string;
  read: boolean;
  createdAt: string;
}

export interface NotificationsResponse {
  notifications: AppNotification[];
  unreadCount: number;
}

export interface HealthResponse {
  ok: boolean;
  mongo: boolean;
  redis: boolean;
  aiProvider: 'mock' | 'real';
  uptimeSec: number;
}

export interface JobListFilters {
  status?: JobStatus;
  flagged?: boolean;
  page?: number;
  limit?: number;
}
