import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BrnaValidationError } from "@brna/schema";
import { fromJSON, fromYAML, toJSON, toMarkdown, toYAML } from "../src/serialise/index.js";
import { fromDiffJSON, fromDiffYAML, toDiffJSON, toDiffMarkdown, toDiffYAML } from "../src/diff/index.js";
import { FIXTURES } from "../__fixtures__/brna1/index.js";
import { DIFF_FIXTURES } from "../__fixtures__/brna1/diffs/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__", "brna1");

describe("three-format parity", () => {
  for (const { name, snapshot } of FIXTURES) {
    test(`${name}: JSON golden matches`, () => {
      const expected = readFileSync(join(fixturesDir, `${name}.json`), "utf8");
      expect(toJSON(snapshot)).toBe(expected);
    });
    test(`${name}: YAML golden matches`, () => {
      const expected = readFileSync(join(fixturesDir, `${name}.yaml`), "utf8");
      expect(toYAML(snapshot)).toBe(expected);
    });
    test(`${name}: Markdown golden matches`, () => {
      const expected = readFileSync(join(fixturesDir, `${name}.md`), "utf8");
      expect(toMarkdown(snapshot)).toBe(expected);
    });
  }
});

describe("round-trip", () => {
  for (const { name, snapshot } of FIXTURES) {
    test(`${name}: JSON round-trip is byte-identical`, () => {
      const first = toJSON(snapshot);
      const reparsed = fromJSON(first);
      expect(toJSON(reparsed)).toBe(first);
    });
    test(`${name}: YAML round-trip is byte-identical`, () => {
      const first = toYAML(snapshot);
      const reparsed = fromYAML(first);
      expect(toYAML(reparsed)).toBe(first);
    });
  }

  test("snapshot deserializers reject invalid snapshot shapes", () => {
    const invalid = JSON.stringify({
      meta: { schema_version: "wrong" },
      screen: {},
      tree: { id: "root", kind: "screen" },
    });

    expect(() => fromJSON(invalid)).toThrow(BrnaValidationError);
    expect(() => fromYAML(invalid)).toThrow(BrnaValidationError);
  });
});

describe("diff three-format parity", () => {
  for (const { name, diff } of DIFF_FIXTURES) {
    test(`${name}: JSON golden matches`, () => {
      const expected = readFileSync(join(fixturesDir, "diffs", `${name}.json`), "utf8");
      expect(toDiffJSON(diff)).toBe(expected);
    });
    test(`${name}: YAML golden matches`, () => {
      const expected = readFileSync(join(fixturesDir, "diffs", `${name}.yaml`), "utf8");
      expect(toDiffYAML(diff)).toBe(expected);
    });
    test(`${name}: Markdown golden matches`, () => {
      const expected = readFileSync(join(fixturesDir, "diffs", `${name}.md`), "utf8");
      expect(toDiffMarkdown(diff)).toBe(expected);
    });
  }
});

describe("diff round-trip", () => {
  for (const { name, diff } of DIFF_FIXTURES) {
    test(`${name}: JSON round-trip is byte-identical`, () => {
      const first = toDiffJSON(diff);
      const reparsed = fromDiffJSON(first);
      expect(toDiffJSON(reparsed)).toBe(first);
    });
    test(`${name}: YAML round-trip is byte-identical`, () => {
      const first = toDiffYAML(diff);
      const reparsed = fromDiffYAML(first);
      expect(toDiffYAML(reparsed)).toBe(first);
    });
  }
});
