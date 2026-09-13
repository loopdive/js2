// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6415) A host builtin read as a FIRST-CLASS VALUE, called from an untyped
// module, returned to a typed caller that declared `=> boolean`.
//
// The issue was filed against `ArrayBuffer.isView` on the JS-host lane:
//
//     // untyped mod.js
//     export function viaIsView(value) {
//       const f = ArrayBuffer.isView;   // value read, not a direct call
//       return f(value);
//     }
//
// `viaIsView(new Uint8Array(3))` answered false while the DIRECT spelling
// `ArrayBuffer.isView(new Uint8Array(3))` in the same module answered true
// (#5370 fixed the direct form). Measured on the parent, the defect is NOT
// isView-specific and NOT a property-read defect at all:
//
//   * The untyped callee is correct. `f(value) ? "view" : "not-view"` computed
//     INSIDE mod.js answers "view" on the parent — the value read reaches the
//     real host function and `__call_function`'s runtime already `_wrapForHost`s
//     every WasmGC argument.
//   * The value is lost at the TYPED CALLER. The untyped callee's Wasm
//     signature returns externref (it boxes through `__box_boolean`); the
//     `as unknown as (v) => boolean` call site expects the boolean-branded i32
//     this lane lowers `boolean` to. The funcref-ladder return bridge
//     (`scalarBridgePlan` in src/codegen/expressions/call-identifier.ts) had no
//     externref → boolean-i32 arm, so the LIVE arm fell into the dead-arm
//     placeholder `drop; i32.const 0`. WAT confirmed `call_ref N; drop;
//     i32.const 0`.
//
// So every host predicate read as a value answered false through such a
// caller. `Array.isArray` and `Object.is` are pinned below as witnesses that
// the defect is the boolean return bridge, not `ArrayBuffer.isView`.
//
// Shape details that are load-bearing for non-vacuity:
//
//   * The predicate must be read as a VALUE (`const f = X.pred`) in an UNTYPED
//     `.js` module. The direct call form is folded / routed differently and
//     never reproduced.
//   * The compiled functions return STRINGS. A compiled `boolean` comes back
//     over this lane as the i32 it is lowered to, which would make a
//     `toBe(true)` assertion fail for reasons unrelated to the defect.
//   * `viaTernary` is the CONTROL: `return f(value) ? true : false` gives the
//     callee an i32 return, so no bridge is needed and it passed on the parent.
//     If it ever fails, the fixture stopped exercising the bridge.
//
// Anti-vacuity is explicit: a plain array literal must still read as a
// non-view, a typed-array carrier must still read as a non-Array, and
// `Object.is(1, 2)` must still be false. A "bridge" that answered a constant
// true would fail all three.
//
// Measured counts: 4 fail / 5 pass on the parent; 9 / 9 with the fix.
//
// NOT in scope: `ArrayBuffer.isView(new DataView(...))` answers false on this
// HEAD in the DIRECT spelling too — a separate pre-existing defect tracked as
// #6433. The DataView case below therefore asserts only that the two spellings
// AGREE, which is what this change owns.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports, wrapExports } from "../src/runtime.js";
import { getWebHostConstructors } from "../src/runtime/web-host-constructors.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

// Untyped package half — every value here is `any` to the checker.
const MOD = `export function hostBytes(text) {
  return new TextEncoder().encode(text);
}

export function viaIsView(value) {
  const f = ArrayBuffer.isView;
  return f(value);
}

export function viaIsArray(value) {
  const f = Array.isArray;
  return f(value);
}

export function viaObjectIs(a, b) {
  const f = Object.is;
  return f(a, b);
}

export function viaTernary(value) {
  const f = ArrayBuffer.isView;
  return f(value) ? true : false;
}

export function directIsView(value) {
  return ArrayBuffer.isView(value);
}

export function makeDataView() {
  return new DataView(new ArrayBuffer(8));
}`;

