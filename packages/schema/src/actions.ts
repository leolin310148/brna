import { BrnaValidationError } from "./errors.js";

// Runtime action kinds. The CLI accepts `click` as a user-facing alias for
// `tap`; that normalisation lives in @brna/cli and never reaches the wire,
// so `click` is intentionally absent here and from the snapshot `ACTIONS`
// enum (which advertises `tap` as the canonical activation action).
export const ACTION_KINDS = ["tap", "long_press", "type", "scroll", "swipe", "key"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const ACTION_KEYS = [
  "tab",
  "enter",
  "escape",
  "arrow_up",
  "arrow_down",
  "arrow_left",
  "arrow_right",
] as const;
export type ActionKey = (typeof ACTION_KEYS)[number];

export const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
export type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];

export const ACTION_ERROR_CODES = [
  "invalid_action",
  "target_stale",
  "target_disabled",
  "action_not_supported",
  "action_failed",
] as const;
export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number];

export interface TapActionRequest {
  kind: "tap";
  selector: string;
  target_id: string;
}

export interface LongPressActionRequest {
  kind: "long_press";
  selector: string;
  target_id: string;
  duration_ms: number;
}

export interface TypeActionRequest {
  kind: "type";
  selector: string;
  target_id: string;
  text: string;
}

export interface ScrollActionRequest {
  kind: "scroll";
  selector: string;
  target_id: string;
  direction: ScrollDirection;
  by?: number;
}

export interface SwipeActionRequest {
  kind: "swipe";
  selector: string;
  target_id: string;
  direction: ScrollDirection;
  by?: number;
}

export interface KeyActionRequest {
  kind: "key";
  key: ActionKey;
}

export type ActionRequest =
  | TapActionRequest
  | LongPressActionRequest
  | TypeActionRequest
  | ScrollActionRequest
  | SwipeActionRequest
  | KeyActionRequest;

export interface ActionRequestFrame {
  type: "action.request";
  id: string;
  action: ActionRequest;
}

export interface ActionResponseFrame {
  type: "action.response";
  id: string;
  elapsed_ms: number;
}

export interface ActionErrorFrame {
  type: "action.error";
  id: string;
  code: string;
  message: string;
}

export type ActionFrame = ActionRequestFrame | ActionResponseFrame | ActionErrorFrame;

const ACTION_KIND_SET = new Set<string>(ACTION_KINDS);
const ACTION_KEY_SET = new Set<string>(ACTION_KEYS);
const SCROLL_DIRECTION_SET = new Set<string>(SCROLL_DIRECTIONS);

function fail(path: string, message: string): never {
  throw new BrnaValidationError({ code: "action_shape", path, message });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(value: unknown, path: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, `${label} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, path: string, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    fail(path, message);
  }
  return value;
}

function targetedFields(obj: Record<string, unknown>): Pick<TapActionRequest, "selector" | "target_id"> {
  return {
    selector: nonEmptyString(obj["selector"], "$.selector", "selector"),
    target_id: nonEmptyString(obj["target_id"], "$.target_id", "target_id"),
  };
}

function scrollLikeFields(obj: Record<string, unknown>): Omit<ScrollActionRequest, "kind"> {
  const direction = obj["direction"];
  if (typeof direction !== "string" || !SCROLL_DIRECTION_SET.has(direction)) {
    fail("$.direction", `direction must be one of ${SCROLL_DIRECTIONS.join("|")}`);
  }
  const out: Omit<ScrollActionRequest, "kind"> = {
    ...targetedFields(obj),
    direction: direction as ScrollDirection,
  };
  if (obj["by"] !== undefined) {
    out.by = positiveInteger(obj["by"], "$.by", "by must be a positive integer when supplied");
  }
  return out;
}

export function validateActionRequest(input: unknown): ActionRequest {
  if (!isPlainObject(input)) fail("$", "action must be an object");
  const obj = input as Record<string, unknown>;
  const kind = obj["kind"];
  if (typeof kind !== "string" || !ACTION_KIND_SET.has(kind)) {
    fail("$.kind", `action.kind must be one of ${ACTION_KINDS.join("|")}`);
  }
  switch (kind as ActionKind) {
    case "tap":
      return {
        kind: "tap",
        ...targetedFields(obj),
      };
    case "long_press": {
      return {
        kind: "long_press",
        ...targetedFields(obj),
        duration_ms: positiveInteger(obj["duration_ms"], "$.duration_ms", "duration_ms must be a positive integer"),
      };
    }
    case "type": {
      const text = obj["text"];
      if (typeof text !== "string") fail("$.text", "text must be a string");
      return {
        kind: "type",
        ...targetedFields(obj),
        text,
      };
    }
    case "scroll":
      return { kind: "scroll", ...scrollLikeFields(obj) };
    case "swipe":
      return { kind: "swipe", ...scrollLikeFields(obj) };
    case "key": {
      const key = obj["key"];
      if (typeof key !== "string" || !ACTION_KEY_SET.has(key)) {
        fail("$.key", `key must be one of ${ACTION_KEYS.join("|")}`);
      }
      return { kind: "key", key: key as ActionKey };
    }
  }
}

export function validateActionRequestFrame(input: unknown): ActionRequestFrame {
  if (!isPlainObject(input)) fail("$", "frame must be an object");
  if (input["type"] !== "action.request") fail("$.type", "frame.type must be 'action.request'");
  const id = input["id"];
  if (typeof id !== "string" || id.length === 0) fail("$.id", "frame.id must be a non-empty string");
  const action = validateActionRequest(input["action"]);
  return { type: "action.request", id, action };
}

export function validateActionResponseFrame(input: unknown): ActionResponseFrame {
  if (!isPlainObject(input)) fail("$", "frame must be an object");
  if (input["type"] !== "action.response") fail("$.type", "frame.type must be 'action.response'");
  const id = input["id"];
  if (typeof id !== "string" || id.length === 0) fail("$.id", "frame.id must be a non-empty string");
  const elapsed = input["elapsed_ms"];
  if (typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed < 0) {
    fail("$.elapsed_ms", "elapsed_ms must be a non-negative number");
  }
  return { type: "action.response", id, elapsed_ms: elapsed };
}

export function validateActionErrorFrame(input: unknown): ActionErrorFrame {
  if (!isPlainObject(input)) fail("$", "frame must be an object");
  if (input["type"] !== "action.error") fail("$.type", "frame.type must be 'action.error'");
  const id = input["id"];
  if (typeof id !== "string" || id.length === 0) fail("$.id", "frame.id must be a non-empty string");
  const code = input["code"];
  if (typeof code !== "string" || code.length === 0) fail("$.code", "code must be a non-empty string");
  const message = input["message"];
  if (typeof message !== "string") fail("$.message", "message must be a string");
  return { type: "action.error", id, code, message };
}

export function isActionErrorCode(code: string): code is ActionErrorCode {
  return (ACTION_ERROR_CODES as readonly string[]).includes(code);
}
