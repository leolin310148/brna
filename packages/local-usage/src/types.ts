export const USAGE_SCHEMA = "brna-usage/1" as const;
export const SUMMARY_SCHEMA = "brna-usage-summary/1" as const;
export const EXPORT_SCHEMA = "brna-usage-export/1" as const;
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export type UsageSurface = "cli" | "mcp";
export type UsageCaller = "codex" | "claude" | "cursor" | "copilot" | "gemini" | "continue" | "unknown";
export type UsageOutcome = "success" | "error";
export type UsageValue = string | number | boolean;
export type UsageDimensions = Record<string, UsageValue>;

export interface UsageEventBase {
  schema: typeof USAGE_SCHEMA;
  event: "operation.started" | "operation.finished";
  timestamp: string;
  installation_id: string;
  project_id: string;
  session_id: string;
  operation_id: string;
  surface: UsageSurface;
  caller: UsageCaller;
  operation: string;
  brna_version: string;
  platform: NodeJS.Platform;
  arch: string;
  dimensions?: UsageDimensions;
}

export interface UsageStartedEvent extends UsageEventBase {
  event: "operation.started";
}

export interface UsageFinishedEvent extends UsageEventBase {
  event: "operation.finished";
  outcome: UsageOutcome;
  duration_ms: number;
  exit_code?: number;
  error_code?: string;
  phase?: string;
  metrics?: UsageDimensions;
}

export type UsageEvent = UsageStartedEvent | UsageFinishedEvent;

export interface UsageEnablement {
  enabled: boolean;
  reason: "do_not_track" | "environment" | "setting" | "ci" | "default";
}

export interface UsageStatus extends UsageEnablement {
  path: string;
  retention_days: number;
  max_bytes: number;
  current_bytes: number;
  event_files: number;
}

export interface DurationSummary {
  p50: number | null;
  p95: number | null;
}

export interface OperationSummary {
  operation: string;
  started: number;
  success: number;
  error: number;
  interrupted: number;
  success_rate: number | null;
  duration_ms: DurationSummary;
}

export interface UsageSummary {
  schema: typeof SUMMARY_SCHEMA;
  window: { since: string; until: string };
  totals: {
    started: number;
    success: number;
    error: number;
    interrupted: number;
    success_rate: number | null;
  };
  operations: OperationSummary[];
  errors: Array<{ code: string; count: number }>;
  recoveries: Array<{ from_error: string; to_operation: string; count: number }>;
}

export interface UsageExport {
  schema: typeof EXPORT_SCHEMA;
  generated_at: string;
  collection: {
    retention_days: number;
    max_bytes: number;
    event_files: number;
    current_bytes: number;
  };
  summary: UsageSummary;
}

export interface UsageRuntimeOptions {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  homeDir?: string;
  cwd?: string;
  sessionId?: string;
  now?: () => Date;
  randomUUID?: () => string;
  retentionDays?: number;
  maxBytes?: number;
}

export interface StartOperationInput extends UsageRuntimeOptions {
  surface: UsageSurface;
  operation: string;
  brnaVersion: string;
  dimensions?: UsageDimensions;
}

export interface FinishOperationInput {
  exitCode?: number;
  errorCode?: string;
  phase?: string;
  metrics?: UsageDimensions;
}

export interface UsageOperation {
  readonly enabled: boolean;
  readonly operationId?: string;
  finishSuccess(input?: FinishOperationInput): Promise<void>;
  finishError(input?: FinishOperationInput): Promise<void>;
}
