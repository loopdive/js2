// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2160 — standalone recovery of a primitive-wrapper object's internal
 * [[PrimitiveValue]] slot.
 *
 * #1910 S2 built the native `__new_String` / `__new_Number` constructors (a
 * `$Object` carrying the primitive under the reserved FLAG_INTERNAL slot) and
 * taught the native `__to_primitive` to read that slot first. But two consumer
 * paths still leaked / broke in `--target standalone`:
 *
 *   1. `resolveWasmType` resolved a `String`-WRAPPER-typed binding to
 *      `$AnyString` (because `isStringType` deliberately also matches the wrapper
 *      for primitive-string method dispatch), so the wrapper `$Object` externref
 *      was ref.cast to `$AnyString` on bind, failed, and became NULL — every
 *      downstream read then null-deref'd.
 *   2. `new String(x).valueOf()` leaked the unsatisfiable `env::__unbox_string`
 *      host import; `new String(x).toString()` fell through and trapped.
 *
 * Fix: exclude the String wrapper from the `nativeStrings` string fast-path in
 * `resolveWasmType` (it falls through to the externref wrapper branch), and route
 * the String/Number wrapper `.valueOf()`/`.toString()` accessors through the
 * native `__to_primitive` (§7.1.1.1) instead of the host `__unbox_string` /
 * primitive-recompile paths.
 *
 * Results are verified by content (rolling hash / numeric value), not just by
 * "did it run", and the standalone module is instantiated with an EMPTY import
 * object so any host-import leak fails instantiation.
 */

// Deterministic rolling hash, computed identically in JS and the compiled module.
function hash(s: string): number {
  let h = s.length * 1000003;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  }
  return h % 2000000000;
}

// String-wrapper value-recovery cases. Each returns a rolling hash of the
// recovered primitive string so the exact characters are checked.
const STRING_CASES: ReadonlyArray<[string, string]> = [
  ["valueOf", `const w = new String("hello"); const s = w.valueOf();`],
  ["toString", `const w = new String("world"); const s = w.toString();`],
  ["valueOf empty", `const w = new String(""); const s = w.valueOf();`],
  ["valueOf then method", `const w = new String("Abc"); const s = w.valueOf().toUpperCase();`],
];

const strFn = (i: number) => `str${i}`;
const STRING_MODULE = STRING_CASES.map(
  ([, body], i) => `export function ${strFn(i)}(): number {
    ${body}
    let h = s.length * 1000003;
    for (let j = 0; j < s.length; j++) { h = (Math.imul(h, 31) + s.charCodeAt(j)) >>> 0; }
    return (h % 2000000000);
  }`,
).join("\n");

const STRING_EXPECTED = [hash("hello"), hash("world"), hash(""), hash("ABC")];

// Number-wrapper .valueOf() cases — recovers the f64 primitive.
const NUMBER_MODULE = `
  export function num0(): number { const n = new Number(42); return n.valueOf(); }
  export function num1(): number { const n = new Number(3.5); return n.valueOf() * 2; }
  export function num2(): number { const n = new Number(7); return n.valueOf() === 7 ? 1 : 0; }
  export function num3(): number { const n = new Number(-10); return n.valueOf() + 5; }
`;
const NUMBER_EXPECTED: Record<string, number> = { num0: 42, num1: 7, num2: 1, num3: -5 };

describe("#2160 primitive-wrapper valueOf/toString — standalone (native strings)", () => {
  it("String wrapper valueOf/toString recovers the primitive (standalone, no host leak)", async () => {
    const r = await compile(STRING_MODULE, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // No leaked host import for the wrapper value-recovery paths.
    const labels = r.imports.map((im) => `${im.module}::${im.name}`);
    for (const re of [/^env::__unbox_string$/, /^env::__new_String$/, /^wasm:js-string::/]) {
      expect(
        labels.filter((l) => re.test(l)),
        `leaked ${re}`,
      ).toEqual([]);
    }
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    STRING_EXPECTED.forEach((want, i) => {
      expect(ex[strFn(i)]!(), `standalone ${STRING_CASES[i]![0]}`).toBe(want);
    });
  });

  it("Number wrapper valueOf recovers the primitive (standalone, no host leak)", async () => {
    const r = await compile(NUMBER_MODULE, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const labels = r.imports.map((im) => `${im.module}::${im.name}`);
    expect(
      labels.filter((l) => /^env::__new_Number$/.test(l)),
      "leaked env::__new_Number",
    ).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    for (const [fn, want] of Object.entries(NUMBER_EXPECTED)) {
      expect(ex[fn]!(), `standalone ${fn}`).toBe(want);
    }
  });

  // gc / JS-host mode is untouched by this fix (the resolveWasmType change is
  // `nativeStrings`-gated and the calls.ts path is `ctx.standalone`-gated). This
  // guard proves the default backend still compiles the wrapper accessors.
  // (WASI wrapper valueOf is a pre-existing separate gap — the native object
  // runtime is standalone-only — and is intentionally out of this slice's scope.)
  it("default (gc / JS-host) mode still compiles wrapper valueOf/toString", async () => {
    const rStr = await compile(STRING_MODULE, {});
    expect(rStr.success, rStr.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance: si } = await WebAssembly.instantiate(rStr.binary, rStr.importObject);
    const sx = si.exports as Record<string, () => number>;
    STRING_EXPECTED.forEach((want, i) => {
      expect(sx[strFn(i)]!(), `gc ${STRING_CASES[i]![0]}`).toBe(want);
    });

    const rNum = await compile(NUMBER_MODULE, {});
    expect(rNum.success, rNum.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance: ni } = await WebAssembly.instantiate(rNum.binary, rNum.importObject);
    const nx = ni.exports as Record<string, () => number>;
    for (const [fn, want] of Object.entries(NUMBER_EXPECTED)) {
      expect(nx[fn]!(), `gc ${fn}`).toBe(want);
    }
  });
});
