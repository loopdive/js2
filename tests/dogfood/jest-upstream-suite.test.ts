import { describe, expect, it } from "vitest";

// @ts-expect-error — the dogfood adapter is an executable .mjs module.
import { adaptDetectNewline } from "./setup-jest-upstream-suite.mjs";

describe("Jest upstream dependency adapters", () => {
  it("converts the pinned CommonJS detect-newline shape to ESM", () => {
    const source = `
      'use strict';
      const detectNewline = value => value;
      module.exports = detectNewline;
      module.exports.graceful = value => detectNewline(value) || '\\n';
    `;
    const adapted = adaptDetectNewline(source);
    expect(adapted).toContain("export default detectNewline;");
    expect(adapted).toContain("export const graceful");
    expect(adapted).not.toContain("module.exports");
    expect(adapted).not.toContain("use strict");
  });

  it("rejects a dependency whose CommonJS export shape changes", () => {
    expect(() => adaptDetectNewline("module.exports = changed;\n")).toThrow("source shape changed");
  });
});
