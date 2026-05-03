import { describe, expect, test } from "bun:test";
import type { Node } from "@brna/schema";
import { computeUsabilityWarnings } from "../src/usability.js";

function button(id: string, bounds: { x: number; y: number; w: number; h: number }): Node {
  return { id, kind: "button", bounds };
}

describe("undersized_target heuristic", () => {
  test("emits warning for button narrower than 44pt", () => {
    const tree = [button("submit", { x: 0, y: 0, w: 30, h: 44 })];
    const warnings = computeUsabilityWarnings(tree, new Set());
    expect(warnings).toEqual([
      { code: "undersized_target", node: "submit", w: 30, h: 44 },
    ]);
  });

  test("emits warning for button shorter than 44pt", () => {
    const tree = [button("submit", { x: 0, y: 0, w: 80, h: 20 })];
    const warnings = computeUsabilityWarnings(tree, new Set());
    expect(warnings).toEqual([
      { code: "undersized_target", node: "submit", w: 80, h: 20 },
    ]);
  });

  test("does not emit warning for exactly 44x44", () => {
    const tree = [button("submit", { x: 0, y: 0, w: 44, h: 44 })];
    expect(computeUsabilityWarnings(tree, new Set())).toEqual([]);
  });

  test("ignores non-interactive nodes regardless of bounds", () => {
    const tree: Node[] = [
      { id: "header", kind: "heading", bounds: { x: 0, y: 0, w: 10, h: 10 } },
    ];
    expect(computeUsabilityWarnings(tree, new Set())).toEqual([]);
  });

  test("does not double-report nodes whose bounds are unavailable", () => {
    const tree = [button("submit", { x: 0, y: 0, w: 0, h: 0 })];
    const warnings = computeUsabilityWarnings(tree, new Set(["submit"]));
    expect(warnings).toEqual([]);
  });

  test("walks into nested children", () => {
    const tree: Node[] = [
      {
        id: "row",
        kind: "group",
        bounds: { x: 0, y: 0, w: 200, h: 50 },
        children: [
          button("inner", { x: 0, y: 0, w: 30, h: 30 }),
        ],
      },
    ];
    const warnings = computeUsabilityWarnings(tree, new Set());
    expect(warnings).toEqual([
      { code: "undersized_target", node: "inner", w: 30, h: 30 },
    ]);
  });

  test("covers all interactive kinds", () => {
    const tree: Node[] = [
      { id: "lnk", kind: "link", bounds: { x: 0, y: 0, w: 30, h: 30 } },
      { id: "inp", kind: "input", bounds: { x: 0, y: 100, w: 30, h: 30 } },
      { id: "tog", kind: "toggle", bounds: { x: 0, y: 200, w: 30, h: 30 } },
      { id: "sld", kind: "slider", bounds: { x: 0, y: 300, w: 30, h: 30 } },
    ];
    const warnings = computeUsabilityWarnings(tree, new Set());
    expect(warnings.map((w) => w.node)).toEqual(["lnk", "inp", "tog", "sld"]);
    expect(warnings.every((w) => w.code === "undersized_target")).toBe(true);
  });
});

describe("overlapping_nodes heuristic", () => {
  test("emits one warning for two intersecting buttons in document order", () => {
    const tree = [
      button("a", { x: 0, y: 0, w: 60, h: 60 }),
      button("b", { x: 30, y: 30, w: 60, h: 60 }),
    ];
    const warnings = computeUsabilityWarnings(tree, new Set());
    const overlap = warnings.filter((w) => w.code === "overlapping_nodes");
    expect(overlap).toEqual([{ code: "overlapping_nodes", nodes: ["a", "b"] }]);
  });

  test("does not emit for disjoint buttons", () => {
    const tree = [
      button("a", { x: 0, y: 0, w: 50, h: 50 }),
      button("b", { x: 100, y: 100, w: 50, h: 50 }),
    ];
    const warnings = computeUsabilityWarnings(tree, new Set());
    expect(warnings.filter((w) => w.code === "overlapping_nodes")).toEqual([]);
  });

  test("edge-touching boxes do not count as overlap", () => {
    const tree = [
      button("a", { x: 0, y: 0, w: 50, h: 50 }),
      button("b", { x: 50, y: 0, w: 50, h: 50 }),
    ];
    const warnings = computeUsabilityWarnings(tree, new Set());
    expect(warnings.filter((w) => w.code === "overlapping_nodes")).toEqual([]);
  });

  test("ignores zero-area nodes", () => {
    const tree = [
      button("a", { x: 0, y: 0, w: 50, h: 50 }),
      button("b", { x: 10, y: 10, w: 0, h: 0 }),
    ];
    const warnings = computeUsabilityWarnings(tree, new Set());
    expect(warnings.filter((w) => w.code === "overlapping_nodes")).toEqual([]);
  });

  test("ignores nodes whose bounds are unavailable", () => {
    const tree = [
      button("a", { x: 0, y: 0, w: 60, h: 60 }),
      button("b", { x: 30, y: 30, w: 60, h: 60 }),
    ];
    const warnings = computeUsabilityWarnings(tree, new Set(["b"]));
    expect(warnings.filter((w) => w.code === "overlapping_nodes")).toEqual([]);
  });

  test("emits one warning per overlapping pair, not per node", () => {
    const tree = [
      button("a", { x: 0, y: 0, w: 100, h: 100 }),
      button("b", { x: 10, y: 10, w: 100, h: 100 }),
      button("c", { x: 20, y: 20, w: 100, h: 100 }),
    ];
    const warnings = computeUsabilityWarnings(tree, new Set());
    const overlap = warnings.filter((w) => w.code === "overlapping_nodes");
    expect(overlap).toEqual([
      { code: "overlapping_nodes", nodes: ["a", "b"] },
      { code: "overlapping_nodes", nodes: ["a", "c"] },
      { code: "overlapping_nodes", nodes: ["b", "c"] },
    ]);
  });
});
