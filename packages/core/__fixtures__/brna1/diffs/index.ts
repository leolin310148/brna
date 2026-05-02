import type { SnapshotDiff } from "@brna/schema";

export interface DiffFixture {
  name: string;
  diff: SnapshotDiff;
}

const button = { id: "sign-in-btn", kind: "button" as const, name: "Sign In", actions: ["tap" as const] };
const removedToast = { id: "toast_42", kind: "toast" as const, name: "Saved" };
const emailInput = {
  id: "email",
  kind: "input" as const,
  name: "Email",
  value: "leo@",
  state: ["focused" as const],
};
const movedNav = { id: "nav", kind: "region" as const, name: "Navigation" };

export const DIFF_FIXTURES: DiffFixture[] = [
  {
    name: "empty",
    diff: { events: [] },
  },
  {
    name: "added",
    diff: {
      events: [{ type: "added", id: button.id, parent_id: "screen-home", node: button }],
    },
  },
  {
    name: "removed",
    diff: {
      events: [{ type: "removed", id: removedToast.id, parent_id: "screen-home", node: removedToast }],
    },
  },
  {
    name: "modified-state",
    diff: {
      events: [
        {
          type: "modified",
          id: emailInput.id,
          node: emailInput,
          changes: [{ field: "state", before: ["idle"], after: ["focused"] }],
        },
      ],
    },
  },
  {
    name: "modified-mixed",
    diff: {
      events: [
        {
          type: "modified",
          id: emailInput.id,
          node: emailInput,
          changes: [
            { field: "value", before: "", after: "leo@" },
            { field: "name", before: "Email address", after: "Email" },
            { field: "state", before: ["loading", "selected"], after: ["focused"] },
          ],
        },
      ],
    },
  },
  {
    name: "moved",
    diff: {
      events: [{ type: "moved", id: movedNav.id, node: movedNav, from_parent: "", to_parent: "main" }],
    },
  },
];
