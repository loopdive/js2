// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — `<dynamic> instanceof <dynamic parameter>` ships as `dyn.instanceof`,
// lowered to legacy's own generic runtime operator (`__instanceof_dynamic` plus
// the not-callable throw guard, wrapped as `__ir_dyn_instanceof`). The IR admits
// a site only where legacy itself reaches that operator, so every row must
// answer EXACTLY as the legacy-only compile does. Where legacy's operator
// differs from node, the IR differs the same way, by design (#2916). Those
// rows are listed in DIVERGES_FROM_NODE.

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { compile, type CompileResult } from "../src/index.js";

const SOURCE = `
  /** @param {any} v @param {any} C */
  function isInst(v, C) {
    return v instanceof C;
  }
  class MyTE extends TypeError {}
  var protoNotObject: any = function () {};
  protoNotObject.prototype = "not an object";
  var caught: any = null;
  try {
    var o: any = null;
    o.x;
  } catch (e) {
    caught = e;
  }
  // 0 false, 1 true, 2 threw a TypeError, 3 threw something else.
  function code(v: any, C: any): number {
    try {
      return isInst(v, C) ? 1 : 0;
    } catch (e) {
      return e instanceof TypeError ? 2 : 3;
    }
  }
  export function typeErrorIsTypeError(): number { return code(new TypeError("a"), TypeError); }
  export function rangeErrorIsRangeError(): number { return code(new RangeError("a"), RangeError); }
  export function errorIsError(): number { return code(new Error("a"), Error); }
  export function caughtIsTypeError(): number { return code(caught, TypeError); }
  export function rangeErrorIsNotTypeError(): number { return code(new RangeError("a"), TypeError); }
  export function plainObjectIsNotTypeError(): number { return code({}, TypeError); }
  export function numberIsNotTypeError(): number { return code(1, TypeError); }
  export function stringIsNotError(): number { return code("s", Error); }
  export function arrayIsArrayAndObject(): number { return code([], Array) + code([], Object); }
  export function nonObjectPrototypeThrows(): number { return code({}, protoNotObject); }
  export function typeErrorIsError(): number { return code(new TypeError("a"), Error); }
  export function subclassIsTypeError(): number { return code(new MyTE("a"), TypeError); }
  export function nonCallableTarget(): number { return code({}, {}); }
`;

/**
 * Rows where legacy's generic operator, and so the IR, differs from node.
 * - `nonCallableTarget`: a runtime non-callable target answers `false` rather
 *   than throwing, the #2916 "no wrong throws" rule (node: 2).
 * `typeErrorIsError` / `subclassIsTypeError` diverged until #6850 (#7120) made
 * the native error prototypes chain to `Error.prototype`; they now match node.
 */
const DIVERGES_FROM_NODE = new Set(["nonCallableTarget"]);

const ROWS = [...SOURCE.matchAll(/export function (\w+)\(/g)].map((m) => m[1]!);

const BASE = {
  experimentalIR: true,
  skipSemanticDiagnostics: true,
  allowJs: true,
  fileName: "issue-7106-dyn-instanceof.ts",
  trackIrOutcomes: true,
} as const;

function irBodies(result: CompileResult): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.kind === "emitted" && o.irBodyEmitted).map((o) => o.displayName);
}

async function rows(result: CompileResult): Promise<Record<string, number>> {
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return Object.fromEntries(ROWS.map((row) => [row, (instance.exports[row] as () => number)()]));
}

function nodeRows(): Record<string, number> {
  const js = ts.transpile(SOURCE, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const exports: Record<string, () => number> = {};
  new Function("exports", js)(exports);
  return Object.fromEntries(ROWS.map((row) => [row, exports[row]!()]));
}

async function compileOk(source: string, options: Record<string, unknown>): Promise<CompileResult> {
  const result = await compile(source, { ...BASE, ...options } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

describe("#7106 — generic dynamic instanceof at legacy parity", () => {
  const node = nodeRows();

  it("node fixture: the divergent rows really diverge, the others are what the test claims", () => {
    expect(node.typeErrorIsError).toBe(1);
    expect(node.subclassIsTypeError).toBe(1);
    expect(node.nonCallableTarget).toBe(2);
    expect(node.nonObjectPrototypeThrows).toBe(2);
    expect(node.plainObjectIsNotTypeError).toBe(0);
    expect(node.arrayIsArrayAndObject).toBe(2);
  });

  for (const lane of ["standalone", "gc"] as const) {
    const target = lane === "standalone" ? { target: "standalone" } : {};

    it(`${lane}: isInst ships an IR body and every row answers exactly as legacy`, async () => {
      const ir = await compileOk(SOURCE, target);
      expect(irBodies(ir)).toContain("isInst");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      const legacy = await compileOk(SOURCE, { ...target, experimentalIR: false });
      expect(irBodies(legacy)).not.toContain("isInst");
      const [irRows, legacyRows] = [await rows(ir), await rows(legacy)];
      expect(irRows).toEqual(legacyRows);
      for (const row of ROWS) {
        if (DIVERGES_FROM_NODE.has(row)) expect(irRows[row], row).not.toBe(node[row]);
        else expect(irRows[row], row).toBe(node[row]);
      }
    });
  }

  it("wasi: isInst ships an IR body and validates", async () => {
    const result = await compileOk(SOURCE, { target: "wasi" });
    expect(irBodies(result)).toContain("isInst");
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  // Each source puts the right operand on a legacy NAMED arm (or off the
  // host-free lanes), so the IR must keep `probe` on legacy.
  const REFUSED: Record<string, { source: string; options?: Record<string, unknown> }> = {
    "a parameter named like a builtin": {
      source: `export function probe(v: any, Error: any) { return v instanceof Error; }`,
    },
    "a parameter name another declaration binds": {
      source: `var F: any = null;\nexport function probe(v: any, F: any) { return v instanceof F; }`,
    },
    "a parameter that is written": {
      source: `export function probe(v: any, C: any) { C = Object; return v instanceof C; }`,
    },
    "a module that installs @@hasInstance": {
      source: `var H: any = {}; H[Symbol.hasInstance] = function () { return true; };
        export function probe(v: any, C: any) { return v instanceof C; }`,
    },
    "the host-assisted gc lane": {
      source: `export function probe(v: any, C: any) { return v instanceof C; }`,
      options: { target: undefined, semanticProviders: "host-assisted" },
    },
  };
  for (const [name, { source, options }] of Object.entries(REFUSED)) {
    it(`keeps ${name} on legacy`, async () => {
      const result = await compileOk(source, { target: "standalone", ...options });
      expect(irBodies(result)).not.toContain("probe");
      expect(result.irPostClaimErrors ?? []).toEqual([]);
    });
  }
});