const ENTRY = `import {
  directIsView,
  hostBytes,
  makeDataView,
  viaIsArray,
  viaIsView,
  viaObjectIs,
  viaTernary,
} from "./mod.js";

const hostBytes_ = hostBytes as unknown as (text: string) => Uint8Array;
const viaIsView_ = viaIsView as unknown as (value: unknown) => boolean;
const viaIsArray_ = viaIsArray as unknown as (value: unknown) => boolean;
const viaObjectIs_ = viaObjectIs as unknown as (a: unknown, b: unknown) => boolean;
const viaTernary_ = viaTernary as unknown as (value: unknown) => boolean;
const directIsView_ = directIsView as unknown as (value: unknown) => boolean;
const makeDataView_ = makeDataView as unknown as () => unknown;

export function isViewOfCompiledCarrier(): string {
  const bytes = new Uint8Array(3);
  return viaIsView_(bytes) ? "view" : "not-view";
}

export function isViewOfHostCarrier(): string {
  const bytes = hostBytes_("abc");
  return viaIsView_(bytes) ? "view" : "not-view";
}

export function isViewOfPlainArray(): string {
  const values = [1, 2, 3];
  return viaIsView_(values) ? "view" : "not-view";
}

export function isArrayOfPlainArray(): string {
  const values = [1, 2, 3];
  return viaIsArray_(values) ? "yes" : "no";
}

export function isArrayOfCompiledCarrier(): string {
  const bytes = new Uint8Array(3);
  return viaIsArray_(bytes) ? "yes" : "no";
}

export function objectIsSameValue(): string {
  return viaObjectIs_(1, 1) ? "yes" : "no";
}

export function objectIsDifferentValue(): string {
  return viaObjectIs_(1, 2) ? "yes" : "no";
}

export function ternaryOfCompiledCarrier(): string {
  const bytes = new Uint8Array(3);
  return viaTernary_(bytes) ? "view" : "not-view";
}

export function dataViewViaValue(): string {
  return viaIsView_(makeDataView_()) ? "view" : "not-view";
}

export function dataViewDirect(): string {
  return directIsView_(makeDataView_()) ? "view" : "not-view";
}`;

type Exports = {
  isViewOfCompiledCarrier: () => unknown;
  isViewOfHostCarrier: () => unknown;
  isViewOfPlainArray: () => unknown;
  isArrayOfPlainArray: () => unknown;
  isArrayOfCompiledCarrier: () => unknown;
  objectIsSameValue: () => unknown;
  objectIsDifferentValue: () => unknown;
  ternaryOfCompiledCarrier: () => unknown;
  dataViewViaValue: () => unknown;
  dataViewDirect: () => unknown;
};

let cached: Promise<Exports> | undefined;

function compiled(): Promise<Exports> {
  cached ??= (async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-6415-"));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "mod.js"), MOD);
    writeFileSync(join(root, "entry.ts"), ENTRY);
    const result = await compileProject(join(root, "entry.ts"), {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "web",
      experimentalIR: true,
      emitWat: false,
      deferTopLevelInit: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const imports = buildCompiledImports(result, getWebHostConstructors());
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    return wrapExports(instance, { signatures: result.exportSignatures }) as unknown as Exports;
  })();
  return cached;
}

describe("#6415 a host predicate read as a value keeps its boolean crossing back to a typed caller", () => {
  // --- The four that FAILED on the parent (answered the dropped default). ---

  it("answers view for a COMPILED typed-array carrier through the value read", async () => {
    const exports = await compiled();
    expect(exports.isViewOfCompiledCarrier()).toBe("view");
  });

  it("answers view for a HOST-built typed array through the value read", async () => {
    const exports = await compiled();
    expect(exports.isViewOfHostCarrier()).toBe("view");
  });

  it("answers yes for Array.isArray read as a value (same bridge, different builtin)", async () => {
    const exports = await compiled();
    expect(exports.isArrayOfPlainArray()).toBe("yes");
  });

  it("answers yes for Object.is(1, 1) read as a value (two-argument witness)", async () => {
    const exports = await compiled();
    expect(exports.objectIsSameValue()).toBe("yes");
  });

  // --- Anti-vacuity: these were already correct and must stay correct. ---

  it("still answers not-view for a plain array literal", async () => {
    const exports = await compiled();
    expect(exports.isViewOfPlainArray()).toBe("not-view");
  });

  it("still answers no for Array.isArray of a typed-array carrier", async () => {
    const exports = await compiled();
    expect(exports.isArrayOfCompiledCarrier()).toBe("no");
  });

  it("still answers no for Object.is(1, 2)", async () => {
    const exports = await compiled();
    expect(exports.objectIsDifferentValue()).toBe("no");
  });

  // --- Control: an i32-returning callee needs no bridge and passed on the parent. ---

  it("keeps the ternary-return control answering view", async () => {
    const exports = await compiled();
    expect(exports.ternaryOfCompiledCarrier()).toBe("view");
  });

  // --- Scope boundary: the two spellings agree, whatever the shared answer. ---

  it("makes the value read and the direct call agree for a DataView (#6433 owns the shared answer)", async () => {
    const exports = await compiled();
    expect(exports.dataViewViaValue()).toBe(exports.dataViewDirect());
  });
});
