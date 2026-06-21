// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2160 — `String.prototype.substr` (Annex B §B.2.2.1) was not lowered for
 * native-strings (standalone / WASI) mode. `compileNativeStringMethodCall`
 * handled `substring` and `slice` but had no `substr` branch, so the call
 * fell through and trapped with a null-pointer dereference at runtime.
 *
 * The fix adds a `__str_substr(s, start, length)` native WasmGC helper that
 * implements the Annex B clamp semantics — note `substr`'s second argument is
 * a CHAR COUNT, not an end index, and negative `start` counts from the end —
 * and a `substr` dispatch branch that passes an absent `length` as the
 * 0x7fffffff sentinel ("to the end").
 *
 * Every case is compiled into a SINGLE module (one export per case) so each
 * mode costs one `compile()` call. Standalone/WASI instantiate with an EMPTY
 * import object, proving no JS host is needed. Results are read back via a
 * deterministic rolling hash so the exact characters are verified, not just
 * the length.
 */

// Deterministic rolling hash, computed identically in JS and in the compiled
// module, so a mismatched character (not just length) fails the assertion.
function hash(s: string): number {
  let h = s.length * 1000003;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  }
  return h % 2000000000;
}

// [receiver, args] pairs spanning every Annex B edge: positive/negative start,
// absent length (to-end), length overflow, zero/negative length, start past
// the end, negative start past the front, empty receiver.
const CASES: ReadonlyArray<[string, ReadonlyArray<number>]> = [
  ["hello", [1, 3]],
  ["hello", [0, 2]],
  ["hello", [-2]],
  ["hello", [2]],
  ["hello", [-2, 1]],
  ["hello", [10]],
  ["hello", [-10, 2]],
  ["hello", [1, 100]],
  ["hello", [1, 0]],
  ["hello", [1, -1]],
  ["hi", []],
  ["abcdef", [2, 3]],
  ["abcdef", [-3, 2]],
  ["x", [0, 5]],
  ["", [0, 5]],
];

const fnName = (i: number) => `case${i}`;

const MODULE_SRC = CASES.map(
  ([s, args], i) => `export function ${fnName(i)}(): number {
    const s = ${JSON.stringify(s)}.substr(${args.join(",")});
    let h = s.length * 1000003;
    for (let j = 0; j < s.length; j++) { h = (Math.imul(h, 31) + s.charCodeAt(j)) >>> 0; }
    return (h % 2000000000);
  }`,
).join("\n");

function expectAll(ex: Record<string, () => number>, label: string): void {
  CASES.forEach(([s, args], i) => {
    const want = hash(String.prototype.substr.apply(s, args as number[]));
    expect(ex[fnName(i)]!(), `${label} ${JSON.stringify(s)}.substr(${args.join(",")})`).toBe(want);
  });
}

describe("#2160 String.prototype.substr — standalone (native strings)", () => {
  it("matches JS semantics for every clamp/negative edge (standalone)", async () => {
    const r = await compile(MODULE_SRC, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const labels = r.imports.map((im) => `${im.module}::${im.name}`);
    for (const re of [/^wasm:js-string::/, /^env::string_substr$/]) {
      expect(
        labels.filter((l) => re.test(l)),
        `leaked ${re}`,
      ).toEqual([]);
    }
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expectAll(instance.exports as Record<string, () => number>, "standalone");
  });

  it("matches JS semantics for every clamp/negative edge (WASI)", async () => {
    const r = await compile(MODULE_SRC, { target: "wasi" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expectAll(instance.exports as Record<string, () => number>, "WASI");
  });

  it("default (gc / JS-host) mode keeps correct substr", async () => {
    const r = await compile(MODULE_SRC, {});
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
    expectAll(instance.exports as Record<string, () => number>, "gc-mode");
  });
});
