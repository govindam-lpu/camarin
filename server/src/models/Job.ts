import mongoose, { Schema, type HydratedDocument } from 'mongoose';

export const JOB_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const STEP_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** The three pipeline steps, in execution order (spec: sequential). */
export const PIPELINE_STEPS = ['caption', 'labels', 'safety'] as const;
export type PipelineStepName = (typeof PIPELINE_STEPS)[number];

export const SAFETY_CATEGORIES = ['adult', 'spoof', 'medical', 'violence', 'racy'] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];

export const LIKELIHOODS = [
  'UNKNOWN',
  'VERY_UNLIKELY',
  'UNLIKELY',
  'POSSIBLE',
  'LIKELY',
  'VERY_LIKELY',
] as const;
export type Likelihood = (typeof LIKELIHOODS)[number];

/** Spec-literal flagging rule: only LIKELY / VERY_LIKELY flag; POSSIBLE does not. (D-012) */
export const FLAGGING_LIKELIHOODS: readonly Likelihood[] = ['LIKELY', 'VERY_LIKELY'];

/*
 * The Job document shape is declared explicitly (not inferred) — it is the contract
 * shared by API, worker, and serializers, and deserves to be greppable.
 */

export interface StepBase {
  status: StepStatus;
  attempts: number;
  startedAt?: Date | null;
  completedAt?: Date | null;
  durationMs?: number | null;
  error?: string | null;
}

export interface CaptionStep extends StepBase {
  text?: string | null;
}

export interface LabelItem {
  name: string;
  score: number;
}

export interface LabelsStep extends StepBase {
  items?: LabelItem[] | null;
}

export interface SafetyStep extends StepBase {
  safe?: boolean | null;
  likelihoods?: Partial<Record<SafetyCategory, Likelihood>> | null;
}

export interface JobShape {
  userId: mongoose.Types.ObjectId;
  status: JobStatus;
  file: {
    originalName: string;
    mime: string;
    size: number;
    storageKey: string;
  };
  steps: {
    caption: CaptionStep;
    labels: LabelsStep;
    safety: SafetyStep;
  };
  flagged: boolean;
  flaggedCategories: string[];
  /** Last terminal error (classified by the worker, D-009). */
  error?: {
    message?: string | null;
    code?: string | null;
    retryable?: boolean | null;
  } | null;
  /** Attempt number of the current enqueue (owned by the pipeline, reset on manual retry). */
  attemptsMade: number;
  /** How many times the user pressed Retry. */
  manualRetries: number;
  queuedAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Per-step bookkeeping: each step is checkpointed to Mongo the moment it finishes so
 * retries resume from the failed step instead of re-paying for completed ones. (D-008)
 */
const stepBase = {
  status: { type: String, enum: STEP_STATUSES, default: 'pending' as StepStatus },
  attempts: { type: Number, default: 0 },
  startedAt: Date,
  completedAt: Date,
  durationMs: Number,
  error: String,
};

const captionStepSchema = new Schema({ ...stepBase, text: String }, { _id: false });

const labelItemSchema = new Schema(
  {
    name: { type: String, required: true },
    score: { type: Number, required: true },
  },
  { _id: false },
);
const labelsStepSchema = new Schema(
  { ...stepBase, items: { type: [labelItemSchema], default: undefined } },
  { _id: false },
);

const safetyStepSchema = new Schema(
  {
    ...stepBase,
    safe: Boolean,
    likelihoods: {
      adult: { type: String, enum: LIKELIHOODS },
      spoof: { type: String, enum: LIKELIHOODS },
      medical: { type: String, enum: LIKELIHOODS },
      violence: { type: String, enum: LIKELIHOODS },
      racy: { type: String, enum: LIKELIHOODS },
    },
  },
  { _id: false },
);

const jobSchema = new Schema<JobShape>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: JOB_STATUSES, default: 'pending', index: true },
    file: {
      originalName: { type: String, required: true },
      mime: { type: String, required: true },
      size: { type: Number, required: true },
      storageKey: { type: String, required: true },
    },
    steps: {
      caption: { type: captionStepSchema, default: () => ({}) },
      labels: { type: labelsStepSchema, default: () => ({}) },
      safety: { type: safetyStepSchema, default: () => ({}) },
    },
    flagged: { type: Boolean, default: false, index: true },
    flaggedCategories: { type: [String], default: [] },
    error: {
      message: String,
      code: String,
      retryable: Boolean,
    },
    attemptsMade: { type: Number, default: 0 },
    manualRetries: { type: Number, default: 0 },
    queuedAt: Date,
    startedAt: Date,
    completedAt: Date,
  },
  { timestamps: true },
);

// The dominant query: "this user's jobs, newest first".
jobSchema.index({ userId: 1, createdAt: -1 });

export type JobDoc = HydratedDocument<JobShape>;
export const Job = mongoose.model<JobShape>('Job', jobSchema);
