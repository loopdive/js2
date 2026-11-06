// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7120 — legacy's generic runtime `instanceof` (`__instanceof_dynamic`, the
// host-free operator for a right operand that is a VALUE, not a literal
// constructor name) answered `false` for every native-error subtype against
// `Error` and for a user error subclass against its builtin parent. The native
// error prototypes do not chain, so the §7.3.20 walk never reaches
// `Error.prototype`. The fix ORs legacy's own `$tag` set (#1473) into the
// operator for an Error-family target. Every row is compared with node.

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { compile } from "../src/index.js";

const SOURCE = `
  // The right operand reaches the operator as a value: the generic path.
  function isInst(v: any, C: any): boolean {
    return v instanceof C;
  }
  class MyTE extends TypeError {}
  var caught: any = null;
  try {
    var o: any = null;
    o.x;
  } catch (e) {
    caught = e;
  }
  export function typeErrorIsError(): boolean { return isInst(new TypeError("a"), Error); }
  export function rangeErrorIsError(): boolean { return isInst(new RangeError("a"), Error); }
  export function syntaxErrorIsError(): boolean { return isInst(new SyntaxError("a"), Error); }
  export function referenceErrorIsError(): boolean { return isInst(new ReferenceError("a"), Error); }
  export function evalErrorIsError(): boolean { return isInst(new EvalError("a"), Error); }
  export function uriErrorIsError(): boolean { return isInst(new URIError("a"), Error); }
  export function caughtIsError(): boolean { return isInst(caught, Error); }
  export function caughtIsTypeError(): boolean { return isInst(caught, TypeError); }
  export function subclassIsTypeError(): boolean { return isInst(new MyTE("a"), TypeError); }
  export function subclassIsError(): boolean { return isInst(new MyTE("a"), Error); }
  export function subclassIsNotRangeError(): boolean { return isInst(new MyTE("a"), RangeError); }
  export function typeErrorIsNotRangeError(): boolean { return isInst(new TypeError("a"), RangeError); }
  export function errorIsNotTypeError(): boolean { return isInst(new Error("a"), TypeError); }
  export function errorIsError(): boolean { return isInst(new Error("a"), Error); }
  export function plainObjectIsNotError(): boolean { return isInst({}, Error); }
  export function primitiveIsNotError(): boolean { return isInst("s", Error); }
  export function protoObjectIsTypeError(): boolean { return isInst(Object.create(TypeError.prototype), TypeError); }
  export function literalTypeErrorIsError(): boolean { return new TypeError("a") instanceof Error; }
`;

const ROWS = [...SOURCE.matchAll(/export function (\w+)\(/g)].map((m) => m[1]!);

function nodeRows(): Record<string, boolean> {
  const js = ts.transpile(SOURCE, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const exports: Record<string, () => boolean> = {};
  new Function("exports", js)(exports);
  return Object.fromEntries(ROWS.map((row) => [row, exports[row]!()]));
}

describe("#7120 — generic instanceof answers Error-family membership like node", () => {
  const node = nodeRows();

  it("node fixture: the rows this issue fixes are true", () => {
    for (const row of ["typeErrorIsError", "caughtIsError", "subclassIsTypeError", "subclassIsError"]) {
      expect(node[row], row).toBe(true);
    }
  });

  for (const lane of ["standalone", "gc"] as const) {
    it(`${lane}: every row answers as node`, async () => {
      const result = await compile(SOURCE, {
        ...(lane === "standalone" ? { target: "standalone" } : {}),
        skipSemanticDiagnostics: true,
        fileName: "issue-7120.ts",
      } as never);
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
      (instance.exports.__module_init as (() => void) | undefined)?.();
      const got = Object.fromEntries(ROWS.map((row) => [row, Boolean((instance.exports[row] as () => unknown)())]));
      expect(got).toEqual(node);
    });
  }
});
