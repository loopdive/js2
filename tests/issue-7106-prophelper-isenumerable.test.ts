// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 propertyHelper arm 2 — `isEnumerable` reads its for-in key
// (`if (x === name)`). The selector admitted for-in head-value reads only
// when the key is a host string, so on native-strings lanes `isEnumerable`
// (and through call-graph closure `verifyEnumerable` / `verifyNotEnumerable`)
// stayed legacy with `forin-head-value-used`. On the non-fast carrier the key
// helpers' externref IS the dynamic carrier of the key string, so the head is
// now read as a dynamic value. Every result is compared with node.

import { describe, expect, it, vi } from "vitest";
import ts from "typescript";

import { compile, type CompileResult } from "../src/index.js";

// propertyHelper.js's `isEnumerable`, verbatim, with its two S1g aliases.
const IS_ENUMERABLE = `
  var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  var __propertyIsEnumerable = Function.prototype.call.bind(Object.prototype.propertyIsEnumerable);
  /** @param {object} obj @param {string|symbol} name */
  function isEnumerable(obj, name) {
    var stringCheck = false;
    if (typeof name === "string") {
      for (var x in obj) {
        if (x === name) {
          stringCheck = true;
          break;
        }
      }
    } else {
      stringCheck = true;
    }
    return stringCheck && __hasOwnProperty(obj, name) && __propertyIsEnumerable(obj, name);
  }
  export function probe(): number {
    var o: any = { a: 1, b: 2 };
    Object.defineProperty(o, "hidden", { value: 3, enumerable: false });
    var child: any = Object.create(o);
    child.own = 4;
    var s = Symbol("s");
    o[s] = 5;
    var n = 0;
    if (isEnumerable(o, "a") === true) n += 1;
    if (isEnumerable(o, "b") === true) n += 2;
    if (isEnumerable(o, "hidden") === false) n += 4;
    if (isEnumerable(o, "missing") === false) n += 8;
    if (isEnumerable(child, "own") === true) n += 16;
    if (isEnumerable(child, "a") === false) n += 32;
    if (isEnumerable(o, s) === true) n += 64;
    if (isEnumerable([7, 8], "1") === true) n += 128;
    if (isEnumerable([7, 8], "length") === false) n += 256;
    return n;
  }
`;

// Other head-value reads: a dynamic member read, a dynamic return, a dynamic
// equality and `typeof`. A concrete-string accumulation stays refused.
const HEAD_SHAPES = `
  /** @param {object} o */
  function joinKeys(o) { var s = ""; for (var k in o) { s = s + k; } return s; }
  /** @param {object} o */
  function countLongKeys(o) { var n = 0; for (var k in o) { if (k.length > 1) { n = n + 1; } } return n; }
  /** @param {object} o */
  function firstKey(o) { for (var k in o) { return k; } return "none"; }
  /** @param {object} o @param {*} want */
  function hasKey(o, want) { for (var k in o) { if (k === want) { return true; } } return false; }
  /** @param {object} o */
  function keyCount(o) { var n = 0; for (var k in o) { if (typeof k === "string") { n = n + 1; } } return n; }
  export function probe(): number {
    var o: any = { a: 1, bb: 2, ccc: 3 };
    var n = 0;
    if (joinKeys(o) === "abbccc") n += 1;
    if (countLongKeys(o) === 2) n += 2;
    if (firstKey(o) === "a") n += 4;
    if (hasKey(o, "bb") === true && hasKey(o, "zz") === false) n += 8;
    if (keyCount(o) === 3) n += 16;
    if (firstKey({}) === "none") n += 32;
    return n;
  }
`;

// Head reads the selector must REFUSE before the claim. Each is a JSDoc-typed
// JS helper (the IS_ENUMERABLE shape) over a dynamic receiver.
//
// `switchKey` is the 2026-10-25 claim-then-demote: TS types the head
// `string`, the switch gate's carrier predicate followed `k` to a declaration
// with no initializer and certified it, and from-ast then demoted the CLAIMED
// body ("string-tested switch disc lowered to dynamic, not string") on
// standalone and wasi. The gate now asks `dynamicCarrierForInHead`, so the
// refusal lands in the same `body-shape-rejected` arm family as a `switch`
// over a dynamic param. `captureKey` and `writeKey` were already refused;
// their arms are pinned here so the read-admission stays this narrow.
const REFUSED_HEAD_READS: ReadonlyArray<{
  readonly name: string;
  readonly arm: string;
  readonly expected: number;
  readonly source: string;
}> = [
  {
    name: "switchKey",
    arm: "switch-disc-not-string-carrier",
    expected: 12,
    source: `
      /** @param {object} o */
      function switchKey(o) {
        var n = 0;
        for (var k in o) { switch (k) { case "b": n = n + 10; break; default: n = n + 1; } }
        return n;
      }
      export function probe(): number { var o: any = { a: 1, b: 2, c: 3 }; return switchKey(o); }
    `,
  },
  {
    name: "captureKey",
    arm: "forin-head-value-captured",
    expected: 6,
    source: `
      /** @param {object} o */
      function captureKey(o) {
        var n = 0;
        for (var k in o) { var g = function () { return k.length; }; n = n + g(); }
        return n;
      }
      export function probe(): number { var o: any = { a: 1, bb: 2, ccc: 3 }; return captureKey(o); }
    `,
  },
  {
    name: "writeKey",
    arm: "forin-head-value-written",
    expected: 3,
    source: `
      /** @param {object} o */
      function writeKey(o) {
        var n = 0;
        for (var k in o) { k = "x"; n = n + k.length; }
        return n;
      }
      export function probe(): number { var o: any = { a: 1, b: 2, c: 3 }; return writeKey(o); }
    `,
  },
];

