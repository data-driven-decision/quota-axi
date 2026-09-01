import {
  deleteCachedProvider as deleteCachedProviderFromDisk,
  readCachedProvider as readCachedProviderFromDisk,
} from "../cache.js";
import { providerFetch } from "../lib/http.js";
import { clampPercent, retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { VERSION } from "../version.js";
import {
  failedProvider,
  sourceNames,
  staleFromCache,
  successProvider,
} from "./common.js";
import {
  createPiMinimaxCredentialBroker,
  type MinimaxCredentialBroker,
  type MinimaxCredentialInspection,
  type MinimaxCredentialResolution,
} from "./pi-minimax-credential.js";

export const MINIMAX_QUOTA_URL =
  "https://www.minimaxi.com/v1/token_plan/remains";
export const PI_MINIMAX_CREDENTIAL_SOURCE = "pi:minimax-cn";
const LABEL = "MiniMax";
const OPERATION_DEADLINE_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 262_144;
const BODY_CLEANUP_TIMEOUT_MS = 100;
const USER_AGENT = `quota-axi/${VERSION}`;
/**
 * The Token Plan quota is shared across every model the plan covers; MiniMax
 * reports it under this `model_name`. Any other `model_name` (for example
 * `video`) is a resource outside that shared pool and is reported as its own
 * `model:<name>` scope instead of folded into the shared one.
 */
const PRIMARY_MODEL_NAME = "general";
/**
 * MiniMax's documented `base_resp.status_code` for "auth mismatch" (the
 * stored API key does not match/authenticate the account). This arrives
 * over HTTP 200, so it must be classified from the JSON body rather than
 * the HTTP status, and it is a definitive credential rejection like a
 * 401/403 would be, not a generic rejected request.
 */
const AUTH_MISMATCH_STATUS_CODE = 1004;

type WindowScope = "interval" | "weekly";

export type NormalizedMinimaxPayload = {
  windows: QuotaWindow[];
};

type MinimaxDependencies = {
  broker: MinimaxCredentialBroker;
  fetch: typeof globalThis.fetch;
  readCachedProvider: typeof readCachedProviderFromDisk;
  deleteCachedProvider: typeof deleteCachedProviderFromDisk;
  now: () => number;
  deadlineMs: number;
};

type MinimaxFailureOptions = {
  status?: ProviderStatus;
  staleEligible?: boolean;
  definitiveAuth?: boolean;
  retryAfter?: string;
};

export function createMinimaxAdapter(
  overrides: Partial<MinimaxDependencies> = {},
): ProviderAdapter {
  const dependencies: MinimaxDependencies = {
    broker: createPiMinimaxCredentialBroker(),
    fetch: providerFetch,
    readCachedProvider: readCachedProviderFromDisk,
    deleteCachedProvider: deleteCachedProviderFromDisk,
    now: Date.now,
    deadlineMs: OPERATION_DEADLINE_MS,
    ...overrides,
  };
  let inFlight: Promise<ProviderQuota> | undefined;

  return {
    id: "minimax",
    label: LABEL,
    fetchQuota(_options: ProviderOptions): Promise<ProviderQuota> {
      if (inFlight) return inFlight;
      const acquisition = acquireMinimaxQuota(dependencies).finally(() => {
        if (inFlight === acquisition) inFlight = undefined;
      });
      inFlight = acquisition;
      return acquisition;
    },
    async inspectAuth(_options: ProviderOptions): Promise<AuthProviderReport> {
      let inspection: MinimaxCredentialInspection;
      try {
        inspection = await dependencies.broker.inspect();
      } catch {
        inspection = "error";
      }
      const error =
        inspection === "unsupported"
          ? "unsupported_credential_type"
          : inspection === "expired"
            ? "pi_minimax_credential_expired"
            : inspection === "error"
              ? "credential_resolution_failed"
              : undefined;
      return {
        provider: "minimax",
        sources: [
          {
            source: PI_MINIMAX_CREDENTIAL_SOURCE,
            status:
              inspection === "available"
                ? "available"
                : inspection === "expired"
                  ? "expired"
                  : error
                    ? "invalid"
                    : "missing",
            ...(error ? { error } : {}),
          },
        ],
      };
    },
  };
}

export const minimaxAdapter = createMinimaxAdapter();

async function acquireMinimaxQuota(
  dependencies: MinimaxDependencies,
): Promise<ProviderQuota> {
  let resolution: MinimaxCredentialResolution;
  try {
    resolution = await dependencies.broker.resolve();
  } catch {
    resolution = { status: "error" };
  }

  let attempts: SourceAttempt[];

  if (resolution.status !== "available") {
    const failure = credentialFailureFor(resolution);
    attempts = [
      {
        source: PI_MINIMAX_CREDENTIAL_SOURCE,
        status: resolution.status === "error" ? "failed" : "skipped",
        error: failure.code,
      },
    ];
    return failureReport(failure, attempts, dependencies);
  }

  try {
    const payload = await requestMinimaxQuota(
      resolution.credential,
      dependencies.fetch,
      dependencies.deadlineMs,
      dependencies.now,
    );
    const normalized = normalizeMinimaxPayload(payload);
    attempts = [{ source: PI_MINIMAX_CREDENTIAL_SOURCE, status: "success" }];
    return successProvider({
      provider: "minimax",
      label: LABEL,
      source: "api",
      windows: normalized.windows,
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const failure =
      error instanceof MinimaxFailure
        ? error
        : new MinimaxFailure("quota_request_failed", { staleEligible: true });
    attempts = [
      {
        source: PI_MINIMAX_CREDENTIAL_SOURCE,
        status: "failed",
        error: failure.code,
      },
    ];
    return failureReport(failure, attempts, dependencies);
  }
}

function credentialFailureFor(
  resolution: Exclude<MinimaxCredentialResolution, { status: "available" }>,
): MinimaxFailure {
  if (resolution.status === "missing") {
    return new MinimaxFailure("minimax_credential_unavailable", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (resolution.status === "unsupported") {
    return new MinimaxFailure("unsupported_credential_type", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (resolution.status === "expired") {
    return new MinimaxFailure("pi_minimax_credential_expired", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  return new MinimaxFailure("credential_resolution_failed", {
    staleEligible: true,
  });
}

function failureReport(
  failure: MinimaxFailure,
  attempts: SourceAttempt[],
  dependencies: MinimaxDependencies,
): ProviderQuota {
  if (failure.definitiveAuth) {
    try {
      dependencies.deleteCachedProvider("minimax");
    } catch {
      // The current auth failure is still definitive even if the cache is not writable.
    }
  }

  if (failure.staleEligible) {
    try {
      const cached = dependencies.readCachedProvider("minimax");
      if (cached && cached.provider === "minimax" && cached.source === "api") {
        return staleFromCache(
          cached,
          failure.code,
          sourceNames(attempts),
          attempts,
        );
      }
    } catch {
      // Cache I/O cannot replace the bounded current provider failure.
    }
  }

  return failedProvider({
    provider: "minimax",
    label: LABEL,
    status: failure.status,
    error: failure.code,
    ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

async function requestMinimaxQuota(
  apiKey: string,
  fetchImplementation: typeof globalThis.fetch,
  deadlineMs: number,
  now: () => number,
): Promise<unknown> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const fetchPromise = fetchImplementation(MINIMAX_QUOTA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    void fetchPromise.then(
      (response) => {
        if (timedOut) void cancelResponseBody(response);
      },
      () => undefined,
    );
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new MinimaxFailure("request_timeout", { staleEligible: true }));
      }, deadlineMs);
    });
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    if (!response.ok) {
      await cancelResponseBody(response);
    }
    rejectHttpFailure(response, now);
    const body = await readResponseBody(response, controller.signal);
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(body),
      ) as unknown;
    } catch {
      throw new MinimaxFailure("malformed_json", { staleEligible: true });
    }
  } catch (error) {
    if (error instanceof MinimaxFailure) throw error;
    if (controller.signal.aborted) {
      throw new MinimaxFailure("request_timeout", { staleEligible: true });
    }
    throw new MinimaxFailure(localTransportCode(error), {
      staleEligible: true,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function rejectHttpFailure(response: Response, now: () => number): void {
  const status = response.status;
  if (status === 200) return;
  if (status >= 300 && status <= 399) {
    throw new MinimaxFailure("redirect_rejected");
  }
  if (status === 401 || status === 403) {
    throw new MinimaxFailure("provider_auth_rejected", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (status === 408) {
    throw new MinimaxFailure("provider_timeout", { staleEligible: true });
  }
  if (status === 429) {
    throw new MinimaxFailure("provider_rate_limited", {
      status: "rate_limited",
      staleEligible: true,
      retryAfter: retryAfterToIso(response.headers.get("retry-after"), now()),
    });
  }
  if (status >= 500 && status <= 599) {
    throw new MinimaxFailure("provider_unavailable", { staleEligible: true });
  }
  throw new MinimaxFailure("provider_request_rejected");
}

async function cancelResponseBody(response: Response): Promise<void> {
  const body = response.body;
  if (!body) return;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const cancellation = Promise.resolve()
    .then(() => body.cancel())
    .catch(() => undefined);
  try {
    await Promise.race([
      cancellation,
      new Promise<void>((resolve) => {
        cleanupTimer = setTimeout(resolve, BODY_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (cleanupTimer) clearTimeout(cleanupTimer);
  }
}

async function readResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declaredLength = response.headers?.get("content-length")?.trim();
  const parsedLength = declaredLength ? Number(declaredLength) : undefined;
  const usableLength =
    parsedLength !== undefined &&
    Number.isInteger(parsedLength) &&
    parsedLength >= 0;
  if (
    usableLength &&
    parsedLength !== undefined &&
    parsedLength > RESPONSE_LIMIT_BYTES
  ) {
    await cancelResponseBody(response);
    throw new MinimaxFailure("response_too_large", { staleEligible: true });
  }
  if (!response.body) {
    throw new MinimaxFailure("response_size_unverifiable", {
      staleEligible: true,
    });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await raceWithAbort(reader.read(), signal);
      if (result.done) break;
      const chunk = result.value;
      if (length + chunk.byteLength > RESPONSE_LIMIT_BYTES) {
        throw new MinimaxFailure("response_too_large", {
          staleEligible: true,
        });
      }
      chunks.push(chunk);
      length += chunk.byteLength;
    }
  } finally {
    if (typeof reader.cancel === "function") {
      void reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw new MinimaxFailure("request_timeout", { staleEligible: true });
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(new MinimaxFailure("request_timeout", { staleEligible: true }));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function normalizeMinimaxPayload(
  payload: unknown,
): NormalizedMinimaxPayload {
  const root = objectValue(payload);
  if (!root) throw new MinimaxFailure("schema_invalid");

  const baseResp = objectValue(root.base_resp);
  const statusCode = numericScalar(baseResp?.status_code);
  if (statusCode === AUTH_MISMATCH_STATUS_CODE) {
    throw new MinimaxFailure("provider_auth_rejected", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (statusCode !== undefined && statusCode !== 0) {
    throw new MinimaxFailure("provider_request_rejected");
  }

  const modelRemains = root.model_remains;
  if (!Array.isArray(modelRemains)) {
    throw new MinimaxFailure("schema_invalid");
  }

  const windows: QuotaWindow[] = [];
  for (const rawEntry of modelRemains) {
    const entry = objectValue(rawEntry);
    if (!entry) continue;
    const modelName = stringValue(entry.model_name);
    const isPrimary = modelName === PRIMARY_MODEL_NAME;
    const interval = buildWindow(entry, "interval", modelName, isPrimary);
    if (interval) windows.push(interval);
    const weekly = buildWindow(entry, "weekly", modelName, isPrimary);
    if (weekly) windows.push(weekly);
  }
  return { windows };
}

/**
 * A `*_total_count` of zero means MiniMax has not provisioned this window for
 * the account at all (no active Token Plan seat, or a resource outside the
 * account's current plan tier) rather than a window that is merely unused.
 * The vendor's own `*_remaining_percent` field is documented by the vendor's
 * own CLI maintainers to still read 100 in that state (a plan-less account
 * showing "100% remaining" on a resource it cannot use), which would be a
 * false "fully available" reading if trusted at face value. The window is
 * omitted entirely rather than reported, so absent quota stays absent instead
 * of reading as healthy.
 */
function buildWindow(
  entry: Record<string, unknown>,
  scope: WindowScope,
  modelName: string | undefined,
  isPrimary: boolean,
): QuotaWindow | undefined {
  const totalKey =
    scope === "interval"
      ? "current_interval_total_count"
      : "current_weekly_total_count";
  const percentKey =
    scope === "interval"
      ? "current_interval_remaining_percent"
      : "current_weekly_remaining_percent";
  const startKey = scope === "interval" ? "start_time" : "weekly_start_time";
  const endKey = scope === "interval" ? "end_time" : "weekly_end_time";

  const total = numericScalar(entry[totalKey]);
  if (total === undefined || total <= 0) return undefined;

  const rawPercentRemaining = numericScalar(entry[percentKey]);
  if (rawPercentRemaining === undefined) return undefined;
  const percentRemaining = clampPercent(rawPercentRemaining);

  const start = numericScalar(entry[startKey]);
  const end = numericScalar(entry[endKey]);
  const resetsAt = end !== undefined ? epochMsToIso(end) : undefined;
  const windowSeconds =
    start !== undefined && end !== undefined && end > start
      ? Math.round((end - start) / 1000)
      : undefined;

  const resourceName = modelName ?? "resource";
  return {
    id: isPrimary ? scope : `model:${resourceName}:${scope}`,
    label: isPrimary
      ? scope === "interval"
        ? "interval"
        : "week"
      : `${resourceName} ${scope === "interval" ? "interval" : "week"}`,
    kind: isPrimary ? (scope === "interval" ? "session" : "weekly") : "model",
    percentUsed: clampPercent(100 - percentRemaining),
    percentRemaining,
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowSeconds !== undefined && windowSeconds > 0
      ? { windowSeconds }
      : {}),
  };
}

function epochMsToIso(ms: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  try {
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

function numericScalar(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function localTransportCode(
  error: unknown,
): "tls_failed" | "network_unavailable" {
  const cause = objectValue(objectValue(error)?.cause);
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  return code && /(?:TLS|SSL|CERT|UNABLE_TO_VERIFY)/i.test(code)
    ? "tls_failed"
    : "network_unavailable";
}

class MinimaxFailure extends Error {
  readonly code: string;
  readonly status: ProviderStatus;
  readonly staleEligible: boolean;
  readonly definitiveAuth: boolean;
  readonly retryAfter?: string;

  constructor(code: string, options: MinimaxFailureOptions = {}) {
    super(code);
    this.code = code;
    this.status = options.status ?? "error";
    this.staleEligible = options.staleEligible ?? false;
    this.definitiveAuth = options.definitiveAuth ?? false;
    this.retryAfter = options.retryAfter;
  }
}
