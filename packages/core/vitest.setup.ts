import { expect } from "vitest";

// An owner marks the statuses it reports as work (`storedWork` in @yap/protocol). The mark is an
// enumerable symbol so it survives object spread; it never serializes, so a status equals its
// plain shape here too.
const isMark = (key: symbol) => key.description === "storedWork";
const marked = (value: unknown): value is object =>
  !!value && typeof value === "object" && Object.getOwnPropertySymbols(value).some(isMark);
const unmarked = (value: object) =>
  Object.fromEntries(Object.entries(value)) as Record<string, unknown>;

expect.addEqualityTesters([
  function ignoringWorkMark(a, b, customTesters) {
    if (!marked(a) && !marked(b)) return undefined;
    return this.equals(marked(a) ? unmarked(a) : a, marked(b) ? unmarked(b) : b, customTesters);
  },
]);
