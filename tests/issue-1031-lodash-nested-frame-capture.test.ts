import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

describe("#1031 nested-function captures across repeated frames", () => {
  it("materializes an immutable capture from the current frame's live ref cell", async () => {
    const result = await compile(
      `
        var output = 0;
        (function () {
          var LIMIT = 40;
          var factory = (function factory() {
            var earlyCallbacks = [function (value) {
              return hidden(value);
            }];
            function hidden(value) {
              return value + LIMIT;
            }
            var callbacks = [function (value) {
              return value + LIMIT;
            }];
            function readLimit() {
              return LIMIT + 2;
            }
            -LIMIT;
            return readLimit;
          });
          var readLimit = factory();
          output = readLimit();
        }());
        export function run() {
          return output;
        }
      `,
      {
        fileName: "lodash-repeated-frame-capture.js",
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
