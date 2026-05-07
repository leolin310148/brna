import Ajv, { type ValidateFunction } from "ajv";
import { BrnaValidationError } from "./errors.js";
import { JSON_SCHEMA } from "./schema-json.js";
import { ACTIONS, NODE_KINDS, STATE_FLAGS, SCHEMA_VERSION } from "./types.js";
import type { ModifiedFieldChange, Node, Snapshot, SnapshotDiff } from "./types.js";

const SENTINEL_PATTERN = /^__.+__$/;
const NODE_KIND_SET = new Set<string>(NODE_KINDS);
const STATE_FLAG_SET = new Set<string>(STATE_FLAGS);
const ACTION_SET = new Set<string>(ACTIONS);

let ajvValidator: ValidateFunction | null = null;
function getJsonSchemaValidator(): ValidateFunction {
  if (!ajvValidator) {
    const ajv = new Ajv({ allErrors: false, strict: false });
    ajvValidator = ajv.compile(JSON_SCHEMA);
  }
  return ajvValidator;
}

const ALLOWED_NODE_KEYS = new Set<string>([
  "id",
  "kind",
  "role",
  "name",
  "text",
  "value",
  "accessibility_label",
  "accessibility_hint",
  "range",
  "state",
  "selector",
  "suggested_selectors",
  "actions",
  "bounds",
  "children",
  "image_source",
  "total_count",
  "index",
  "visible_range",
  "url",
  "_dev",
]);

const RANGE_KEYS = new Set<string>(["min", "max", "now", "text"]);
const DIFF_EVENT_TYPES = new Set<string>(["added", "removed", "modified", "moved"]);
const MODIFIED_FIELD_SET = new Set<string>(["name", "text", "value", "state", "kind", "role", "url"]);

export function validateSnapshot(snapshot: Snapshot): void {
  if (!snapshot || typeof snapshot !== "object") {
    throw new BrnaValidationError({
      code: "shape",
      path: "$",
      message: "snapshot must be an object",
    });
  }
  if (snapshot.meta?.schema_version !== SCHEMA_VERSION) {
    throw new BrnaValidationError({
      code: "schema_version",
      path: "$.meta.schema_version",
      message: `expected schema_version ${SCHEMA_VERSION}, got ${String(snapshot.meta?.schema_version)}`,
    });
  }
  if (!snapshot.tree) {
    throw new BrnaValidationError({
      code: "shape",
      path: "$.tree",
      message: "snapshot.tree is required",
    });
  }
  const validator = getJsonSchemaValidator();
  if (!validator(snapshot)) {
    const first = validator.errors?.[0];
    throw new BrnaValidationError({
      code: "json_schema",
      path: first?.instancePath || "$",
      message: first?.message ?? "JSON Schema validation failed",
      detail: validator.errors,
    });
  }
  walkNode(snapshot.tree, "$.tree");
  if (snapshot.overlays) {
    snapshot.overlays.forEach((overlay, i) => walkNode(overlay, `$.overlays[${i}]`));
  }
}

export function validateSnapshotDiff(value: unknown): asserts value is SnapshotDiff {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrnaValidationError({
      code: "shape",
      path: "$",
      message: "diff must be an object",
    });
  }
  const diff = value as Partial<SnapshotDiff>;
  if (!Array.isArray(diff.events)) {
    throw new BrnaValidationError({
      code: "shape",
      path: "$.events",
      message: "diff.events must be an array",
    });
  }
  diff.events.forEach((event, index) => validateDiffEvent(event, `$.events[${index}]`));
}