const COMPILE_OPTIONS = {
  experimentalIR: true,
  skipSemanticDiagnostics: true,
  allowJs: true,
  fileName: "issue-7106-isenumerable.ts",
  trackIrOutcomes: true,
} as const;

async function compileProbe(source: string, target?: "standalone" | "wasi"): Promise<CompileResult> {
  const result = await compile(source, { ...(target ? { target } : {}), ...COMPILE_OPTIONS } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

// The reject-arm label (`detail`) is recorded only under
// `JS2WASM_IR_SHAPE_DIAG=1`, which the selector reads once at module load —
// so, as in tests/issue-2856-shape-attribution.test.ts, the flag is set and the
// compiler re-imported for the refusal cases; the static `compile` above is
// untouched. Production output does not depend on the flag.
async function compileWithShapeDiag(source: string, target?: "standalone"): Promise<CompileResult> {
  const previous = process.env.JS2WASM_IR_SHAPE_DIAG;
  process.env.JS2WASM_IR_SHAPE_DIAG = "1";
  vi.resetModules();
  try {
    const { compile: compileDiag } = await import("../src/index.js");
    const result = await compileDiag(source, { ...(target ? { target } : {}), ...COMPILE_OPTIONS } as never);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    return result;
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_SHAPE_DIAG");
    else process.env.JS2WASM_IR_SHAPE_DIAG = previous;
    vi.resetModules();
  }
}

function irBodies(result: CompileResult): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.kind === "emitted" && o.irBodyEmitted).map((o) => o.displayName);
}

function nodeProbe(source: string): unknown {
  const js = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const exports: Record<string, () => unknown> = {};
  new Function("exports", js)(exports);
  return exports.probe!();
}

async function wasmProbe(result: CompileResult): Promise<unknown> {
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return (instance.exports.probe as () => number)();
}

describe("#7106 propertyHelper — for-in head as a dynamic carrier", () => {
  for (const lane of ["standalone", "gc"] as const) {
    const target = lane === "standalone" ? "standalone" : undefined;

    it(`${lane}: propertyHelper's isEnumerable ships an IR body and answers like node`, async () => {
      const result = await compileProbe(IS_ENUMERABLE, target);
      expect(irBodies(result)).toContain("isEnumerable");
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      const got = await wasmProbe(result);
      expect(got).toBe(nodeProbe(IS_ENUMERABLE));
      expect(got).toBe(511);
    });

    it(`${lane}: other head reads claim without a post-claim demotion and answer like node`, async () => {
      const result = await compileProbe(HEAD_SHAPES, target);
      expect(irBodies(result)).toEqual(expect.arrayContaining(["countLongKeys", "firstKey", "hasKey", "keyCount"]));
      expect(irBodies(result)).not.toContain("joinKeys");
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      const got = await wasmProbe(result);
      expect(got).toBe(nodeProbe(HEAD_SHAPES));
      expect(got).toBe(63);
    });
  }

  for (const lane of ["standalone", "gc"] as const) {
    const target = lane === "standalone" ? "standalone" : undefined;
    for (const shape of REFUSED_HEAD_READS) {
      it(`${lane}: ${shape.name} is refused before the claim (${shape.arm}) and answers like node`, async () => {
        const result = await compileWithShapeDiag(shape.source, target);
        const outcome = (result.irOutcomes ?? []).find((o) => o.displayName === shape.name);
        expect(outcome).toMatchObject({
          kind: "unsupported",
          stage: "select",
          code: "body-shape-rejected",
          irBodyEmitted: false,
        });
        expect((outcome as { detail?: string } | undefined)?.detail).toMatch(new RegExp(`^${shape.arm}:`));
        expect(result.irPostClaimErrors ?? []).toEqual([]);
        const got = await wasmProbe(result);
        expect(got).toBe(nodeProbe(shape.source));
        expect(got).toBe(shape.expected);
      });
    }
  }

  it("wasi: the switch over a for-in head is refused before the claim, not demoted at build", async () => {
    const result = await compileProbe(REFUSED_HEAD_READS[0]!.source, "wasi");
    expect(irBodies(result)).not.toContain("switchKey");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("wasi: isEnumerable ships an IR body and validates", async () => {
    const result = await compileProbe(IS_ENUMERABLE, "wasi");
    expect(irBodies(result)).toContain("isEnumerable");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });
});
