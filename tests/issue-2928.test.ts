// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2928 E2 canary — self-compile the E1 interpreter into a standalone WasmGC
// module, then run ESTree -> bytecode -> dispatch entirely inside Wasm.
//
// E6 owns the separately linked runtime artifact. Until that packaging slice
// lands, concatenate the import-clean interpreter sources into one compilation
// unit: compileMulti's per-source module initializers do not yet form one
// ordered standalone runtime initializer (#3525).

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const INTERP_FILES = [
  "types.ts",
  "opcodes.ts",
  "encoder.ts",
  "runtime-ops.ts",
  "eval-environment.ts",
  "emitter.ts",
  "loop.ts",
  "dynamic-function.ts",
] as const;

function stripModuleSyntax(source: string): string {
  return source
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/^export \{[^;]+;\n/gm, "")
    .replace(/\bexport (?=(?:type|interface|class|const|function)\b)/g, "");
}

function e2BundleSource(): string {
  const interpreter = INTERP_FILES.map((name) => stripModuleSyntax(readFileSync(resolve("src/interp", name), "utf8")));

  return [
    ...interpreter,
    `
      function makeAst(): any {
        // Open objects match the compiled-Acorn $Object carrier consumed by
        // dynamic ESTree reads. Fixed-shape anonymous structs are a different
        // standalone representation once passed through any.
        const left: any = {};
        left.type = "Literal";
        left.value = 1;
        const right: any = {};
        right.type = "Literal";
        right.value = 2;
        const binary: any = {};
        binary.type = "BinaryExpression";
        binary.operator = "+";
        binary.left = left;
        binary.right = right;
        const statement: any = {};
        statement.type = "ExpressionStatement";
        statement.expression = binary;
        const body: any[] = [statement];
        const ast: any = {};
        ast.type = "Program";
        ast.sourceType = "script";
        ast.body = body;
        return ast;
      }

      function makeFunctionAst(): any {
        const left: any = {};
        left.type = "Identifier";
        left.name = "a";
        const right: any = {};
        right.type = "Identifier";
        right.name = "b";
        const binary: any = {};
        binary.type = "BinaryExpression";
        binary.operator = "+";
        binary.left = left;
        binary.right = right;
        const ret: any = {};
        ret.type = "ReturnStatement";
        ret.argument = binary;
        const block: any = {};
        block.type = "BlockStatement";
        block.body = [ret];
        const a: any = {};
        a.type = "Identifier";
        a.name = "a";
        const b: any = {};
        b.type = "Identifier";
        b.name = "b";
        const id: any = {};
        id.type = "Identifier";
        id.name = "anonymous";
        const declaration: any = {};
        declaration.type = "FunctionDeclaration";
        declaration.id = id;
        declaration.params = [a, b];
        declaration.body = block;
        const ast: any = {};
        ast.type = "Program";
        ast.sourceType = "script";
        ast.body = [declaration];
        return ast;
      }

      function parse(source: string, options: any): any {
        if (options.ecmaVersion !== 2025 || options.sourceType !== "script") {
          throw new TypeError("unexpected parser options");
        }
        if (source === "function anonymous(a,b\\n) {\\nreturn a + b\\n}") {
          return makeFunctionAst();
        }
        if (source === "1 + 2") return makeAst();
        throw new SyntaxError("unexpected runtime source");
      }

      export function testProgram(): number {
        const globalObject: any = {};
        const env = new EnvRec(ENV_GLOBAL, null, null, null, globalObject);
        return interpEnter(emitProgram(makeAst()), env, globalObject, []) as number;
      }

      export function testDynamicFunction(): number {
        const globalObject: any = {};
        const fn = createDynamicFunction(parse, "a,b", "return a + b", globalObject);
        return fn(1, 2) as number;
      }

      export function testDynamicClosureCreated(): number {
        const globalObject: any = {};
        const fn = createDynamicFunction(parse, "a,b", "return a + b", globalObject);
        return fn === undefined ? 0 : 1;
      }

      export function testDynamicMetaParamCount(): number {
        return compileDynamicFunctionMeta(parse, "a,b", "return a + b").paramCount;
      }

      export function testDynamicDirect(): number {
        const globalObject: any = {};
        const env = new EnvRec(ENV_GLOBAL, null, null, null, globalObject);
        const meta = compileDynamicFunctionMeta(parse, "a,b", "return a + b");
        return interpEnter(meta, env, globalObject, [1, 2]) as number;
      }

      export function testIndirectEval(): number {
        return executeIndirectEval(parse, "1 + 2", {}) as number;
      }

      export function testIndirectEvalNonString(): number {
        return executeIndirectEval(parse, 42, {}) as number;
      }
    `,
  ].join("\n");
}

describe("#2928 E2 — self-compiled standalone interpreter canary", () => {
  it("evaluates ESTree plus a parser-injected dynamic Function entirely inside Wasm", async () => {
    const result = await compile(e2BundleSource(), {
      fileName: "issue-2928-e2-bundle.ts",
      skipSemanticDiagnostics: true,
      target: "standalone",
    });

    expect(
      result.success,
      result.errors
        .map((error) => `${error.file ? `${relative(process.cwd(), error.file)}:` : ""}${error.message}`)
        .join("\n"),
    ).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.testProgram as () => number)()).toBe(3);
    expect((instance.exports.testDynamicMetaParamCount as () => number)()).toBe(2);
    expect((instance.exports.testDynamicDirect as () => number)()).toBe(3);
    expect((instance.exports.testDynamicClosureCreated as () => number)()).toBe(1);
    expect((instance.exports.testDynamicFunction as () => number)()).toBe(3);
    expect((instance.exports.testIndirectEval as () => number)()).toBe(3);
    expect((instance.exports.testIndirectEvalNonString as () => number)()).toBe(42);
  }, 120_000);
});
