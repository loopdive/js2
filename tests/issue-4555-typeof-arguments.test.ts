// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { formalParametersBindArguments } from "../src/codegen/helpers/body-uses-arguments.js";
import { compile } from "../src/index.js";
import { ts } from "../src/ts-api.js";

type OracleBackend = "checker" | "inhouse";

async function runStandalone(
  source: string,
  oracleBackend: OracleBackend,
  args: unknown[] = [],
  fileName = "issue-4555.js",
): Promise<number> {
  const result = await compile(source, {
    fileName,
    target: "standalone",
    inferModuleStrictArguments: false,
    oracleBackend,
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(...args: unknown[]): number }).test(...args);
}

describe.each(["checker", "inhouse"] as const)(
  "#4555 typeof arguments binding identity (%s oracle)",
  (oracleBackend) => {
    it("recognizes the implicit arguments object in direct and comparison forms", async () => {
      expect(
        await runStandalone(
          `
        function probe() {
          var direct = typeof arguments;
          return (direct === "object" ? 10 : 0) + (typeof arguments === "object" ? 1 : 0);
        }
        export function test() { return probe(3); }
      `,
          oracleBackend,
        ),
      ).toBe(11);
    });

    it("keeps an uninitialized var declaration on the implicit arguments binding", async () => {
      expect(
        await runStandalone(
          `
        function probe() {
          var arguments;
          var direct = typeof arguments;
          return (direct === "object" ? 10 : 0) + (typeof arguments === "object" ? 1 : 0);
        }
        export function test() { return probe(3); }
      `,
          oracleBackend,
        ),
      ).toBe(11);
    });

    it("observes a later assignment to an otherwise uninitialized arguments var", async () => {
      expect(
        await runStandalone(
          `
        function probe() {
          var arguments;
          arguments = 3;
          var direct = typeof arguments;
          return (direct === "number" ? 10 : 0) + (typeof arguments === "number" ? 1 : 0);
        }
        export function test() { return probe(1); }
      `,
          oracleBackend,
        ),
      ).toBe(11);
    });

    it("does not mistake an arguments parameter for the implicit object", async () => {
      expect(
        await runStandalone(
          `
        export function test(arguments) {
          var direct = typeof arguments;
          return (direct === "number" ? 10 : 0) + (typeof arguments === "number" ? 1 : 0);
        }
      `,
          oracleBackend,
          [3],
        ),
      ).toBe(11);
    });

    it("preserves undefined for an omitted optional arguments parameter", async () => {
      expect(
        await runStandalone(
          `
        function probe(arguments?: number) {
          var direct = typeof arguments;
          return (direct === "undefined" ? 10 : 0) + (typeof arguments === "undefined" ? 1 : 0);
        }
        export function test() { return probe(); }
      `,
          oracleBackend,
          [],
          "issue-4555.ts",
        ),
      ).toBe(11);
    });

    it("preserves an arguments parameter captured by an arrow", async () => {
      expect(
        await runStandalone(
          `
        function probe(arguments) {
          var read = () => typeof arguments;
          var direct = read();
          return (direct === "number" ? 10 : 0) + (read() === "number" ? 1 : 0);
        }
        export function test(value) { return probe(value); }
      `,
          oracleBackend,
          [3],
        ),
      ).toBe(11);
    });

    it("preserves an arguments parameter while direct eval reifies the scope", async () => {
      expect(
        await runStandalone(
          `
        function probe(arguments) {
          eval("var marker = 1");
          var direct = typeof arguments;
          return marker + (direct === "number" ? 10 : 0) + (typeof arguments === "number" ? 1 : 0);
        }
        export function test(value) { return probe(value); }
      `,
          oracleBackend,
          [3],
        ),
      ).toBe(12);
    });

    it.each([
      [
        "nested declaration",
        `
          export function test(value) {
            function probe(arguments) {
              var direct = typeof arguments;
              return (direct === "number" ? 10 : 0) + (typeof arguments === "number" ? 1 : 0);
            }
            return probe(value);
          }
        `,
      ],
      [
        "function expression",
        `
          var probe = function(arguments) {
            var direct = typeof arguments;
            return (direct === "number" ? 10 : 0) + (typeof arguments === "number" ? 1 : 0);
          };
          export function test(value) { return probe(value); }
        `,
      ],
      [
        "object method",
        `
          var holder = {
            probe(arguments) {
              var direct = typeof arguments;
              return (direct === "number" ? 10 : 0) + (typeof arguments === "number" ? 1 : 0);
            }
          };
          export function test(value) { return holder.probe(value); }
        `,
      ],
      [
        "inline function expression",
        `
          export function test(value) {
            return (function(arguments) {
              var direct = typeof arguments;
              return (direct === "number" ? 10 : 0) + (typeof arguments === "number" ? 1 : 0);
            })(value);
          }
        `,
      ],
      [
        "constructor function expression",
        `
          export function test(value) {
            var result = new (function(arguments) {
              var direct = typeof arguments;
              this.answer = (direct === "number" ? 10 : 0) + (typeof arguments === "number" ? 1 : 0);
            })(value);
            return result.answer;
          }
        `,
      ],
    ])("keeps the explicit binding in the %s lowering path", async (_label, source) => {
      expect(await runStandalone(source, oracleBackend, [3])).toBe(11);
    });

    it("does not mistake an initialized arguments var for the implicit object", async () => {
      expect(
        await runStandalone(
          `
        function probe() {
          var arguments = 3;
          var direct = typeof arguments;
          return (direct === "number" ? 10 : 0) + (typeof arguments === "number" ? 1 : 0);
        }
        export function test() { return probe(); }
      `,
          oracleBackend,
        ),
      ).toBe(11);
    });

    it.each([
      ["number", "3", "number"],
      ["bitwise number", "3 | 0", "number"],
      ["boolean", "true", "boolean"],
    ])("observes a %s var initializer after a hoisted arguments function", async (_label, value, typeName) => {
      expect(
        await runStandalone(
          `
        function probe() {
          var arguments = ${value};
          function arguments() {}
          var direct = typeof arguments;
          return (direct === "${typeName}" ? 10 : 0) + (typeof arguments === "${typeName}" ? 1 : 0);
        }
        export function test() { return probe(); }
      `,
          oracleBackend,
        ),
      ).toBe(11);
    });

    it("does not mistake an arguments function binding for the implicit object", async () => {
      expect(
        await runStandalone(
          `
        function probe() {
          function arguments() { return 3; }
          var direct = typeof arguments;
          return (direct === "function" ? 10 : 0) + (typeof arguments === "function" ? 1 : 0);
        }
        export function test() { return probe(); }
      `,
          oracleBackend,
        ),
      ).toBe(11);
    });
  },
);

describe("#4555 arguments formal BoundNames", () => {
  it.each([
    ["function probe(arguments) {}", true],
    ["function probe({ arguments }) {}", true],
    ["function probe({ value: arguments }) {}", true],
    ["function probe([arguments]) {}", true],
    ["function probe({ arguments: renamed }) {}", false],
    ["function probe([value]) {}", false],
  ])("classifies %s", (source, expected) => {
    const sourceFile = ts.createSourceFile("issue-4555.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const declaration = sourceFile.statements[0];
    expect(ts.isFunctionDeclaration(declaration)).toBe(true);
    expect(formalParametersBindArguments((declaration as ts.FunctionDeclaration).parameters)).toBe(expected);
  });
});
