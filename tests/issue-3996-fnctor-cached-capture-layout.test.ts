import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

describe("#3996 cached fnctor constructor capture ABI", () => {
  it("keeps later constructor calls aligned after nested capture metadata changes", async () => {
    const result = await compile(
      `
        var output = 0;
        (function () {
          var undefined;
          var factory = (function factory() {
            function first() {
              var box = new Box(20, true);
              return box.value + (box.enabled ? 1 : 0);
            }
            /**
             * @param {*} value
             * @param {boolean} enabled
             */
            function Box(value, enabled) {
              this.value = value;
              this.enabled = enabled;
              this.missing = undefined;
            }
            /** @param {{ value: boolean }} wrapper */
            function second(wrapper) {
              var box = new Box(wrapper.value, false);
              return (box.value ? 21 : 0) + (box.enabled ? 1 : 0);
            }
            return function () {
              return first() + second({ value: true });
            };
          });
          var runScenario = factory();
          output = runScenario();
        }());
        export function run() {
          return output;
        }
      `,
      {
        fileName: "cached-fnctor-capture-layout.js",
        allowJs: true,
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.run as () => number)()).toBe(42);
  });
});
