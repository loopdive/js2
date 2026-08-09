// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { createNewFunctionShim } from "../src/runtime-eval.js";
import { ts } from "../src/ts-api.js";
import { foldedEvalEarlyError } from "../src/codegen/expressions/eval-early-errors.js";

const LANES = [
  { name: "host", target: undefined },
  { name: "standalone", target: "standalone" as const },
];

async function compileAndRun(
  source: string,
  target: "standalone" | undefined,
  inferModuleStrictArguments = true,
): Promise<{ imports: string[]; value: number; warnings: string[] }> {
  const result = await compile(source, {
    target,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return {
    imports: result.imports.map((entry) => `${entry.module}::${entry.name}`),
    value: (instance.exports as { test(): number }).test(),
    warnings: result.errors.filter((error) => error.severity === "warning").map((error) => error.message),
  };
}

function parsedEval(source: string): ts.SourceFile {
  return ts.createSourceFile("<eval>.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

describe("#3632 folded eval Script early errors", () => {
  it.each(LANES)(
    "$name emits catchable SyntaxErrors at the eval call site",
    { timeout: 30_000 },
    async ({ target }) => {
      const result = await compileAndRun(
        `
        export function test(): number {
          let caught = 0;
          try { eval("'use strict'; var public = 1;"); } catch (e) {
            if (!(e instanceof SyntaxError)) return -1;
            caught++;
          }
          try { eval("var eval;"); } catch (e) {
            if (!(e instanceof SyntaxError)) return -2;
            caught++;
          }
          try { eval("'use strict'; arguments = 1;"); } catch (e) {
            if (!(e instanceof SyntaxError)) return -3;
            caught++;
          }
          try { eval("'use strict'; function f(a, a) {}"); } catch (e) {
            if (!(e instanceof SyntaxError)) return -4;
            caught++;
          }
          try { eval("'use strict'; var octal = 010;"); } catch (e) {
            if (!(e instanceof SyntaxError)) return -5;
            caught++;
          }
          OUTER: while (true) {
            try { eval("break OUTER;"); } catch (e) {
              if (!(e instanceof SyntaxError)) return -6;
              caught++;
            }
            try { eval("continue OUTER;"); } catch (e) {
              if (!(e instanceof SyntaxError)) return -7;
              caught++;
            }
            break;
          }
          return caught;
        }
      `,
        target,
      );

      expect(result.value).toBe(7);
      expect(result.imports.some((name) => /__extern_eval|js2wasm:runtime-eval/.test(name))).toBe(false);
      expect(result.warnings.some((message) => /dynamic eval is not supported/.test(message))).toBe(false);
      if (target === "standalone") expect(result.imports).toEqual([]);
    },
  );

  it.each(LANES)("$name preserves valid sloppy names and Script-local control targets", async ({ target }) => {
    const result = await compileAndRun(
      `
        export function test(): number {
          const direct = eval("var public = 1; 3");
          const indirect = (0, eval)("var public = 2; 4");
          const loop = eval("while (true) { break; } 5");
          const labelled = eval("LOCAL: { break LOCAL; } 6");
          return direct + indirect + loop + labelled;
        }
      `,
      target,
      false,
    );

    expect(result.value).toBe(18);
    expect(result.imports.some((name) => /__extern_eval|js2wasm:runtime-eval/.test(name))).toBe(false);
    if (target === "standalone") expect(result.imports).toEqual([]);
  });

  it("preserves the SyntaxError identity across a host new Function child boundary", () => {
    const fn = createNewFunctionShim()("a", "'use strict'; eval('public = 1;');");
    expect(() => fn()).toThrow(SyntaxError);
  });

  it("keeps property names legal while rejecting orphan control statements", () => {
    expect(foldedEvalEarlyError(parsedEval(`"use strict"; ({ public: 1 }).public;`), true)).toBeUndefined();
    expect(foldedEvalEarlyError(parsedEval(`LOCAL: while (true) { continue LOCAL; }`), false)).toBeUndefined();
    expect(foldedEvalEarlyError(parsedEval(`break CALLER;`), false)).toMatch(/Undefined break target/);
    expect(foldedEvalEarlyError(parsedEval(`continue CALLER;`), false)).toMatch(/Undefined continue target/);
  });
});
