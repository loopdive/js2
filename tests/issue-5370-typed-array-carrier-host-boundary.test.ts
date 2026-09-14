// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5370) Typed-array carrier fidelity at the host boundary, INBOUND.
//
// #5362/#5675 fixed the outbound direction: `_wrapForHost` honours the
// `__register_typed_array` brand, so a carrier built by compiled code reaches a
// host API as a real `Uint8Array`. Two inbound defects survived that fix and
// are what this test pins:
//
//  1. `ArrayBuffer.isView(x)` answered `false` for a carrier reaching the check
//     through an UNTYPED (`any`) parameter — in both directions. The host
//     import `__arraybuffer_isView` receives the argument as the RAW WasmGC
//     struct (`extern.convert_any`, no marshalling), and `ArrayBuffer.isView`
//     of an opaque struct is `false` whatever the struct holds. The statically
//     typed form (`ArrayBuffer.isView(new Uint8Array(3))` where the checker
//     knows the type) never reproduced: codegen answers that one at compile
//     time.
//
//  2. A HOST-built typed array lost its brand crossing IN. A compiled function
//     whose declared return type is `Uint8Array` narrows the host value into a
//     fresh `$Vec`; nothing recorded that the source was a typed array, so the
//     carrier was indistinguishable from `[1,2,3]` and the next crossing out
//     re-emitted a plain `Array`. Measured on the parent:
//     `new TextEncoder().encode("abc")` returned through such a function read
//     back as `constructor.name === "Array"` and as a non-view at the host.
//
// The third defect recorded in #5370 — `new Uint8Array(<host typed array>)`
// building an EMPTY carrier — was already repaired by #5675's follow-up
// (measured green on the parent). The two cases below keep it pinned rather
// than asserting a fix this change makes.
//
// Shape details that are load-bearing for non-vacuity, learned by measurement:
//
//  * The compiled functions return STRINGS, not booleans: this lane hands a
//    compiled `boolean` back as the i32 `1`/`0` it is lowered to, which would
//    make a `toBe(true)` assertion fail for a reason that has nothing to do
//    with the defect. The string names the branch compiled code actually took.
//  * The `isView` / `.constructor` read must happen in an UNTYPED `.js` module
//    behind an `any` parameter. With a static `Uint8Array` type the compiler
//    folds the answer and the defect does not appear.
//  * The host-built typed array must be produced by an untyped function whose
//    INFERRED return type is `Uint8Array` — that annotation is what makes
//    codegen narrow the host externref into a vec. Handing the same value
//    straight to another host call never crosses.
//  * The lane mirrors the dogfood worker (`deferTopLevelInit`, web platform,
//    `buildCompiledImports` + `wrapExports`), as #5362 established.
//
// Anti-vacuity is explicit: a plain array literal travelling the exact same
// routes must still read as a non-view whose constructor is `Array`. A fix that
// branded every vec would fail those two cases.

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

// Untyped package half — every value here is `any` to the checker, exactly like
// hono's published `dist/utils/cookie.js`. `hostBytes` carries no annotation,
// so its INFERRED `Uint8Array` return is what forces the inbound narrowing.
const MOD = `export function hostBytes(text) {
  return new TextEncoder().encode(text);
}

export function isViewOf(value) {
  return ArrayBuffer.isView(value);
}

export function ctorNameOf(value) {
  return value.constructor.name;
}

export function describeValue(probe, value) {
  return probe.describe(value);
}

export function copyOf(value) {
  const copy = new Uint8Array(value);
  return copy.length + ":" + copy[0] + ":" + copy[copy.length - 1];
}`;

