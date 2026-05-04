import { afterEach, describe, expect, test } from "bun:test";
import {
  RingBuffer,
  getLogs,
  getNetwork,
  installObservability,
  resetObservabilityForTest,
} from "../src/observability.js";

afterEach(() => {
  resetObservabilityForTest();
});

describe("RingBuffer", () => {
  test("retains the most recent items when capacity exceeded", () => {
    const ring = new RingBuffer<number>({ capacity: 3 });
    for (let i = 0; i < 5; i++) ring.push(i);
    expect(ring.toArray()).toEqual([2, 3, 4]);
  });

  test("clamps capacity to at least 1", () => {
    const ring = new RingBuffer<number>({ capacity: 0 });
    ring.push(1);
    ring.push(2);
    expect(ring.toArray()).toEqual([2]);
  });
});

describe("installObservability — console", () => {
  test("idempotent install does not double-wrap", () => {
    const calls: unknown[][] = [];
    const fakeConsole = {
      log: (...args: unknown[]) => calls.push(args),
      warn: (...args: unknown[]) => calls.push(["warn", ...args]),
      info: (...args: unknown[]) => calls.push(args),
      error: (...args: unknown[]) => calls.push(args),
      debug: (...args: unknown[]) => calls.push(args),
    } as unknown as Console;
    const g = { console: fakeConsole } as Record<string, unknown> & { console: Console };
    installObservability({ globalObject: g });
    installObservability({ globalObject: g });
    fakeConsole.warn("first");
    fakeConsole.warn("second");
    // original still runs
    expect(calls.length).toBe(2);
    const logs = getLogs();
    expect(logs.length).toBe(2);
    expect(logs[0]!.level).toBe("warn");
    expect(logs[0]!.message).toBe("first");
  });

  test("log buffer respects capacity", () => {
    const fakeConsole = {
      log: () => {},
      warn: () => {},
      info: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as Console;
    const g = { console: fakeConsole } as Record<string, unknown> & { console: Console };
    installObservability({ globalObject: g, logCapacity: 3 });
    for (let i = 0; i < 5; i++) fakeConsole.log(`msg-${i}`);
    const logs = getLogs();
    expect(logs.length).toBe(3);
    expect(logs.map((r) => r.message)).toEqual(["msg-2", "msg-3", "msg-4"]);
  });

  test("level filter excludes lower-priority records", () => {
    const fakeConsole = {
      log: () => {},
      warn: () => {},
      info: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as Console;
    const g = { console: fakeConsole } as Record<string, unknown> & { console: Console };
    installObservability({ globalObject: g });
    fakeConsole.log("a");
    fakeConsole.warn("b");
    fakeConsole.error("c");
    const warnAndAbove = getLogs({ level: "warn" });
    expect(warnAndAbove.map((r) => r.level)).toEqual(["warn", "error"]);
  });

  test("since filter excludes older records", () => {
    const fakeConsole = {
      log: () => {},
      warn: () => {},
      info: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as Console;
    const g = { console: fakeConsole } as Record<string, unknown> & { console: Console };
    installObservability({ globalObject: g });
    fakeConsole.log("a");
    const cutoff = Date.now() + 1;
    // small wait to ensure later timestamps
    const wait = Date.now();
    while (Date.now() === wait) {
      // spin briefly
    }
    fakeConsole.log("b");
    const recent = getLogs({ since: cutoff });
    expect(recent.length).toBe(1);
    expect(recent[0]!.message).toBe("b");
  });

  test("preserves original console behaviour even if it throws", () => {
    let calls = 0;
    const fakeConsole = {
      warn: () => {
        calls += 1;
        throw new Error("boom");
      },
      log: () => {},
      info: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as Console;
    const g = { console: fakeConsole } as Record<string, unknown> & { console: Console };
    installObservability({ globalObject: g });
    expect(() => fakeConsole.warn("x")).not.toThrow();
    expect(calls).toBe(1);
    expect(getLogs().length).toBe(1);
  });

  test("non-serialisable args do not throw and message captured", () => {
    const fakeConsole = {
      log: () => {},
      warn: () => {},
      info: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as Console;
    const g = { console: fakeConsole } as Record<string, unknown> & { console: Console };
    installObservability({ globalObject: g });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    fakeConsole.log("hi", circular);
    const logs = getLogs();
    expect(logs.length).toBe(1);
    expect(logs[0]!.message).toContain("hi");
  });
});

describe("installObservability — fetch", () => {
  test("records fetch with status, headers, and timing", async () => {
    const headers = new Map<string, string>([["Content-Type", "application/json"]]);
    const fetchHeaders = {
      forEach: (cb: (v: string, k: string) => void) => {
        for (const [k, v] of headers.entries()) cb(v, k);
      },
    };
    const original = (input: string, init?: { method?: string }) =>
      Promise.resolve({
        status: 201,
        statusText: "Created",
        headers: fetchHeaders,
        clone: () => ({ text: () => Promise.resolve('{"ok":true}') }),
        url: input,
        method: init?.method ?? "GET",
      } as unknown);
    const g = {
      fetch: original,
      console: {
        log: () => {},
        warn: () => {},
        info: () => {},
        error: () => {},
        debug: () => {},
      } as unknown as Console,
    } as Record<string, unknown> & { console: Console };
    installObservability({ globalObject: g });
    await (g.fetch as typeof fetch)("https://api.test/x", { method: "POST" });
    // allow body capture microtask
    await new Promise((r) => setImmediate(r));
    const records = getNetwork();
    expect(records.length).toBe(1);
    expect(records[0]!.method).toBe("POST");
    expect(records[0]!.url).toBe("https://api.test/x");
    expect(records[0]!.state).toBe("completed");
    expect(records[0]!.status).toBe(201);
    expect(records[0]!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("network buffer respects capacity", async () => {
    const original = () =>
      Promise.resolve({
        status: 200,
        statusText: "OK",
        headers: { forEach: () => {} },
        clone: () => ({ text: () => Promise.resolve("") }),
      } as unknown);
    const g = { fetch: original } as Record<string, unknown>;
    installObservability({ globalObject: g, networkCapacity: 2 });
    await (g.fetch as typeof fetch)("https://api.test/a");
    await (g.fetch as typeof fetch)("https://api.test/b");
    await (g.fetch as typeof fetch)("https://api.test/c");
    const records = getNetwork();
    expect(records.length).toBe(2);
    expect(records.map((r) => r.url)).toEqual(["https://api.test/b", "https://api.test/c"]);
  });

  test("rejected fetch is recorded as errored", async () => {
    const original = () => Promise.reject(new Error("network down"));
    const g = { fetch: original } as Record<string, unknown>;
    installObservability({ globalObject: g });
    await expect((g.fetch as typeof fetch)("https://api.test/x")).rejects.toThrow("network down");
    const records = getNetwork();
    expect(records.length).toBe(1);
    expect(records[0]!.state).toBe("errored");
    expect(records[0]!.error_message).toBe("network down");
  });

  test("method filter selects matching records", async () => {
    const original = (_input: string, init?: { method?: string }) =>
      Promise.resolve({
        status: 200,
        headers: { forEach: () => {} },
        clone: () => ({ text: () => Promise.resolve("") }),
        method: init?.method ?? "GET",
      } as unknown);
    const g = { fetch: original } as Record<string, unknown>;
    installObservability({ globalObject: g });
    await (g.fetch as typeof fetch)("https://api.test/a");
    await (g.fetch as typeof fetch)("https://api.test/b", { method: "POST" });
    const posts = getNetwork({ method: "POST" });
    expect(posts.length).toBe(1);
    expect(posts[0]!.url).toBe("https://api.test/b");
  });
});
