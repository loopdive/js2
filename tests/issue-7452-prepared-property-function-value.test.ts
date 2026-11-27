// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7452 — a function value stored in a property, through the strict Prepared entry (standalone). No input may make
// `compile()` throw: the function holding such a value lowers, or refuses by name. Under the test262 policy
// (`unlowerableBodies: "abort"`) the refusal becomes that function's abort body (#7354 U); under `refuse` the compile
// fails by the same diagnostic.
//
// Before the #7354 G1 fixes (3408858181 and the later fd529937ec, each sufficient on its own) the function test of the
// dynamic value needed a source closure's wrapper root. When the program's only function value sat in an abort body, a
// `typeof` on a dynamic value elsewhere made `compile()` throw
// `PreparedIrProgramInvariantError … the function test needs the source closures' wrapper root`.
import { describe, expect, it } from "vitest";
import type { CompileResult } from "../src/index.js";
import {
  type Test262CompileOptions,
  compile,
  requiredPreparedAbortBodies,
} from "../src/test262/test262-prepared-entry.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { agreesWithNode, preparedOptions, yieldToRpc } from "./helpers/prepared-node-agreement.js";

const SLOW = 240_000;

interface Refusal {
  readonly code: string;
  readonly detail: string;
}
const STRICT_EQUALS: Refusal = {
  code: "operand-coercion-unsupported",
  detail: "ir/from-ast: Phase 1 requires matching operand types for '===' in g",
};
const NESTED_DECLARATION: Refusal = {
  code: "body-shape-rejected",
  detail: "ir/from-ast: nested func must have a return type annotation (g)",
};

/** `g` stores the function `x` in a property and reads it back by `typeof` and `===`: node's `g(1)` is "functiontrue". */
const storeAndCompare = (x: string) => `function g(k){ ${x} var h = {}; h.v = x; return typeof h.v + (h.v === x); }`;
/** The expression variant, called as `g(1)`, is the issue's program. */
const VARIANTS = [
  ["a function expression", storeAndCompare("var x = function(){ return 7; };"), STRICT_EQUALS],
  ["a function declaration", storeAndCompare("function x(){ return 7; }"), NESTED_DECLARATION],
] as const;
const FILE_NAMES = ["test.js", "test.ts"] as const;

const options = (fileName: string): Test262CompileOptions => ({
  ...preparedOptions(),
  fileName,
  allowJs: fileName.endsWith(".js"),
});

/** A throw out of `compile()` rejects this promise and fails the test with that exception. */
async function compileOnce(source: string, fileName: string, policy: "abort" | "refuse"): Promise<CompileResult> {
  await yieldToRpc();
  return compile(source, options(fileName), undefined, policy);
}

/** Error diagnostics only: `h.v` on `{}` is a TypeScript warning in test.ts, which does not stop the compile. */
const errorDiagnostics = (result: CompileResult) =>
  result.errors.filter((error) => error.severity !== "warning").map(({ code, message }) => ({ code, message }));

const abortTable = (result: CompileResult) =>
  requiredPreparedAbortBodies(result)!.map(({ name, code, detail }) => ({
    name,
    code,
    detail,
  }));

/** The top wasm frame of the trap `__module_init` ends in; the realm's RuntimeError is matched by name. */
function trapFrame(result: CompileResult): string | undefined {
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
  } catch (error) {
    expect((error as Error).constructor.name).toBe("RuntimeError");
    expect((error as Error).message).toBe("unreachable");
    return /at\s+(\S+)\s+\(wasm:\/\//.exec((error as Error).stack!)?.[1];
  }
  return undefined;
}

describe.each(VARIANTS)("#7452 — g stores %s in a property and compares it; `g(1)` runs", (_label, g, refusal) => {
  const source = `${g}\nvar out = g(1);`;

  it.each(FILE_NAMES)(
    "%s, abort: compiles; g is an abort body named by its refusal, and the call traps in g",
    async (fileName) => {
      const result = await compileOnce(source, fileName, "abort");
      expect(errorDiagnostics(result)).toEqual([]);
      expect(result.success).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      expect(abortTable(result)).toEqual([{ name: "g", ...refusal }]);
      expect(trapFrame(result)).toBe("g");
    },
    SLOW,
  );

  it.each(FILE_NAMES)(
    "%s, refuse: the compile fails by the same diagnostic",
    async (fileName) => {
      const result = await compileOnce(source, fileName, "refuse");
      expect(result.success).toBe(false);
      expect(errorDiagnostics(result)).toEqual([{ code: refusal.code, message: refusal.detail }]);
    },
    SLOW,
  );
});

describe.each(VARIANTS)(
  "#7452 — g holds the program's only function value (%s) and is not called; a `typeof` on a dynamic value runs",
  (_label, g, refusal) => {
    const source = `${g}\nvar q = {}; var out = typeof q.v;`;

    it.each(FILE_NAMES)(
      "%s, abort: node's answer; g is the abort body",
      async (fileName) => {
        await agreesWithNode(source, true, options(fileName));
        expect(abortTable(await compileOnce(source, fileName, "abort"))).toEqual([{ name: "g", ...refusal }]);
      },
      SLOW,
    );

    it.each(FILE_NAMES)(
      "%s, refuse: the compile fails by g's diagnostic",
      async (fileName) => {
        const result = await compileOnce(source, fileName, "refuse");
        expect(result.success).toBe(false);
        expect(errorDiagnostics(result)).toEqual([{ code: refusal.code, message: refusal.detail }]);
      },
      SLOW,
    );
  },
);
