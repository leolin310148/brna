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

  const colonIndex = raw.indexOf(":");
  if (colonIndex > 0) {
    const role = raw.slice(0, colonIndex);
    if (!ROLE_RE.test(role)) {
      return { kind: "xpath", path: raw };
    }
    const remainder = raw.slice(colonIndex + 1);
    const quoted = parseQuotedRoleName(role, remainder, colonIndex);
    if (quoted) return quoted;

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

  return { kind: "xpath", path: raw };
}

function parseQuotedRoleName(role: string, remainder: string, colonIndex: number): SelectorAST | null {
  const leading = remainder.match(/^\s*/)?.[0].length ?? 0;
  if (remainder[leading] !== "\"") return null;

  let escaped = false;
  let end = -1;
  for (let i = leading + 1; i < remainder.length; i++) {
    const char = remainder[i]!;
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "\"") {
      end = i;
      break;
    }
  }

  if (end === -1) {
    throw new BrnaSelectorParseError({
      code: "unterminated_quote",
      column: colonIndex + 1 + leading,
      message: "quoted role selector name is missing a closing quote",
    });
  }

  let name: string;
  try {
    const parsed = JSON.parse(remainder.slice(leading, end + 1)) as unknown;
    if (typeof parsed !== "string") throw new Error("not_string");
    name = parsed;
  } catch {
    throw new BrnaSelectorParseError({
      code: "quoted_name",
      column: colonIndex + 1 + leading,
      message: "quoted role selector name contains an invalid escape sequence",
    });
  }

  if (name.length === 0) {
    throw new BrnaSelectorParseError({
      code: "missing_name",
      column: colonIndex,
      message: "role selector requires a name after ':'",
    });
  }

  const rest = remainder.slice(end + 1).trim();
  if (rest.length === 0) return { kind: "role-name", role, name };

  const scopeMatch = rest.match(/^in\s+(.+)$/);
  if (!scopeMatch) {
    throw new BrnaSelectorParseError({
      code: "trailing_selector",
      column: colonIndex + 1 + end + 1,
      message: "quoted role selector name may only be followed by 'in <selector>'",
    });
  }
  const regionRaw = scopeMatch[1]!.trim();
  if (!SCOPED_REGION_RE.test(regionRaw)) {
    throw new BrnaSelectorParseError({
      code: "scope",
      column: colonIndex + 1 + end + 1,
      message: "scoped role selector requires a #id, @testID, or role:name region selector",
    });
  }
  const inner = parseSelector(regionRaw);
  return { kind: "role-name", role, name, in: inner };
}
