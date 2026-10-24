// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — `<any> instanceof TypeError` (an Error-family builtin on the right,
// propertyHelper's `e instanceof TypeError`) ships as `dyn.instanceof`. The
// target is read off the realm (#7118's `dyn.global_object`); the operator is
// legacy's generic runtime one, which #7120 makes answer an Error-family carrier
// from the value's `$tag`, the set legacy's name-based path tests. Every row is
// compared with a legacy-only compile and with node. The two rows where the IR
// differs from legacy are PINNED below: in each, the IR answer is equal to or
// closer to node than legacy's, never worse.

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { compile, type CompileResult } from "../src/index.js";

const SOURCE = `
  class MyTE extends TypeError {}
  function Fn(this: any) {}
  function isTE(v) { return v instanceof TypeError; }
  function isRE(v) { return v instanceof RangeError; }
  function isE(v) { return v instanceof Error; }
  // Bits: 1 instanceof TypeError, 2 RangeError, 4 Error.
  function row(v: any): number {
    return (isTE(v) === true ? 1 : 0) + (isRE(v) === true ? 2 : 0) + (isE(v) === true ? 4 : 0);
  }
  var caught: any = null;
  try {
    var o: any = null;
    o.x;
  } catch (e) {
    caught = e;
  }
  export function typeError(): number { return row(new TypeError("a")); }
  export function rangeError(): number { return row(new RangeError("a")); }
  export function plainError(): number { return row(new Error("a")); }
  export function syntaxError(): number { return row(new SyntaxError("a")); }
  export function typeErrorSubclass(): number { return row(new MyTE("a")); }
  export function caughtTypeError(): number { return row(caught); }
  export function plainObject(): number { return row({}); }
  export function numberValue(): number { return row(1); }
  export function stringValue(): number { return row("s"); }
  export function fnctorInstance(): number { return row(new (Fn as any)()); }
  export function nullValue(): number { return row(null); }
  export function undefinedValue(): number { return row(undefined); }
  export function protoTypeError(): number { return row(Object.create(TypeError.prototype)); }
  export function protoError(): number { return row(Object.create(Error.prototype)); }
`;

/**
 * Rows where the IR differs from legacy, with all three answers. Legacy's
 * name-based path answers false for any value that is not a native
 * `$Error_struct`. The IR's generic operator ORs in the §7.3.20 chain walk,
 * which finds a prototype the program linked by hand.
 * `Object.create(TypeError.prototype) instanceof Error` stays FALSE in the IR,
 * as in legacy and unlike node: the native error prototypes do not chain to
 * `Error.prototype` (#7120).
 */
const PINNED: Record<string, { ir: number; legacy: number; node: number }> = {
  protoTypeError: { ir: 1, legacy: 0, node: 5 },
  protoError: { ir: 4, legacy: 0, node: 4 },
};

const ROWS = [...SOURCE.matchAll(/export function (\w+)\(/g)].map((m) => m[1]!);

function irBodies(result: CompileResult): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.kind === "emitted" && o.irBodyEmitted).map((o) => o.displayName);
}

async function rows(
  lane: "standalone" | "gc",
  ir: boolean,
): Promise<{ result: CompileResult; got: Record<string, number> }> {
  const result = await compile(SOURCE, {
    ...(lane === "standalone" ? { target: "standalone" } : {}),
    experimentalIR: ir,
    skipSemanticDiagnostics: true,
    allowJs: true,
    fileName: "issue-7106-instanceof-error-intrinsic.ts",
    trackIrOutcomes: true,
  } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return { result, got: Object.fromEntries(ROWS.map((row) => [row, (instance.exports[row] as () => number)()])) };
}

function nodeRows(): Record<string, number> {
  const js = ts.transpile(SOURCE, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const exports: Record<string, () => number> = {};
  new Function("exports", js)(exports);
  return Object.fromEntries(ROWS.map((row) => [row, exports[row]!()]));
}

// propertyHelper's isConfigurable shape: the catch binding on the left, and
// `"…" + e` on the catch binding, which the IR now reads as the dynamic carrier.
// The JSDoc keeps `obj` a dynamic parameter: with only object-literal callers
// it would otherwise be inferred as an object (propertyHelper's callers vary).
const CONFIGURABLE = `
  var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  /** @param {object} obj @param {string|number|symbol} name */
  function isConfigurable(obj, name) {
    try {
      delete obj[name];
    } catch (e) {
      if (!(e instanceof TypeError)) {
        throw "Expected TypeError, got " + e;
      }
    }
    return !__hasOwnProperty(obj, name);
  }
  export function probe(): number {
    var n = 0;
    if (isConfigurable({ a: 1 }, "a") === true) n += 1;
    var pinned: any = Object.defineProperty({}, "k", { value: 1, configurable: false });
    if (isConfigurable(pinned, "k") === false) n += 2;
    return n;
  }
`;

describe("#7106 — instanceof an Error-family builtin through dyn.instanceof", () => {
  const node = nodeRows();

  for (const lane of ["standalone", "gc"] as const) {
    it(`${lane}: ships IR and matches legacy on every unpinned row`, async () => {
      const ir = await rows(lane, true);
      expect(irBodies(ir.result)).toEqual(expect.arrayContaining(["isTE", "isRE", "isE"]));
      expect(ir.result.irPostClaimErrors ?? []).toEqual([]);
      const legacy = await rows(lane, false);
      expect(irBodies(legacy.result)).not.toContain("isTE");
      for (const row of ROWS) {
        const pin = PINNED[row];
        if (pin) {
          expect({ ir: ir.got[row], legacy: legacy.got[row], node: node[row] }, row).toEqual(pin);
        } else {
          expect(ir.got[row], row).toBe(legacy.got[row]);
          expect(ir.got[row], row).toBe(node[row]);
        }
      }
    });

    it(`${lane}: the isConfigurable shape ships IR and answers like node`, async () => {
      const result = await compile(CONFIGURABLE, {
        ...(lane === "standalone" ? { target: "standalone" } : {}),
        experimentalIR: true,
        skipSemanticDiagnostics: true,
        allowJs: true,
        fileName: "issue-7106-is-configurable.ts",
        trackIrOutcomes: true,
      } as never);
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(irBodies(result)).toContain("isConfigurable");
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
      expect((instance.exports.probe as () => number)()).toBe(3);
    });
  }

  // The four refusal exits of `errorIntrinsicTargetTakesTagPath`: each shape
  // stays on legacy with no post-claim error (the selector never claims it).
  const REFUSED: Record<string, string> = {
    "a typed left operand": `export function probe(v: number) { return v instanceof TypeError; }`,
    "a script binding that shadows the constructor": `var TypeError: any = function () {};
      export function probe(v: any) { return v instanceof TypeError; }`,
    "a parameter named like the constructor": `export function probe(v: any, TypeError: any) { return v instanceof TypeError; }`,
    "an Error-family name outside the ambient value set": `export function probe(v: any) { return v instanceof AggregateError; }`,
  };
  for (const [name, source] of Object.entries(REFUSED)) {
    it(`keeps ${name} on legacy`, async () => {
      const result = await compile(source, {
        target: "standalone",
        experimentalIR: true,
        skipSemanticDiagnostics: true,
        allowJs: true,
        fileName: "issue-7106-instanceof-error-intrinsic-refused.ts",
        trackIrOutcomes: true,
      } as never);
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(irBodies(result)).not.toContain("probe");
      expect(result.irPostClaimErrors ?? []).toEqual([]);
    });
  }
});
