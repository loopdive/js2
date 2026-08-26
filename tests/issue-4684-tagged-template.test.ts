import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";

describe("#4684 discarded tagged-template calls", () => {
  it("invokes an inline tag and preserves cooked and raw segments", async () => {
    const result = await compile(
      `
        var calls = 0;
        var ordinaryCalls = 0;
        var cooked;
        var raw;
        (function () {
          ordinaryCalls++;
        })();
        (function (strings) {
          calls++;
          cooked = strings[0];
          raw = strings.raw[0];
        })\`hello\`;

        export function test() {
          return ordinaryCalls === 1 && calls === 1 && cooked === "hello" && raw === "hello" ? 1 : 0;
        }
      `,
      { allowJs: true, fileName: "issue-4684-tagged-template.js", target: "standalone" },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setInstance?.(instance);
    expect((instance.exports.test as () => number)()).toBe(1);
  });
});
