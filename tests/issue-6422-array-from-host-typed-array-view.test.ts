// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6422) `Array.from(new Uint8Array(<buffer>))` trapped with `illegal cast`.
//
// The `Array.from` array-copy fast path in
// `src/codegen/expressions/call-builtin-static.ts` picked its carrier from the
// CHECKER type: a declared/inferred `Uint8Array` resolves to a `$Vec`, so the
// arm compiled the argument and `local.set` it into a `ref null $Vec` local
// without ever looking at what the argument actually lowered to. Two carriers
// are not that `$Vec`:
//
//  * JS-host lane, UNTYPED buffer — `hostTaBufferArgSymName` answers
//    `"dynamic"` for an `any` argument, so `emitHostTaBufferConstruct` builds a
//    REAL host `Uint8Array` through `__construct_closure` and returns
//    **externref**.
//  * both lanes, a compiled `ArrayBuffer` — `new Uint8Array(buf)` builds the
//    shared-backing `$__ta_view` STRUCT (#3054), not a `$Vec`.
//
// Either way the store is a validation mismatch that `repairStructTypeMismatches`
// silently papered over with `any.convert_extern; ref.cast_null $Vec` — and
// neither carrier is a `$Vec`, so the cast TRAPPED. Measured on the parent
// (7adc0a6e89), both lanes:
//
//   host   arrayFromView(hostAb)  → RuntimeError: illegal cast   (node: 32)
//   stand. arrayFromViewLen()     → RuntimeError: illegal cast   (node: 32)
//
// The standalone half CONTRADICTS this issue's implementation plan, which
// recorded standalone as "measured 32, no trap, no change needed". It traps
// there too, for the `$__ta_view` reason the issue text originally guessed.
//
// The fix is transactional, at the one site: probe-compile the argument under
// `snapshotSpeculative`, commit the `array.copy` lowering only when the
// argument really is this vec — with the `$__ta_view` carrier first de-viewed
// into one via `emitTaViewToVec` (#3054 B1, the same materialization the
// TypedArray prototype methods take) — and otherwise roll back into the
// existing native/host `Array.from` fallback, which reads a host typed array
// correctly. No cast is widened.
//
// Anti-vacuity is explicit and load-bearing: `Array.from` over a plain array,
// over a compiled `new Uint8Array([…])` carrier, and over a HOST typed array
// arriving through an `any` parameter must all keep their existing answers, and
// the compiled-carrier case must still take the `array.copy` fast path (asserted
// against the emitted WAT) rather than having been widened into the fallback.

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

// Untyped package half — `buf` and `ta` are `any` to the checker, exactly like
// the `crypto.subtle.sign` result that found this in a dogfood probe.
const MOD = `export function arrayFromView(buf) {
  return Array.from(new Uint8Array(buf)).length;
}

export function arrayFromViewSum(buf) {
  const a = Array.from(new Uint8Array(buf));
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

export function arrayFromBoundView(buf) {
  const v = new Uint8Array(buf);
  return Array.from(v).length;
}

export function arrayFromPlain() {
  return Array.from([1, 2, 3]).length;
}

export function arrayFromCompiledTa() {
  return Array.from(new Uint8Array([1, 2, 3, 4])).length;
}

export function arrayFromHostTa(ta) {
  return Array.from(ta).length;
}

export function viewLen(buf) {
  return new Uint8Array(buf).length;
}`;

const ENTRY = `import {
  arrayFromBoundView,
  arrayFromCompiledTa,
  arrayFromHostTa,
  arrayFromPlain,
  arrayFromView,
  arrayFromViewSum,
  viewLen,
} from "./mod.js";

const arrayFromView_ = arrayFromView as unknown as (buf: unknown) => number;
const arrayFromViewSum_ = arrayFromViewSum as unknown as (buf: unknown) => number;
const arrayFromBoundView_ = arrayFromBoundView as unknown as (buf: unknown) => number;
const arrayFromPlain_ = arrayFromPlain as unknown as () => number;
const arrayFromCompiledTa_ = arrayFromCompiledTa as unknown as () => number;
const arrayFromHostTa_ = arrayFromHostTa as unknown as (ta: unknown) => number;
const viewLen_ = viewLen as unknown as (buf: unknown) => number;

export function pViewLen(buf: unknown): number {
  return viewLen_(buf);
}
export function pArrayFromView(buf: unknown): number {
  return arrayFromView_(buf);
}
export function pArrayFromViewSum(buf: unknown): number {
  return arrayFromViewSum_(buf);
}
export function pArrayFromBoundView(buf: unknown): number {
  return arrayFromBoundView_(buf);
}
export function pArrayFromPlain(): number {
  return arrayFromPlain_();
}
export function pArrayFromCompiledTa(): number {
  return arrayFromCompiledTa_();
}
export function pArrayFromHostTa(ta: unknown): number {
  return arrayFromHostTa_(ta);
}`;

// Standalone half — no JS host, so the buffer is built by compiled code and
// `new Uint8Array(buf)` is unambiguously the `$__ta_view` carrier.
const STANDALONE = `export function arrayFromViewLen(): number {
  const buf = new ArrayBuffer(32);
  const fill = new Uint8Array(buf);
  for (let i = 0; i < 32; i++) fill[i] = 3;
  return Array.from(new Uint8Array(buf)).length;
}

export function arrayFromViewSum(): number {
  const buf = new ArrayBuffer(32);
  const fill = new Uint8Array(buf);
  for (let i = 0; i < 32; i++) fill[i] = 3;
  const a = Array.from(new Uint8Array(buf));
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return s;
}

export function arrayFromPlain(): number {
  return Array.from([1, 2, 3]).length;
}

export function arrayFromCompiledTaSum(): number {
  const a = Array.from(new Uint8Array([1, 2, 3, 4]));
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return s;
}`;

