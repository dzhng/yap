import { describe, expect, it } from "vitest";
import { render } from "./preset-instructions.js";

describe("preset instruction rendering", () => {
  it("splits numbered steps in order and fills placeholders", () => {
    expect(render("1. Read {{path}}\n2. Run node {{kitPath}}/check.mjs", {
      path: "/tmp/preset",
      kitPath: "/tmp/kit",
    })).toEqual(["Read /tmp/preset", "Run node /tmp/kit/check.mjs"]);
  });

  it("rejects an unknown placeholder", () => {
    expect(() => render("1. Read {{missing}}", {})).toThrow(/unknown placeholder/i);
  });
});
