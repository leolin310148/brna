import { BrnaSelectorParseError } from "@brna/schema";
import type { SelectorAST } from "@brna/schema";

const ROLE_RE = /^[a-z][a-z0-9_-]*$/i;
const SCOPED_REGION_RE = /^(#|@|[a-z][a-z0-9_-]*:)/i;

export function parseSelector(input: string): SelectorAST {
  if (typeof input !== "string") {
    throw new BrnaSelectorParseError({
      code: "input_type",
      column: 0,
      message: "selector must be a string",
    });
  }
  const raw = input.trim();
  if (raw.length === 0) {
    throw new BrnaSelectorParseError({
      code: "empty",
      column: 0,
      message: "selector is empty",
    });
  }

  if (raw.startsWith("#")) {
    const id = raw.slice(1);
    if (id.length === 0) {
      throw new BrnaSelectorParseError({
        code: "missing_id",
        column: 1,
        message: "id selector requires an identifier after '#'",
      });
    }
    return { kind: "id", id };
  }

  if (raw.startsWith("@")) {
    const testID = raw.slice(1);
    if (testID.length === 0) {
      throw new BrnaSelectorParseError({
        code: "missing_testid",
        column: 1,
        message: "testID selector requires a value after '@'",
      });
    }
    return { kind: "testid", testID };
  }

  if (raw.includes("...")) {
    const parts = raw.split("...").map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length < 2) {
      throw new BrnaSelectorParseError({
        code: "text_fragment",
        column: raw.indexOf("..."),
        message: "text fragment selector needs at least two non-empty parts",
      });
    }
    return { kind: "text", parts };
  }

  const colonIndex = raw.indexOf(":");
  if (colonIndex > 0) {
    const role = raw.slice(0, colonIndex);
    if (!ROLE_RE.test(role)) {
      return { kind: "xpath", path: raw };
    }
    const remainder = raw.slice(colonIndex + 1);
    const name = remainder.trim();
    if (name.length === 0) {
      throw new BrnaSelectorParseError({
        code: "missing_name",
        column: colonIndex,
        message: "role selector requires a name after ':'",
      });
    }
    const inMatch = remainder.match(/^(.+)\s+in\s+(.+)$/);
    if (inMatch) {
      const scopedName = inMatch[1]!.trim();
      const regionRaw = inMatch[2]!.trim();
      if (!SCOPED_REGION_RE.test(regionRaw)) {
        return { kind: "role-name", role, name };
      }
      if (scopedName.length === 0) {
        throw new BrnaSelectorParseError({
          code: "missing_name",
          column: colonIndex,
          message: "role selector requires a name before 'in'",
        });
      }
      const inner = parseSelector(regionRaw);
      return { kind: "role-name", role, name: scopedName, in: inner };
    }
    return { kind: "role-name", role, name };
  }

  return { kind: "xpath", path: raw };
}
