// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, compileMulti } from "../src/index.js";

/**
 * #6651 N2 — `instanceof Object` over a NULL-PROTOTYPE object.
 *
 * §10.4.6.1 pins a module namespace object's [[GetPrototypeOf]] to `null`, so
 * §7.3.20's prototype-chain walk never reaches `%Object.prototype%` and
 * `ns instanceof Object` is `false`. Two independent defects answered `true`:
 *
 * 1. **The static fold** (`tryStaticInstanceOf`, `expressions/identifiers.ts`)
 *    short-circuits `<obj> instanceof Object` to `true` for every LHS carrying
 *    the TS `Object` type flag. A module namespace binding carries it. This
 *    fired on BOTH targets — the N1 handoff records the row as standalone-only,
 *    which is wrong; measured on the base sources, `namespace/internals/
 *    get-prototype-of.js` failed the same assertion on host.
 * 2. **The standalone native predicate**
 *    (`native-object-family-instanceof.ts`) answers "not a primitive", which is
 *    `true` for a null-prototype object. Its module header recorded this as an
 *    accepted divergence needing "a runtime handle on `Object.prototype`"; it
 *    does not — the runtime already marks an EXPLICIT null prototype with
 *    `OBJ_FLAG_NULL_PROTO`.
 *
 * Both are covered here because either one alone still answers `true`: revert
 * `identifiers.ts` and the typed-`ns` case goes back to `true` on both lanes;
 * revert `native-object-family-instanceof.ts` and the `Object.create(null)`
 * case goes back to `true` on standalone.
 */
const SELF_IMPORT_MODULE = `
export var local1 = 23;

import * as ns from "./self.js";

export function test(): number {
  let score = 0;
  // The typed binding — this is the arm the static fold owned.
  if ((ns instanceof Object) === false) score += 1;
  // …and through \`any\`, which reaches the runtime/native predicate instead.
  if (((ns as any) instanceof Object) === false) score += 2;
  // §10.4.6.1 itself, already true before this slice — kept so a regression
  // here cannot be mistaken for an instanceof regression.
  if (Object.getPrototypeOf(ns as any) === null) score += 4;
  return score;
}
`;

const NULL_PROTO_PROGRAM = `
const nullProto: any = Object.create(null);
const plain: any = {};
export function test(): number {
  let score = 0;
  if ((nullProto instanceof Object) === false) score += 1;
  // The complement: an ORDINARY object must keep answering true. A predicate
  // that answers false for everything would pass the line above.
  if ((plain instanceof Object) === true) score += 2;
  return score;
}
`;

async function runModule(target: "gc" | "standalone"): Promise<number> {
  const result = await compileMulti({ "./self.js": SELF_IMPORT_MODULE }, "./self.js", {
    allowJs: true,
    skipSemanticDiagnostics: true,
    emitWat: false,
    target,
  } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = (result.importObject ?? {}) as Record<string, unknown>;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports as never);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports.test as () => number)();
}

async function runProgram(target: "gc" | "standalone"): Promise<number> {
  const result = await compile(NULL_PROTO_PROGRAM, { fileName: "null-proto.ts", target });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = (result.importObject ?? {}) as Record<string, unknown>;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports as never);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports.test as () => number)();
}

describe("#6651 N2 instanceof Object over a null-prototype object", () => {
  it("answers false for a module namespace object on the JS-host lane", async () => {
    expect(await runModule("gc")).toBe(1 | 2 | 4);
  });

  it("answers false for a module namespace object on the standalone lane", async () => {
    expect(await runModule("standalone")).toBe(1 | 2 | 4);
  });

  it("answers false for Object.create(null) and true for {} on the JS-host lane", async () => {
    expect(await runProgram("gc")).toBe(1 | 2);
  });

  it("answers false for Object.create(null) and true for {} on the standalone lane", async () => {
    expect(await runProgram("standalone")).toBe(1 | 2);
  });
});
