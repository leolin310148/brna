import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { getUsageIdentity, normalizeUsageCaller, pseudonymousId, resolveUsageEnablement, setUsageEnabled, usageStateDir } from "./config.js";
import { sanitizeDimensions, sanitizeErrorCode, sanitizePhase } from "./sanitize.js";
import { appendUsageEvent, cleanupUsageFiles, clearUsageEvents, readUsageEvents, usageStorageInfo } from "./storage.js";
import { buildUsageExport, buildUsageSummary, summarizeUsage, writeUsageExport } from "./summary.js";
import { DEFAULT_MAX_BYTES, DEFAULT_RETENTION_DAYS, USAGE_SCHEMA, type FinishOperationInput, type StartOperationInput, type UsageEventBase, type UsageFinishedEvent, type UsageOperation, type UsageRuntimeOptions, type UsageStartedEvent, type UsageStatus } from "./types.js";

export * from "./types.js";
export { sanitizeCliInvocation, sanitizeMcpResource, sanitizeMcpTool } from "./sanitize.js";
export type { SanitizedInvocation } from "./sanitize.js";
export { buildUsageSummary, summarizeUsage, buildUsageExport, writeUsageExport, readUsageEvents, usageStateDir, resolveUsageEnablement, cleanupUsageFiles };

export async function startUsageOperation(input: StartOperationInput): Promise<UsageOperation> {
  try {
    const enablement = await resolveUsageEnablement(input);
    if (!enablement.enabled) return NOOP_OPERATION;
    const now = input.now ?? (() => new Date());
    const uuid = input.randomUUID ?? randomUUID;
    const identity = await getUsageIdentity(input);
    const cwd = input.cwd ?? process.cwd();
    const project = await realpath(cwd).catch(() => resolve(cwd));
    const session = input.sessionId ?? input.env?.BRNA_SESSION_ID ?? process.env.BRNA_SESSION_ID ?? `process-${process.pid}`;
    const operationId = uuid();
    const startedAt = now();
    const base: UsageEventBase = {
      schema: USAGE_SCHEMA,
      event: "operation.started",
      timestamp: startedAt.toISOString(),
      installation_id: identity.installation_id,
      project_id: pseudonymousId(identity.secret, "project", project),
      session_id: pseudonymousId(identity.secret, "session", `${project}\0${session}`),
      operation_id: operationId,
      surface: input.surface,
      caller: normalizeUsageCaller((input.env ?? process.env).BRNA_CALLER),
      operation: safeOperationName(input.operation),
      brna_version: safeVersion(input.brnaVersion),
      platform: input.platform ?? process.platform,
      arch: input.arch ?? process.arch,
      ...(sanitizeDimensions(input.dimensions, "dimensions") ? { dimensions: sanitizeDimensions(input.dimensions, "dimensions") } : {}),
    };
    await appendUsageEvent(base as UsageStartedEvent, input);

    let finished = false;
    const finish = async (outcome: "success" | "error", finishInput: FinishOperationInput = {}): Promise<void> => {
      if (finished) return;
      finished = true;
      const finishedAt = now();
      const event: UsageFinishedEvent = {
        ...base,
        event: "operation.finished",
        timestamp: finishedAt.toISOString(),
        outcome,
        duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        ...(Number.isInteger(finishInput.exitCode) ? { exit_code: finishInput.exitCode } : {}),
        ...(sanitizeErrorCode(finishInput.errorCode) ? { error_code: sanitizeErrorCode(finishInput.errorCode) } : {}),
        ...(sanitizePhase(finishInput.phase) ? { phase: sanitizePhase(finishInput.phase) } : {}),
        ...(sanitizeDimensions(finishInput.metrics, "metrics") ? { metrics: sanitizeDimensions(finishInput.metrics, "metrics") } : {}),
      };
      await appendUsageEvent(event, input).catch(() => undefined);
    };
    return {
      enabled: true,
      operationId,
      finishSuccess: (finishInput) => finish("success", finishInput),
      finishError: (finishInput) => finish("error", finishInput),
    };
  } catch {
    return NOOP_OPERATION;
  }
}

export async function getUsageStatus(options: UsageRuntimeOptions = {}): Promise<UsageStatus> {
  const enablement = await resolveUsageEnablement(options);
  const storage = await usageStorageInfo(options);
  return {
    ...enablement,
    path: usageStateDir(options),
    retention_days: options.retentionDays ?? DEFAULT_RETENTION_DAYS,
    max_bytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    current_bytes: storage.currentBytes,
    event_files: storage.eventFiles,
  };
}

export async function enableUsage(options: UsageRuntimeOptions = {}): Promise<void> {
  await setUsageEnabled(true, options);
}

export async function disableUsage(options: UsageRuntimeOptions = {}): Promise<void> {
  await setUsageEnabled(false, options);
}

export { clearUsageEvents };

export function errorCodeFromExit(exitCode: number): string | undefined {
  if (exitCode === 0) return undefined;
  if (exitCode === 2) return "selector.not_found";
  if (exitCode === 3) return "selector.ambiguous";
  if (exitCode === 4) return "cli.invalid_argument";
  if (exitCode === 5) return "action.refused";
  if (exitCode === 6) return "runtime.failure";
  return exitCode === 1 ? "metro.unreachable" : "internal.unexpected";
}

const NOOP_OPERATION: UsageOperation = {
  enabled: false,
  finishSuccess: async () => undefined,
  finishError: async () => undefined,
};

function safeOperationName(value: string): string {
  return /^[a-z][a-z0-9._-]{0,63}$/.test(value) ? value : "unknown";
}

function safeVersion(value: string): string {
  const match = value.match(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  return match ? match[0] : "unknown";
}