function validateDiffEvent(event: unknown, path: string): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new BrnaValidationError({
      code: "shape",
      path,
      message: "diff event must be an object",
    });
  }
  const ev = event as Record<string, unknown>;
  if (typeof ev.type !== "string" || !DIFF_EVENT_TYPES.has(ev.type)) {
    throw new BrnaValidationError({
      code: "shape",
      path: `${path}.type`,
      message: `unknown diff event type '${String(ev.type)}'`,
    });
  }
  if (typeof ev.id !== "string" || ev.id.length === 0) {
    throw new BrnaValidationError({
      code: "shape",
      path: `${path}.id`,
      message: "diff event id must be a non-empty string",
    });
  }
  if (ev.parent_id !== undefined && typeof ev.parent_id !== "string") {
    throw new BrnaValidationError({
      code: "shape",
      path: `${path}.parent_id`,
      message: "diff event parent_id must be a string",
    });
  }

  switch (ev.type) {
    case "added":
    case "removed":
      walkNode(ev.node as Node, `${path}.node`);
      return;
    case "modified":
      walkNode(ev.node as Node, `${path}.node`);
      validateModifiedChanges(ev.changes, `${path}.changes`);
      return;
    case "moved":
      walkNode(ev.node as Node, `${path}.node`);
      if (typeof ev.from_parent !== "string") {
        throw new BrnaValidationError({
          code: "shape",
          path: `${path}.from_parent`,
          message: "moved diff event from_parent must be a string",
        });
      }
      if (typeof ev.to_parent !== "string") {
        throw new BrnaValidationError({
          code: "shape",
          path: `${path}.to_parent`,
          message: "moved diff event to_parent must be a string",
        });
      }
      return;
  }
}

function validateModifiedChanges(value: unknown, path: string): asserts value is ModifiedFieldChange[] {
  if (!Array.isArray(value)) {
    throw new BrnaValidationError({
      code: "shape",
      path,
      message: "modified diff event changes must be an array",
    });
  }
  value.forEach((change, index) => {
    const changePath = `${path}[${index}]`;
    if (!change || typeof change !== "object" || Array.isArray(change)) {
      throw new BrnaValidationError({
        code: "shape",
        path: changePath,
        message: "modified field change must be an object",
      });
    }
    const c = change as Record<string, unknown>;
    if (typeof c.field !== "string" || !MODIFIED_FIELD_SET.has(c.field)) {
      throw new BrnaValidationError({
        code: "shape",
        path: `${changePath}.field`,
        message: `unknown modified field '${String(c.field)}'`,
      });
    }
  });
}

function walkNode(node: Node, path: string): void {
  if (!node || typeof node !== "object") {
    throw new BrnaValidationError({
      code: "shape",
      path,
      message: "node must be an object",
    });
  }

  for (const key of Object.keys(node)) {
    if (!ALLOWED_NODE_KEYS.has(key)) {
      throw new BrnaValidationError({
        code: "unknown_property",
        path: `${path}.${key}`,
        message: `unknown root property '${key}' on node`,
      });
    }
  }

  if (typeof node.id !== "string" || node.id.length === 0) {
    throw new BrnaValidationError({
      code: "shape",
      path: `${path}.id`,
      message: "node.id must be a non-empty string",
    });
  }
  if (!NODE_KIND_SET.has(node.kind as string)) {
    throw new BrnaValidationError({
      code: "kind",
      path: `${path}.kind`,
      message: `unknown kind '${String(node.kind)}'`,
    });
  }
  if (node.state !== undefined) {
    if (!Array.isArray(node.state)) {
      throw new BrnaValidationError({
        code: "shape",
        path: `${path}.state`,
        message: "node.state must be an array",
      });
    }
    for (const flag of node.state) {
      if (!STATE_FLAG_SET.has(flag as string)) {
        throw new BrnaValidationError({
          code: "state",
          path: `${path}.state`,
          message: `unknown state flag '${String(flag)}'`,
        });
      }
    }
  }
  if (node.actions !== undefined) {
    if (!Array.isArray(node.actions)) {
      throw new BrnaValidationError({
        code: "shape",
        path: `${path}.actions`,
        message: "node.actions must be an array",
      });
    }
    node.actions.forEach((action, i) => {
      if (typeof action !== "string" || !ACTION_SET.has(action)) {
        throw new BrnaValidationError({
          code: "shape",
          path: `${path}.actions[${i}]`,
          message: `unknown action '${String(action)}'`,
        });
      }
    });
  }
  if (node.bounds !== undefined) {
    validateBounds(node.bounds, `${path}.bounds`);
  }
  if (node.range !== undefined) {
    validateRange(node.range, `${path}.range`);
  }
  if (node.visible_range !== undefined) {
    validateVisibleRange(node.visible_range, `${path}.visible_range`);
  }
  if (node.suggested_selectors !== undefined) {
    if (!Array.isArray(node.suggested_selectors)) {
      throw new BrnaValidationError({
        code: "shape",
        path: `${path}.suggested_selectors`,
        message: "suggested_selectors must be an array of strings",
      });
    }
    node.suggested_selectors.forEach((entry, i) => {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new BrnaValidationError({
          code: "shape",
          path: `${path}.suggested_selectors[${i}]`,
          message: "suggested_selectors entries must be non-empty strings",
        });
      }
    });
  }
  if (node.name && SENTINEL_PATTERN.test(node.name)) {
    if (node._dev?.inferred_label !== true) {
      throw new BrnaValidationError({
        code: "sentinel",
        path: `${path}.name`,
        message: `name '${node.name}' matches reserved __…__ sentinel without _dev.inferred_label = true`,
      });
    }
  }
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) {
      throw new BrnaValidationError({
        code: "shape",
        path: `${path}.children`,
        message: "node.children must be an array",
      });
    }
    node.children.forEach((child, i) => walkNode(child, `${path}.children[${i}]`));
  }
}

