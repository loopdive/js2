import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2542 — standalone dynamic property read/write by a RUNTIME string key (`o[k]`).
 *
 * Under `--target standalone --nativeStrings`, reading or writing an object
 * property by a runtime string *variable* key — `o[k]` where `k` is a `string`
 * local, not a compile-time literal — failed when the object was typed by a
 * STRING INDEX SIGNATURE (`{ [s: string]: number }`). The read returned the
 * element-type default (0) and the write did not persist.
 *
 * Root cause: an index-signature-typed literal `{ a: 5, b: 7 }` was lowered to a
 * closed nominal WasmGC `struct`, then `extern.convert_any`-wrapped to externref.
 * The native `__extern_get`'s `ref.test $Object` could not match the closed struct,
 * so `o[k]` returned null → 0. Separately, the index-signature TYPE itself resolved
 * to an EMPTY WasmGC struct for params/returns (its `getProperties()` is empty), so
 * a `$Object` argument guard-cast to null at the call boundary.
 *
 * Fix (mirrors #1901's open-`$Object` routing):
 *   - `compileObjectLiteral` builds an index-signature-typed literal as an open
 *     `$Object` (so reads/writes route through the native `__extern_get/_set`).
 *   - `resolveWasmType` lowers a PURE string-index-signature type (anonymous,
 *     `type`-alias, or `interface`, with no own named properties) to externref —
 *     so the binding/param/return is a `$Object` end to end.
 *   - `ensureStructForType` skips registering such a type as an empty struct.
 *
 * These tests assert BEHAVIOR (correct value) + zero host-object-import leak +
 * valid module, independent of the fix mechanism. Mirrors issue-1901.test.ts.
 */

// Any leaked env::__extern_*/__object_*/__new_plain_object/__get_builtin/
// __proto_method_call/__to_primitive under standalone is a failure.
const BANNED = [
  /^env::__extern_/,
  /^env::__object_/,
  /^env::__new_plain_object/,
  /^env::__get_builtin/,
  /^env::__proto_method_call/,
  /^env::__to_primitive/,
  /^env::__hasOwnProperty/,
];
function assertNoHostObjectImports(imports: ReadonlyArray<{ module: string; name: string }>): void {
  const labels = imports.map((i) => `${i.module}::${i.name}`);
  for (const re of BANNED) {
    const hits = labels.filter((l) => re.test(l));
    expect(hits, `--target standalone leaked ${re} (got ${hits.join(", ")})`).toEqual([]);
  }
}
type NumExports = Record<string, () => number>;

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  assertNoHostObjectImports(r.imports);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as NumExports).run();
}

