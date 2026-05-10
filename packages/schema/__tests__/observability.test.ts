import { describe, expect, test } from "bun:test";
import {
  compareLogLevels,
  isLogLevel,
  isValidLogRecord,
  isValidNetworkRecord,
  LOG_LEVELS,
  logLevelRank,
  parseLogsRequestOptions,
  parseNetworkRequestOptions,
} from "../src/observability.js";

describe("observability schema helpers", () => {
  test("ranks and validates log levels", () => {
    expect(LOG_LEVELS).toEqual(["debug", "log", "info", "warn", "error"]);
    expect(logLevelRank("debug")).toBeLessThan(logLevelRank("error"));
    expect(compareLogLevels("warn", "info")).toBeGreaterThan(0);
    expect(isLogLevel("info")).toBe(true);
    expect(isLogLevel("verbose")).toBe(false);
  });

  test("validates log and network record shapes", () => {
    expect(isValidLogRecord({ id: "l", timestamp: 1, level: "warn", message: "hi" })).toBe(true);
    expect(isValidLogRecord({
      id: "l",
      timestamp: 1,
      level: "error",
      message: "boom",
      args: [{ ok: true }],
      stack: "Error: boom",
      source: "error",
    })).toBe(true);
    expect(isValidLogRecord({ id: "l", timestamp: Number.NaN, level: "warn", message: "hi" })).toBe(false);
    expect(isValidLogRecord({ id: "l", timestamp: 1, level: "verbose", message: "hi" })).toBe(false);
    expect(isValidLogRecord({ id: "l", timestamp: 1, level: "warn", message: "hi", args: "oops" })).toBe(false);
    expect(isValidLogRecord({ id: "l", timestamp: 1, level: "warn", message: "hi", stack: 1 })).toBe(false);
    expect(isValidLogRecord({ id: "l", timestamp: 1, level: "warn", message: "hi", source: "native" })).toBe(false);
    expect(isValidLogRecord(null)).toBe(false);

    expect(isValidNetworkRecord({
      id: "n",
      timestamp: 1,
      method: "GET",
      url: "https://example.test",
      state: "completed",
      source: "fetch",
      request_headers: [{ name: "Accept", value: "application/json" }],
      request_body_preview: "{}",
      status: 200,
      status_text: "OK",
      response_headers: [{ name: "Content-Type", value: "application/json" }],
      response_body_preview: "{}",
      duration_ms: 12,
    })).toBe(true);
    expect(isValidNetworkRecord({
      id: "n",
      timestamp: 1,
      method: "GET",
      url: "x",
      state: "completed",
      source: "fetch",
      status: Number.POSITIVE_INFINITY,
    })).toBe(false);
    expect(isValidNetworkRecord({
      id: "n",
      timestamp: 1,
      method: "GET",
      url: "x",
      state: "completed",
      source: "fetch",
      status: 99,
    })).toBe(false);
    expect(isValidNetworkRecord({
      id: "n",
      timestamp: 1,
      method: "GET",
      url: "x",
      state: "completed",
      source: "fetch",
      status: 200.5,
    })).toBe(false);
    expect(isValidNetworkRecord({
      id: "n",
      timestamp: 1,
      method: "GET /admin",
      url: "x",
      state: "completed",
      source: "fetch",
    })).toBe(false);
    expect(isValidNetworkRecord({
      id: "n",
      timestamp: 1,
      method: "GET",
      url: "x",
      state: "completed",
      source: "fetch",
      duration_ms: -1,
    })).toBe(false);
    expect(isValidNetworkRecord({
      id: "n",
      timestamp: 1,
      method: "GET",
      url: "x",
      state: "completed",
      source: "fetch",
      request_headers: [{ name: "Accept", value: 1 }],
    })).toBe(false);
    expect(isValidNetworkRecord({
      id: "n",
      timestamp: 1,
      method: "GET",
      url: "x",
      state: "completed",
      source: "fetch",
      response_headers: "Content-Type: application/json",
    })).toBe(false);
    expect(isValidNetworkRecord({
      id: "n",
      timestamp: 1,
      method: "GET",
      url: "x",
      state: "completed",
      source: "fetch",
      response_body_preview: { ok: true },
    })).toBe(false);
    expect(isValidNetworkRecord({
      id: "n",
      timestamp: 1,
      method: "GET",
      url: "x",
      state: "errored",
      source: "fetch",
      error_message: 500,
    })).toBe(false);
    expect(isValidNetworkRecord({ id: "n", timestamp: 1, method: "GET", url: "x", state: "done", source: "fetch" })).toBe(false);
    expect(isValidNetworkRecord({ id: "n", timestamp: 1, method: "GET", url: "x", state: "started", source: "socket" })).toBe(false);
  });

  test("parses logs request options defensively", () => {
    expect(parseLogsRequestOptions(null)).toEqual({});
    expect(parseLogsRequestOptions({
      since: 10,
      level: " ERROR ",
      limit: 2,
      redaction: { rules: [] },
    })).toEqual({
      since: 10,
      level: "error",
      limit: 2,
      redaction: { rules: [] },
    });
    expect(parseLogsRequestOptions({ since: Number.NaN, level: "verbose", limit: 0 })).toEqual({});
    expect(parseLogsRequestOptions({ limit: 2.9 })).toEqual({});
    expect(parseLogsRequestOptions({ limit: Number.MAX_SAFE_INTEGER + 1 })).toEqual({});
    expect(parseLogsRequestOptions({ since: -1 })).toEqual({});
  });

  test("parses logs redaction options defensively", () => {
    expect(parseLogsRequestOptions({
      redaction: {
        rules: [{ match: { source: "secret", flags: "gi" }, replace: "<secret>" }],
        redactSensitiveDefaults: false,
      },
    })).toEqual({
      redaction: {
        rules: [{ match: { source: "secret", flags: "gi" }, replace: "<secret>" }],
        redactSensitiveDefaults: false,
      },
    });
    expect(parseLogsRequestOptions({ redaction: { rules: {} } })).toEqual({});
    expect(parseLogsRequestOptions({ redaction: { rules: [{ match: {}, replace: "x" }] } })).toEqual({});
    expect(parseLogsRequestOptions({ redaction: { redactSensitiveDefaults: "false" } })).toEqual({});
  });

  test("parses network request options defensively", () => {
    expect(parseNetworkRequestOptions(undefined)).toEqual({});
    expect(parseNetworkRequestOptions({
      since: 5,
      method: " post ",
      status: 201,
      statusMin: 200,
      statusMax: 299,
      limit: 3,
      redaction: { redactSensitiveDefaults: false },
    })).toEqual({
      since: 5,
      method: "POST",
      status: 201,
      statusMin: 200,
      statusMax: 299,
      limit: 3,
      redaction: { redactSensitiveDefaults: false },
    });
    expect(parseNetworkRequestOptions({
      since: Infinity,
      method: "",
      status: Number.NaN,
      statusMin: 200.5,
      statusMax: 299.5,
      limit: -1,
    })).toEqual({});
    expect(parseNetworkRequestOptions({ method: "GET /admin" })).toEqual({});
    expect(parseNetworkRequestOptions({ method: "PATCH\r\nX-Test: 1" })).toEqual({});
    expect(parseNetworkRequestOptions({ limit: 3.5 })).toEqual({});
    expect(parseNetworkRequestOptions({ limit: Number.MAX_SAFE_INTEGER + 1 })).toEqual({});
    expect(parseNetworkRequestOptions({ since: -1 })).toEqual({});
  });

  test("parses network redaction options defensively", () => {
    expect(parseNetworkRequestOptions({
      redaction: {
        rules: [{ match: { source: "secret" }, replace: "<secret>" }],
      },
    })).toEqual({
      redaction: {
        rules: [{ match: { source: "secret" }, replace: "<secret>" }],
      },
    });
    expect(parseNetworkRequestOptions({ redaction: [] })).toEqual({});
    expect(parseNetworkRequestOptions({ redaction: { rules: [{ match: "secret", replace: "x" }] } })).toEqual({});
  });

  test("rejects impossible network status filters", () => {
    expect(parseNetworkRequestOptions({
      status: 99,
      statusMin: 600,
      statusMax: 700,
    })).toEqual({});
    expect(parseNetworkRequestOptions({ statusMin: 500, statusMax: 400 })).toEqual({});
  });
});
