import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function compileStandalone(source: string, fileName: string) {
  const result = await compile(source, {
    fileName,
    target: "standalone",
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  return { result, instance: await WebAssembly.instantiate(module, {}) };
}

describe("#3793 retained function-object parser wrappers", () => {
  it("emits all three Acorn wrapper shapes while preserving the Parser receiver", async () => {
    const { result, instance } = await compileStandalone(
      `
      var Parser = function Parser(value) {
        this.value = value;
      };
      Parser.prototype.read = function read() {
        return this.value;
      };
      Parser.parse = function parse(value) {
        return new this(value).read();
      };
      Parser.parseExpressionAt = function parseExpressionAt(value, position, options) {
        return new this(value + position + options).read();
      };
      Parser.tokenizer = function tokenizer(value, options) {
        return new this(value + options).read();
      };

      function parse(value) {
        return Parser.parse(value);
      }
      function parseExpressionAt(value, position, options) {
        return Parser.parseExpressionAt(value, position, options);
      }
      function tokenizer(value, options) {
        return Parser.tokenizer(value, options);
      }

      export function run() {
        return parse(37) + parseExpressionAt(10, 2, 3) + tokenizer(40, 2);
      }
      `,
      "issue-3793-retained-parser-wrappers.mjs",
    );

    expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toEqual(
      expect.arrayContaining(["parse", "parseExpressionAt", "tokenizer"]),
    );
    expect((instance.exports.run as () => number)()).toBe(94);
  });

  it("keeps aliases, receiver writes, duplicate method writes, and computed calls on direct codegen", async () => {
    const { result, instance } = await compileStandalone(
      `
      var Stable = function Stable(value) { this.value = value; };
      Stable.parse = function parse(value) { return value; };
      var Alias = Stable;

      var Reassigned = function Reassigned(value) { this.value = value; };
      Reassigned.parse = function parse(value) { return value; };
      Reassigned = Stable;

      var Duplicate = function Duplicate(value) { this.value = value; };
      Duplicate.parse = function parse(value) { return value; };
      Duplicate.parse = function parseAgain(value) { return value + 1; };

      function aliasWrapper(value) {
        return Alias.parse(value);
      }
      function reassignedWrapper(value) {
        return Reassigned.parse(value);
      }
      function duplicateWrapper(value) {
        return Duplicate.parse(value);
      }
      function computedWrapper(value) {
        return Stable["parse"](value);
      }

      export function run() {
        return aliasWrapper(1) + reassignedWrapper(2) + duplicateWrapper(3) + computedWrapper(4);
      }
      `,
      "issue-3793-retained-parser-wrapper-fallbacks.mjs",
    );

    for (const name of ["aliasWrapper", "reassignedWrapper", "duplicateWrapper", "computedWrapper"]) {
      expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).not.toContain(name);
    }
    expect((instance.exports.run as () => number)()).toBe(11);
  });

  it("keeps a typed string-result wrapper on direct codegen without a post-claim withdrawal", async () => {
    const { result, instance } = await compileStandalone(
      `
      var Factory = function Factory() {};
      Factory.method = function method(value: string): string {
        return value;
      };

      function wrapper(value: string): string {
        return Factory.method(value);
      }

      export function run() {
        return wrapper("abc").length;
      }
      `,
      "issue-3793-retained-parser-wrapper-string-result.ts",
    );

    expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).not.toContain("wrapper");
    expect((instance.exports.run as () => number)()).toBe(3);
  });

  it("rejects an unboxable boolean wrapper argument before the IR claim", async () => {
    const { result, instance } = await compileStandalone(
      `
      var Factory = function Factory() {};
      Factory.method = function method(value: boolean): any {
        return value ? 7 : 3;
      };

      function wrapper(value: boolean): any {
        return Factory.method(value);
      }

      export function run(): number {
        return wrapper(true);
      }
      `,
      "issue-3793-retained-parser-wrapper-boolean-argument.ts",
    );

    expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).not.toContain("wrapper");
    expect((instance.exports.run as () => number)()).toBe(7);
  });
});