describe("#2542 — standalone dynamic property read/write by runtime string key", () => {
  it("headline: index-signature object read by runtime key reads the real value", async () => {
    const v = await runStandalone(
      `export function run(): number {
         const o: { [s: string]: number } = { a: 5, b: 7 };
         let k = "a";
         return o[k];
       }`,
    );
    expect(v).toBe(5);
  });

  it("write by runtime key persists (read back via static member)", async () => {
    const v = await runStandalone(
      `export function run(): number {
         const o: { [s: string]: number } = { a: 5, b: 7 };
         let k = "b";
         o[k] = 42;
         return o.b;
       }`,
    );
    expect(v).toBe(42);
  });

  it("write then read back, both by runtime key", async () => {
    const v = await runStandalone(
      `export function run(): number {
         const o: { [s: string]: number } = { a: 5, b: 7 };
         let k = "b";
         o[k] = 42;
         let j = "b";
         return o[j];
       }`,
    );
    expect(v).toBe(42);
  });

  it("brand-new key absent at compile time can be written and read", async () => {
    const v = await runStandalone(
      `export function run(): number {
         const o: { [s: string]: number } = { a: 5 };
         let k = "z";
         o[k] = 99;
         let j = "z";
         return o[j];
       }`,
    );
    expect(v).toBe(99);
  });

  it("one-code-unit slice-view keys round-trip through the object hash", async () => {
    const v = await runStandalone(
      `export function run(): number {
         const o: { [s: string]: number } = {};
         let source = "prefix:z";
         let start = source.length - 1;
         let key = source.slice(start);
         o[key] = 73;
         return o[key];
       }`,
    );
    expect(v).toBe(73);
  });

  it("rope keys still flatten before hashing", async () => {
    const v = await runStandalone(
      `export function run(): number {
         const o: { [s: string]: number } = {};
         let key = "";
         for (let i = 0; i < 10; i = i + 1) key = key + "abcdefgh";
         o[key] = 41;
         return o[key];
       }`,
    );
    expect(v).toBe(41);
  });

  it("static member read off an index-signature object still works", async () => {
    const v = await runStandalone(
      `export function run(): number {
         const o: { [s: string]: number } = { a: 5, b: 7 };
         return o.a + o["b"];
       }`,
    );
    expect(v).toBe(12);
  });

  it("index-signature object passed as a parameter is read by runtime key", async () => {
    const v = await runStandalone(
      `function lookup(o: { [s: string]: number }, k: string): number { return o[k]; }
       export function run(): number {
         const o: { [s: string]: number } = { x: 11, y: 22 };
         return lookup(o, "y");
       }`,
    );
    expect(v).toBe(22);
  });

  it("index-signature dict returned from a function is read by runtime key", async () => {
    const v = await runStandalone(
      `function make(): { [s: string]: number } {
         const o: { [s: string]: number } = { a: 5, b: 7 };
         return o;
       }
       export function run(): number {
         const d = make();
         let k = "b";
         return d[k];
       }`,
    );
    expect(v).toBe(7);
  });

  it("type-alias to an index signature behaves the same", async () => {
    const v = await runStandalone(
      `type Dict = { [s: string]: number };
       export function run(): number {
         const o: Dict = { a: 3, b: 4 };
         let k = "a";
         return o[k] + o["b"];
       }`,
    );
    expect(v).toBe(7);
  });

  it("interface with only an index signature behaves the same", async () => {
    const v = await runStandalone(
      `interface Dict { [s: string]: number }
       export function run(): number {
         const o: Dict = { a: 3, b: 4 };
         let k = "b";
         return o[k];
       }`,
    );
    expect(v).toBe(4);
  });

  it("computed (concatenated) runtime key resolves the property", async () => {
    const v = await runStandalone(
      `export function run(): number {
         const o: { [s: string]: number } = { ab: 42 };
         let p = "a";
         let s = "b";
         return o[p + s];
       }`,
    );
    expect(v).toBe(42);
  });

  it("read-modify-write through a runtime key", async () => {
    const v = await runStandalone(
      `export function run(): number {
         const o: { [s: string]: number } = { a: 1 };
         let k = "a";
         o[k] = o[k] + 10;
         return o["a"];
       }`,
    );
    expect(v).toBe(11);
  });

  it("empty index-signature object literal accepts dynamic writes", async () => {
    const v = await runStandalone(
      `export function run(): number {
         const o: { [s: string]: number } = {};
         let k = "x";
         o[k] = 7;
         return o[k];
       }`,
    );
    expect(v).toBe(7);
  });

  it("spread into an index-signature literal copies and reads dynamically", async () => {
    const v = await runStandalone(
      `export function run(): number {
         const base: { [s: string]: number } = { a: 1 };
         const o: { [s: string]: number } = { ...base, b: 2 };
         let ka = "a";
         let kb = "b";
         return o[ka] * 10 + o[kb];
       }`,
    );
    expect(v).toBe(12);
  });

  it("nested dict-of-dict resolves both runtime keys", async () => {
    const v = await runStandalone(
      `export function run(): number {
         const o: { [s: string]: { [t: string]: number } } = { x: { y: 9 } };
         let k1 = "x";
         let k2 = "y";
         return o[k1][k2];
       }`,
    );
    expect(v).toBe(9);
  });

  it("regression guard: a plain inferred struct still uses the fast struct path", async () => {
    // No index signature, no any-context → closed-struct fast path. Static member
    // reads must still resolve via struct.get; this must not regress to $Object.
    const v = await runStandalone(
      `export function run(): number {
         const o = { a: 5, b: 7 };
         return o.a + o.b;
       }`,
    );
    expect(v).toBe(12);
  });
});

