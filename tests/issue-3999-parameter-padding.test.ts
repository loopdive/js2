import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

describe("#3999 — styled-components validation regressions", () => {
  it("keeps a shadowing loop variable separate from an outer captured binding", async () => {
    const result = await compile(
      `
        function evaluate({ options: entry = { value: 5 } } = {}) {
          let result = 0;
          const read = () => entry.value;
          for (let entry = 0; entry < 2; entry++) {
            result += entry;
          }
          return read() + result;
        }

        export function run() {
          return evaluate();
        }
      `,
      {
        allowJs: true,
        fileName: "issue-3999-shadowed-capture.js",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();

    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.run as () => number)()).toBe(6);
  });

  it("pads ordinary gaps before emitting the defaulted array parameter", async () => {
    const result = await compile(
      `
        function collect(value, first, second, third, values = []) {
          return value.length + values.length +
            (first === undefined ? 10 : 0) +
            (second === undefined ? 20 : 0) +
            (third === undefined ? 30 : 0);
        }

        export function run() {
          return collect([7]);
        }
      `,
      {
        allowJs: true,
        fileName: "issue-3999.js",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();

    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.run as () => number)()).toBe(61);
  });

  it("does not re-convert a dynamically loaded class instance that is already externref", async () => {
    const result = await compile(
      `
        class Value {
          constructor() {
            this.value = 1;
          }
        }

        class Holder {
          constructor() {
            this.render = () => this.instance.toString();
            this.instance = new Value();
          }
        }

        export function run() {
          return new Holder().render();
        }
      `,
      {
        allowJs: true,
        fileName: "issue-3999-dynamic-class-receiver.js",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();

    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.run as () => string)()).toBe("[object Object]");
  });
});
