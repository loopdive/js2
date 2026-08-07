// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4210 — in `--target standalone`, an own-property write to an Error instance
 * was SILENTLY DISCARDED. No throw, no refusal, no diagnostic: `err.p = 7`
 * then `err.p` read `undefined` and `err.hasOwnProperty("p")` answered `false`.
 *
 * The fix points `__extern_set`, `__carrier_bag_of`, `__carrier_bag_delete`,
 * `__integrity_bag` and the define appliers at `$Error_struct.$props`
 * (fieldIdx 5) — the bag the receiver ALREADY had and that the read path has
 * consulted since #3130. See `src/codegen/error-props.ts`.
 *
 * ## What these cases are actually for
 *
 * The load-bearing one is `two paths, one store`. Adding a carrier for Error
 * was rejected once before, with a stated reason (`closure-props.ts` ~L305):
 * the compile-time own-field writer in `expressions/assignment.ts` already
 * writes subclass own fields straight into `$props`, so routing Error through
 * the #3468 closure bag "would give one receiver two disagreeing stores".
 * Pointing at field 5 is what makes that objection not apply — and that is a
 * claim to DEMONSTRATE, not to assert in a comment. So one case drives both
 * writers against the same instance and asserts every surface agrees.
 *
 * The `preventExtensions` case is the second reason this file exists.
 * `built-ins/Object/preventExtensions/15.2.3.10-3-20.js` passes on unfixed main
 * **because the write is dropped** — a vacuous pass that a working write side
 * alone would convert into a failure. It stays passing only because
 * `[[Extensible]]` and the write now share one bag. A regression there would
 * be invisible in a "did the write land" test, so it gets its own case.
 *
 * Every assertion below is RED on `origin/main@8f119536ae` except the two
 * marked PRECONDITION, which are green on both arms and exist to prove the
 * probe reached the substrate at all (a fixture whose arms collapse to the same
 * sentinel is vacuous — see the #4202 `undefined === undefined` case).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(body: string): Promise<number> {
  const src = `
var __r: number = 0;
${body}
export function test(): number { return __r; }
`;
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, target: "standalone" });
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  const ex = instance.exports as Record<string, () => number>;
  if (typeof ex.__module_init === "function") ex.__module_init();
  return ex.test();
}