/**
 * (#2542 follow-up, 2026-08-01) — the SAME defect on `--target wasi`.
 *
 * #2542's three routing gates were written `ctx.standalone`-only, on the stated
 * assumption that "gc/host/wasi keep their existing struct/externref mapping
 * byte-identical". That holds for gc/host, where a JS host services `o[k]`
 * through the `__extern_get` host import. It does NOT hold for **wasi**, which
 * is equally host-free: it had neither the host import nor the routing, so an
 * index-signature object silently answered the DEFAULT.
 *
 * Measured before the fix, identical source, only the target differing:
 *
 *     --target standalone   o[k] -> 7   (correct)
 *     --target wasi         o[k] -> -1  (default; no diagnostic, no trap)
 *
 * That is the same silent-wrong-answer class as #2620's dropped collection
 * calls: valid Wasm, zero diagnostics, wrong number.
 *
 * The gates now admit both host-free targets. The #1901 any/unknown/`object`
 * divert deliberately stays standalone-only — widening it would change the
 * lowering of every any-typed object literal under wasi, far beyond this defect.
 *
 * Both targets already emit the open-object runtime as defined Wasm with zero
 * non-wasi imports, so the routing cannot leak a host import — asserted below.
 */
async function runWasi(source: string): Promise<number> {
  const r = await compile(source, { target: "wasi" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  assertNoHostObjectImports(r.imports);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const nonWasi = r.imports.filter((i) => i.module !== "wasi_snapshot_preview1");
  expect(
    nonWasi.map((i) => `${i.module}::${i.name}`),
    "wasi build must not gain host imports",
  ).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as NumExports).run();
}

describe("#2542 (wasi arm) — dynamic property read/write by runtime string key", () => {
  it("headline: index-signature object read by runtime key reads the real value", async () => {
    expect(
      await runWasi(
        `export function run(): number {
           const o: { [s: string]: number } = { a: 5, b: 7 };
           let k = "b";
           return o[k];
         }`,
      ),
      "wasi read the default instead of the stored value — the host-free routing gate regressed",
    ).toBe(7);
  });

  it("write by runtime key persists", async () => {
    expect(
      await runWasi(
        `export function run(): number {
           const o: { [s: string]: number } = { a: 1 };
           const k = "a";
           o[k] = 42;
           return o[k];
         }`,
      ),
    ).toBe(42);
  });

  it("brand-new key absent at compile time can be written and read", async () => {
    expect(
      await runWasi(
        `export function run(): number {
           const o: { [s: string]: number } = { a: 1 };
           const k = "fresh";
           o[k] = 9;
           return o[k];
         }`,
      ),
    ).toBe(9);
  });

  it("Record<string, number> behaves the same as the inline index signature", async () => {
    expect(
      await runWasi(
        `export function run(): number {
           const o: Record<string, number> = { a: 5, b: 7 };
           const k = "b";
           return o[k];
         }`,
      ),
    ).toBe(7);
  });

  it("empty index-signature literal accepts dynamic writes", async () => {
    expect(
      await runWasi(
        `export function run(): number {
           const o: { [s: string]: number } = {};
           const k = "x";
           o[k] = 11;
           return o[k];
         }`,
      ),
    ).toBe(11);
  });

  it("keys read in a loop all resolve (the shape that first surfaced this)", async () => {
    expect(
      await runWasi(
        `export function run(): number {
           const o: { [s: string]: number } = { p0: 0, p1: 1, p2: 2, p3: 3 };
           const KEYS: string[] = ["p0", "p1", "p2", "p3"];
           let s = 0;
           for (let i = 0; i < 4; i++) s = s + o[KEYS[i]!];
           return s;
         }`,
      ),
    ).toBe(6);
  });

  it("regression guard: a plain inferred struct still uses the fast struct path on wasi", async () => {
    // No index-signature annotation -> must KEEP the closed struct lowering.
    // If this ever routes to $Object, the widened gate has over-reached.
    expect(
      await runWasi(
        `export function run(): number {
           const o = { a: 5, b: 7 };
           return o.a + o.b;
         }`,
      ),
    ).toBe(12);
  });
});