function validateBounds(bounds: unknown, path: string): void {
  if (!bounds || typeof bounds !== "object" || Array.isArray(bounds)) {
    throw new BrnaValidationError({
      code: "shape",
      path,
      message: "bounds must be an object",
    });
  }
  const obj = bounds as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "x" && key !== "y" && key !== "w" && key !== "h") {
      throw new BrnaValidationError({
        code: "unknown_property",
        path: `${path}.${key}`,
        message: `unknown property '${key}' on bounds`,
      });
    }
  }
  for (const key of ["x", "y", "w", "h"] as const) {
    const value = obj[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new BrnaValidationError({
        code: "shape",
        path: `${path}.${key}`,
        message: `bounds.${key} must be a finite number`,
      });
    }
  }
}

function validateRange(range: unknown, path: string): void {
  if (!range || typeof range !== "object" || Array.isArray(range)) {
    throw new BrnaValidationError({
      code: "shape",
      path,
      message: "range must be an object",
    });
  }
  const obj = range as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!RANGE_KEYS.has(key)) {
      throw new BrnaValidationError({
        code: "unknown_property",
        path: `${path}.${key}`,
        message: `unknown property '${key}' on range`,
      });
    }
  }
  let any = false;
  for (const k of ["min", "max", "now"] as const) {
    const v = obj[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new BrnaValidationError({
        code: "shape",
        path: `${path}.${k}`,
        message: `range.${k} must be a finite number`,
      });
    }
    any = true;
  }
  if (obj.text !== undefined) {
    if (typeof obj.text !== "string") {
      throw new BrnaValidationError({
        code: "shape",
        path: `${path}.text`,
        message: "range.text must be a string",
      });
    }
    any = true;
  }
  if (!any) {
    throw new BrnaValidationError({
      code: "shape",
      path,
      message: "range must contain at least one of min/max/now/text",
    });
  }
}

function validateVisibleRange(range: unknown, path: string): void {
  if (!range || typeof range !== "object" || Array.isArray(range)) {
    throw new BrnaValidationError({
      code: "shape",
      path,
      message: "visible_range must be an object",
    });
  }
  const obj = range as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "start" && key !== "end") {
      throw new BrnaValidationError({
        code: "unknown_property",
        path: `${path}.${key}`,
        message: `unknown property '${key}' on visible_range`,
      });
    }
  }
  for (const k of ["start", "end"] as const) {
    const v = obj[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new BrnaValidationError({
        code: "shape",
        path: `${path}.${k}`,
        message: `visible_range.${k} must be a finite number`,
      });
    }
  }
  if ((obj.start as number) > (obj.end as number)) {
    throw new BrnaValidationError({
      code: "shape",
      path,
      message: "visible_range.start must be less than or equal to visible_range.end",
    });
  }
}