const ENTRY = `import { copyOf, ctorNameOf, describeValue, hostBytes, isViewOf } from "./mod.js";

const hostBytes_ = hostBytes as unknown as (text: string) => Uint8Array;
const isViewOf_ = isViewOf as unknown as (value: unknown) => boolean;
const ctorNameOf_ = ctorNameOf as unknown as (value: unknown) => string;
const describe_ = describeValue as unknown as (probe: unknown, value: unknown) => string;
const copyOf_ = copyOf as unknown as (value: unknown) => string;

export function isViewOfCompiledCarrier(): string {
  const bytes = new Uint8Array(3);
  return isViewOf_(bytes) ? "view" : "not-view";
}

export function isViewOfHostCarrier(): string {
  const bytes = hostBytes_("abc");
  return isViewOf_(bytes) ? "view" : "not-view";
}

export function isViewOfPlainArray(): string {
  const values = [1, 2, 3];
  return isViewOf_(values) ? "view" : "not-view";
}

export function ctorNameOfHostCarrier(): string {
  const bytes = hostBytes_("abc");
  return ctorNameOf_(bytes);
}

export function ctorNameOfPlainArray(): string {
  const values = [1, 2, 3];
  return ctorNameOf_(values);
}

export function shapeOfHostCarrierAtHost(probe: unknown): string {
  const bytes = hostBytes_("abc");
  return describe_(probe, bytes);
}

export function shapeOfPlainArrayAtHost(probe: unknown): string {
  const values = [1, 2, 3];
  return describe_(probe, values);
}

export function contentsOfHostCarrier(): string {
  const bytes = hostBytes_("abc");
  return bytes.length + ":" + bytes[0] + ":" + bytes[2];
}

export function copyOfHostCarrier(): string {
  const bytes = hostBytes_("hello");
  return copyOf_(bytes);
}

export function copyOfPlainArray(): string {
  const values = [7, 8, 9];
  return copyOf_(values);
}`;

/** Host-side observer: what did the compiled value actually arrive as? */
const probe = {
  describe(value: unknown): string {
    if (ArrayBuffer.isView(value)) return `view:${(value as object).constructor.name}`;
    if (Array.isArray(value)) return "array";
    return `other:${typeof value}`;
  },
};

type Exports = {
  isViewOfCompiledCarrier: () => unknown;
  isViewOfHostCarrier: () => unknown;
  isViewOfPlainArray: () => unknown;
  ctorNameOfHostCarrier: () => unknown;
  ctorNameOfPlainArray: () => unknown;
  shapeOfHostCarrierAtHost: (probe: unknown) => unknown;
  shapeOfPlainArrayAtHost: (probe: unknown) => unknown;
  contentsOfHostCarrier: () => unknown;
  copyOfHostCarrier: () => unknown;
  copyOfPlainArray: () => unknown;
};

let cached: Promise<Exports> | undefined;

function compiled(): Promise<Exports> {
  cached ??= (async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-5370-"));
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

describe("#5370 typed-array carriers stay typed arrays crossing INTO compiled code", () => {
  // (1) isView through an untyped `any` parameter — both directions.
  it("answers true for a COMPILED carrier reaching isView through an any parameter", async () => {
    const exports = await compiled();
    expect(String(await exports.isViewOfCompiledCarrier())).toBe("view");
  });

  it("answers true for a HOST-built typed array reaching isView through an any parameter", async () => {
    const exports = await compiled();
    expect(String(await exports.isViewOfHostCarrier())).toBe("view");
  });

  // Anti-vacuity for (1): the same route, an ordinary array. A fix that made
  // every opaque carrier read as a view would fail here.
  it("still answers false for a plain array reaching isView through the same route", async () => {
    const exports = await compiled();
    expect(String(await exports.isViewOfPlainArray())).toBe("not-view");
  });

  // (2) the brand survives the inbound narrowing.
  it("keeps a host typed array's constructor after it is narrowed into a carrier", async () => {
    const exports = await compiled();
    expect(String(await exports.ctorNameOfHostCarrier())).toBe("Uint8Array");
  });

  // Anti-vacuity for (2).
  it("still reports Array for a plain array on the same route", async () => {
    const exports = await compiled();
    expect(String(await exports.ctorNameOfPlainArray())).toBe("Array");
  });

  it("re-emits a narrowed host typed array to the host as a typed array", async () => {
    const exports = await compiled();
    expect(String(await exports.shapeOfHostCarrierAtHost(probe))).toBe("view:Uint8Array");
  });

  // Anti-vacuity for the outbound half.
  it("still re-emits a plain array to the host as a plain array", async () => {
    const exports = await compiled();
    expect(String(await exports.shapeOfPlainArrayAtHost(probe))).toBe("array");
  });

  // The brand must not cost the bytes: element type and contents are the point.
  it("keeps the narrowed carrier's length and element values", async () => {
    const exports = await compiled();
    expect(String(await exports.contentsOfHostCarrier())).toBe("3:97:99");
  });

  // (3) already green on the parent (#5675 follow-up) — pinned, not claimed.
  it("builds a populated carrier from a host typed array", async () => {
    const exports = await compiled();
    expect(String(await exports.copyOfHostCarrier())).toBe("5:104:111");
  });

  it("builds a populated carrier from a plain array", async () => {
    const exports = await compiled();
    expect(String(await exports.copyOfPlainArray())).toBe("3:7:9");
  });
});