describe("#4210 — standalone Error own-property store", () => {
  it("every reflective channel sees a plain expando write (was rhdeik)", async () => {
    // The RHDEIKX probe from the issue, as a bitmask. On unfixed main this
    // returns 0 for bits 1..32 — the write is gone before the first read.
    const mask = await run(`
      var err: any = new Error("x");
      err.p = 7;
      __r += (err.p === 7 ? 1 : 0) * 1;                                        // R
      __r += (err.hasOwnProperty("p") ? 1 : 0) * 2;                            // H
      var d: any = Object.getOwnPropertyDescriptor(err, "p");
      __r += (d && d.value === 7 ? 1 : 0) * 4;                                 // D
      var seen: number = 0;
      for (var k in err) { if (k === "p") seen = 1; }
      __r += seen * 8;                                                         // E (for-in)
      __r += (("p" in err) ? 1 : 0) * 16;                                      // I
      var ks: any = Object.keys(err);
      __r += (ks.length === 1 && ks[0] === "p" ? 1 : 0) * 32;                  // K
      // X — delete must really remove it. Before the write side existed this
      // bit passed VACUOUSLY (there was nothing to delete), which is why it is
      // asserted together with H above and not on its own.
      __r += ((delete err.p) ? 1 : 0) * 64;
      __r += (err.p === undefined && !err.hasOwnProperty("p") ? 1 : 0) * 128;
    `);
    expect(mask).toBe(255);
  });

  it("two paths, one store: the own-field writer and a plain expando agree", async () => {
    // Path A is the COMPILE-TIME writer (`expressions/assignment.ts` ~L3117),
    // reached because the receiver is statically an Error subclass. Path B is
    // the new RUNTIME arm in `__extern_set`. The 2026-08-07 base measurement of
    // this exact shape was `code=1 other=2 hasCode=0 hasOther=0`: both values
    // read back, neither was visible to reflection — the bag existed and
    // nothing reflected over it.
    const mask = await run(`
      class MyErr extends Error {}
      var e: any = new MyErr("m");
      e.code = 1;                       // path A — statically-typed subclass receiver
      var alias: any = e;
      alias["other"] = 2;               // path B — dynamic receiver, computed key
      __r += (e.code === 1 ? 1 : 0) * 1;
      __r += (e.other === 2 ? 1 : 0) * 2;
      __r += (e.hasOwnProperty("code") ? 1 : 0) * 4;
      __r += (e.hasOwnProperty("other") ? 1 : 0) * 8;
      // The point of the case: BOTH keys are in ONE own-key enumeration. Two
      // stores would show up here as a short list.
      var ks: any = Object.getOwnPropertyNames(e);
      __r += (ks.length === 2 ? 1 : 0) * 16;
      // …and deleting through one path is visible to the other.
      __r += ((delete e.code) ? 1 : 0) * 32;
      __r += (!e.hasOwnProperty("code") && e.other === 2 ? 1 : 0) * 64;
    `);
    expect(mask).toBe(127);
  });

  it("all four Error spellings behave identically to a plain object", async () => {
    // `new Error(msg)` / `new TypeError(msg)` / `new Error()` / `Error(msg)` —
    // the issue measured all four as `rhd|vh` against a plain object's
    // `RHD|VH`, which is what rules out a message / subclass / construct-vs-call
    // artifact and points at the carrier.
    const mask = await run(`
      function probe(o: any): number {
        var m: number = 0;
        o.p = 7;
        m += (o.p === 7 ? 1 : 0) * 1;
        m += (o.hasOwnProperty("p") ? 1 : 0) * 2;
        var d: any = Object.getOwnPropertyDescriptor(o, "p");
        m += (d && d.value === 7 ? 1 : 0) * 4;
        Object.defineProperty(o, "q", { value: 9, writable: true, enumerable: true, configurable: true });
        m += (o.q === 9 ? 1 : 0) * 8;
        m += (o.hasOwnProperty("q") ? 1 : 0) * 16;
        return m;
      }
      var want: number = probe({});                       // the plain-object oracle
      __r += (want === 31 ? 1 : 0) * 1;                   // PRECONDITION: green on both arms
      __r += (probe(new Error("e")) === want ? 1 : 0) * 2;
      __r += (probe(new TypeError("e")) === want ? 1 : 0) * 4;
      __r += (probe(new Error()) === want ? 1 : 0) * 8;
      __r += (probe(Error("e")) === want ? 1 : 0) * 16;
    `);
    expect(mask).toBe(31);
  });

  it("preventExtensions refuses the write — NOT a vacuous pass any more", async () => {
    // The shape of built-ins/Object/preventExtensions/15.2.3.10-3-20.js. Bit 1
    // is the part that was WRONG on base: `Object.isExtensible` on an Error
    // answered false, because there was no bag to read `[[Extensible]]` from
    // and the terminal rule is the non-object one. Bits 4/8 pass on base too —
    // vacuously, because the write was dropped rather than refused.
    const mask = await run(`
      var err: any = new Error("x");
      __r += (Object.isExtensible(err) ? 1 : 0) * 1;
      Object.preventExtensions(err);
      __r += (!Object.isExtensible(err) ? 1 : 0) * 2;
      err.exName = 5;
      __r += (err.exName === undefined ? 1 : 0) * 4;
      __r += (!err.hasOwnProperty("exName") ? 1 : 0) * 8;
      // …and a non-extensible Error still accepts an UPDATE of an existing own
      // key, which is what distinguishes "sealed" from "dropped on the floor".
      var e2: any = new Error("y");
      e2.k = 1;
      Object.preventExtensions(e2);
      e2.k = 2;
      __r += (e2.k === 2 ? 1 : 0) * 16;
    `);
    expect(mask).toBe(31);
  });

  it("an Error works as the descriptor argument of defineProperty (#4165 family)", async () => {
    // §6.2.5.6: test262 spells "an arbitrary object used as a property
    // descriptor" as `var d = new Error(); d.value = …; d.enumerable = true;
    // Object.defineProperty(o, "p", d)`. ToPropertyDescriptor reads the fields
    // back through `__extern_has`/`__extern_get`, so on base the descriptor
    // came out EMPTY and CompletePropertyDescriptor filled in all-false — a
    // silent wrong answer with no refusal.
    const mask = await run(`
      var d: any = new Error("x");
      d.value = 42;
      d.writable = true;
      d.enumerable = true;
      d.configurable = true;
      var o: any = {};
      Object.defineProperty(o, "p", d);
      __r += (o.p === 42 ? 1 : 0) * 1;
      var g: any = Object.getOwnPropertyDescriptor(o, "p");
      __r += (g && g.enumerable ? 1 : 0) * 2;
      __r += (g && g.writable ? 1 : 0) * 4;
      __r += (g && g.configurable ? 1 : 0) * 8;
    `);
    expect(mask).toBe(15);
  });

  it("PRECONDITION: a plain object is unchanged on every channel", async () => {
    // Green on BOTH arms. Its job is to fail loudly if the probe harness stops
    // reaching the object runtime at all, which would otherwise make every
    // assertion above pass or fail for the wrong reason.
    const mask = await run(`
      var o: any = {};
      o.p = 7;
      __r += (o.p === 7 ? 1 : 0) * 1;
      __r += (o.hasOwnProperty("p") ? 1 : 0) * 2;
      __r += ((delete o.p) ? 1 : 0) * 4;
      __r += (!o.hasOwnProperty("p") ? 1 : 0) * 8;
    `);
    expect(mask).toBe(15);
  });

  it("SCOPE PIN: gc/host mode is untouched", async () => {
    // The Error arm is standalone/wasi-only — `reserveErrorPropHelpers` is
    // called from inside `ensureObjectRuntime`'s `ctx.standalone || ctx.wasi`
    // block, and in host mode `env::__extern_*` owns the dynamic-property path.
    // Compiling the same source WITHOUT `target: "standalone"` must still
    // succeed and must not register the helpers.
    const r = await compile(
      `var err: any = new Error("x"); err.p = 7; export function test(): number { return err.p === 7 ? 1 : 0; }`,
      { fileName: "test.ts", skipSemanticDiagnostics: true },
    );
    expect(r.success, r.errors?.[0]?.message).toBe(true);
    expect(r.wat ?? "").not.toContain("__error_bag_ensure");
  });
});