type Exports = {
  pViewLen: (buf: unknown) => unknown;
  pArrayFromView: (buf: unknown) => unknown;
  pArrayFromViewSum: (buf: unknown) => unknown;
  pArrayFromBoundView: (buf: unknown) => unknown;
  pArrayFromPlain: () => unknown;
  pArrayFromCompiledTa: () => unknown;
  pArrayFromHostTa: (ta: unknown) => unknown;
};

let cachedHost: Promise<{ exports: Exports; wat: string }> | undefined;

function hostLane(): Promise<{ exports: Exports; wat: string }> {
  cachedHost ??= (async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-6422-"));
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
      emitWat: true,
      deferTopLevelInit: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const imports = buildCompiledImports(result, getWebHostConstructors());
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    return {
      exports: wrapExports(instance, { signatures: result.exportSignatures }) as unknown as Exports,
      wat: result.wat ?? "",
    };
  })();
  return cachedHost;
}

/** A 32-byte HOST ArrayBuffer, every byte 3 — sum 96. */
function hostBuffer(): ArrayBuffer {
  const ab = new ArrayBuffer(32);
  new Uint8Array(ab).fill(3);
  return ab;
}

describe("#6422 Array.from over a buffer-backed typed-array view", () => {
  // (1) The defect. Each of these threw `RuntimeError: illegal cast` on the
  // parent; a trap, not a wrong number, so the assertion is on a real value.
  it("answers the buffer's byte length for Array.from(new Uint8Array(hostAb))", async () => {
    const { exports } = await hostLane();
    expect(Number(await exports.pArrayFromView(hostBuffer()))).toBe(32);
  });

  it("copies the buffer's CONTENTS, not just its length", async () => {
    const { exports } = await hostLane();
    expect(Number(await exports.pArrayFromViewSum(hostBuffer()))).toBe(96);
  });

  it("handles the bound-variable form (const v = new Uint8Array(buf); Array.from(v))", async () => {
    const { exports } = await hostLane();
    expect(Number(await exports.pArrayFromBoundView(hostBuffer()))).toBe(32);
  });

  // The view itself was never broken — pinned so a regression here is not
  // mistaken for the `Array.from` defect coming back.
  it("still reads the view's own length", async () => {
    const { exports } = await hostLane();
    expect(Number(await exports.pViewLen(hostBuffer()))).toBe(32);
  });

  // (2) Anti-vacuity — the three sources that already worked.
  it("still copies a plain array literal", async () => {
    const { exports } = await hostLane();
    expect(Number(await exports.pArrayFromPlain())).toBe(3);
  });

  it("still copies a compiled Uint8Array carrier", async () => {
    const { exports } = await hostLane();
    expect(Number(await exports.pArrayFromCompiledTa())).toBe(4);
  });

  it("still drains a HOST typed array arriving through an any parameter", async () => {
    const { exports } = await hostLane();
    expect(Number(await exports.pArrayFromHostTa(new Uint8Array([9, 9])))).toBe(2);
  });

  // (3) The fast path must survive: a fix that simply routed every
  // `Array.from` to the fallback would pass every assertion above.
  it("keeps the array.copy fast path for the compiled carrier", async () => {
    const { wat } = await hostLane();
    const start = wat.indexOf("(func $arrayFromCompiledTa");
    expect(start, "arrayFromCompiledTa not found in the emitted WAT").toBeGreaterThanOrEqual(0);
    const next = wat.indexOf("\n (func ", start + 1);
    const body = wat.slice(start, next < 0 ? undefined : next);
    expect(body).toContain("array.copy");
  });
});

describe("#6422 standalone lane — the $__ta_view carrier, no JS host", () => {
  let cached: Promise<Record<string, () => unknown>> | undefined;
  function standaloneLane(): Promise<Record<string, () => unknown>> {
    cached ??= (async () => {
      const root = mkdtempSync(join(tmpdir(), "js2-6422s-"));
      roots.push(root);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "entry.ts"), STANDALONE);
      const result = await compileProject(join(root, "entry.ts"), { target: "standalone", emitWat: false });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      const { instance } = await WebAssembly.instantiate(result.binary, {});
      (instance.exports as { __module_init?: () => void }).__module_init?.();
      return instance.exports as unknown as Record<string, () => unknown>;
    })();
    return cached;
  }

  // Trapped with `illegal cast` on the parent, exactly like the host lane.
  it("answers the buffer's byte length without a JS host", async () => {
    const exports = await standaloneLane();
    expect(Number(exports.arrayFromViewLen!())).toBe(32);
  });

  it("copies the view's element values, not NaN", async () => {
    const exports = await standaloneLane();
    expect(Number(exports.arrayFromViewSum!())).toBe(96);
  });

  // Anti-vacuity for the standalone lane.
  it("still copies a plain array literal", async () => {
    const exports = await standaloneLane();
    expect(Number(exports.arrayFromPlain!())).toBe(3);
  });

  it("still copies a compiled Uint8Array carrier with its values", async () => {
    const exports = await standaloneLane();
    expect(Number(exports.arrayFromCompiledTaSum!())).toBe(10);
  });
});
