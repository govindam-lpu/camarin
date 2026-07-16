import type { Likelihood, SafetyCategory } from '../../models/Job';

/** What every pipeline step receives. */
export interface ImageInput {
  data: Buffer;
  mime: string;
  /** Original upload filename — drives the mock provider's demo hooks (D-005). */
  filename: string;
  /** 1-based attempt number for the current enqueue — lets the mock `flaky` hook succeed on retry. */
  attempt: number;
}

export interface CaptionResult {
  text: string;
}

export interface LabelItem {
  name: string;
  score: number;
}

export interface LabelsResult {
  items: LabelItem[];
}

export type SafetyLikelihoods = Record<SafetyCategory, Likelihood>;

export interface SafetyResult {
  likelihoods: SafetyLikelihoods;
}

/**
 * The seam the worker pipeline is built against (D-004). `real` composes
 * Hugging Face (caption) + Google Vision (labels, SafeSearch); `mock` is
 * deterministic and key-free for local review and unit tests.
 */
export interface AiProvider {
  name: string;
  caption(input: ImageInput): Promise<CaptionResult>;
  detectLabels(input: ImageInput): Promise<LabelsResult>;
  checkSafety(input: ImageInput): Promise<SafetyResult>;
}
