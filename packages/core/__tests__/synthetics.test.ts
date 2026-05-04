import { describe, expect, test } from "bun:test";
import type { Node } from "@brna/schema";
import { collapseLoadingSkeleton, synthesiseListPlaceholder } from "../src/serialise/synthetics.js";

describe("synthetic serialisation helpers", () => {
  test("synthesises list placeholders from omitted items", () => {
    expect(synthesiseListPlaceholder({ id: "g", kind: "group" })).toBeNull();
    expect(synthesiseListPlaceholder({ id: "l", kind: "list", total_count: 2, children: [{ id: "a", kind: "text" }, { id: "b", kind: "text" }] })).toBeNull();
    expect(synthesiseListPlaceholder({ id: "l", kind: "list", total_count: 5, children: [{ id: "a", kind: "text" }] }))
      .toEqual({ position: "below", count: 4 });
    expect(synthesiseListPlaceholder({
      id: "l",
      kind: "list",
      total_count: 5,
      visible_range: { start: 2, end: 3 },
      children: [{ id: "c", kind: "text" }],
    })).toEqual({ position: "above", count: 4 });
  });

  test("collapses consecutive anonymous loading nodes", () => {
    const parent: Node = {
      id: "root",
      kind: "group",
      children: [
        { id: "s1", kind: "group", state: ["loading"] },
        { id: "s2", kind: "group", state: ["loading"] },
        {
          id: "row",
          kind: "group",
          children: [
            { id: "keep", kind: "text", name: "Loading" },
            { id: "s3", kind: "group", state: ["loading"] },
          ],
        },
      ],
    };

    expect(collapseLoadingSkeleton({ id: "empty", kind: "group" })).toEqual({ id: "empty", kind: "group" });
    expect(collapseLoadingSkeleton(parent)).toEqual({
      id: "root",
      kind: "group",
      children: [
        { id: "auto:loading_skeleton", kind: "group", name: "loading_skeleton", state: ["loading"] },
        {
          id: "row",
          kind: "group",
          children: [
            { id: "keep", kind: "text", name: "Loading" },
            { id: "s3", kind: "group", state: ["loading"] },
          ],
        },
      ],
    });
  });
});
