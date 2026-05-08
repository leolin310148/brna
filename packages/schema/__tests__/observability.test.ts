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
    expect(isValidLogRecord({ id: "l", timestamp: Number.NaN, level: "warn", message: "hi" })).toBe(false);
    expect(isValidLogRecord({ id: "l", timestamp: 1, level: "verbose", message: "hi" })).toBe(false);
    expect(isValidLogRecord(null)).toBe(false);

    expect(isValidNetworkRecord({
      id: "n",
      timestamp: 1,
      method: "GET",
      url: "https://example.test",
      state: "completed",
      source: "fetch",
      status: 200,
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
    expect(isValidNetworkRecord({ id: "n", timestamp: 1, method: "GET", url: "x", state: "done", source: "fetch" })).toBe(false);
    expect(isValidNetworkRecord({ id: "n", timestamp: 1, method: "GET", url: "x", state: "started", source: "socket" })).toBe(false);
  });

  test("parses logs request options defensively", () => {
    expect(parseLogsRequestOptions(null)).toEqual({});
    expect(parseLogsRequestOptions({
      since: 10,
      level: " error ",
      limit: 2.9,
      redaction: { rules: [] },
    })).toEqual({
      since: 10,
      level: "error",
      limit: 2,
      redaction: { rules: [] },
    });
    expect(parseLogsRequestOptions({ since: Number.NaN, level: "verbose", limit: 0 })).toEqual({});
    expect(parseLogsRequestOptions({ since: -1 })).toEqual({});
  });

  test("parses network request options defensively", () => {
    expect(parseNetworkRequestOptions(undefined)).toEqual({});
    expect(parseNetworkRequestOptions({
      since: 5,
      method: " post ",
      status: 201,
      statusMin: 200,
      statusMax: 299,
      limit: 3.5,
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
    expect(parseNetworkRequestOptions({ since: -1 })).toEqual({});
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
