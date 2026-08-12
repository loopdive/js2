import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

describe("#3978 — logical assignment to an uncollected object field", () => {
  it("uses dynamic property storage instead of feeding a numeric sentinel into the call receiver", async () => {
    const result = await compile(
      `
        const registry = { marker: 1 };

        export function run() {
          (registry.values ??= []).push(7);
          (registry.values ??= []).push(8);
          return registry.values.length;
        }
      `,
      {
        allowJs: true,
        fileName: "issue-3978.js",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();

    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.run as () => number)()).toBe(2);
  });
});
