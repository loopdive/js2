// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4187 — in `--target standalone`, `obj.hasOwnProperty(k)` constant-folded to
 * `true` for a key that `Object.defineProperty` added and a later `delete`
 * removed. The delete really happened (gOPD `undefined`, `Object.hasOwn` false,
 * `Object.keys` omits it) but the folded call site still said `true`, so two
 * spellings of the same question disagreed.
 *
 * The fold answers from the defineProperty-widened struct SHAPE, which no
 * runtime delete retracts. `compilePropertyIntrospection` now routes to the
 * runtime helper when the receiver both saw an `Object.defineProperty` and
 * appears in the whole-program `scanModuleMemberDeletes` pre-scan.
 *
 * Two invariants beyond "the bug is fixed":
 *   - the read BEFORE the delete must still answer `true` — it precedes the
 *     delete textually, which is exactly why the gate is a pre-scan and not a
 *     record-as-you-compile signal (an order-sensitive record would fold the
 *     first read and route the second, answering from two mechanisms);
 *   - a receiver that is never deleted from must keep folding — that is the
 *     byte-identity guarantee for the rest of the corpus, so a PRECONDITION
 *     case pins it (green on both arms; it proves the probe reached the
 *     substrate rather than asserting the fix).
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

describe("#4187 — standalone hasOwnProperty fold vs runtime delete", () => {
  it("hasOwnProperty agrees with the runtime after define+delete (the canonical repro)", async () => {
    // Shape of built-ins/Object/defineProperty/15.2.3.6-3-86-1.js: an IDENTIFIER
    // descriptor (not an inline literal), so `definedPropertyFlags` — the one
    // mode-agnostic signal — is empty and only the #4187 gate can route this.
    const mask = await run(`
      var obj: any = {};
      var funObj: any = function (a: any, b: any): any { return a; };
      funObj.value = 12;
      funObj.configurable = true;
      Object.defineProperty(obj, "property", funObj);
      __r += (obj.hasOwnProperty("property") ? 1 : 0) * 1;    // before: own
      __r += ((delete obj.property) ? 1 : 0) * 2;             // configurable -> succeeds
      __r += (!obj.hasOwnProperty("property") ? 1 : 0) * 4;   // after: NOT own (was 'true')
    `);
    expect(mask).toBe(7);
  });

  it("both spellings agree after define+delete (Object.hasOwn vs obj.hasOwnProperty)", async () => {
    // The defect was visible precisely as a disagreement between the folded
    // call site and the native, whose bodies are byte-identical.
    const mask = await run(`
      var o: any = {};
      Object.defineProperty(o, "k", { value: 1, configurable: true, enumerable: true, writable: true });
      __r += (o.hasOwnProperty("k") === Object.hasOwn(o, "k") ? 1 : 0) * 1;
      delete o.k;
      __r += (o.hasOwnProperty("k") === Object.hasOwn(o, "k") ? 1 : 0) * 2;
      __r += (Object.getOwnPropertyDescriptor(o, "k") === undefined ? 1 : 0) * 4;
      __r += (!o.hasOwnProperty("k") ? 1 : 0) * 8;
    `);
    expect(mask).toBe(15);
  });

  it("propertyIsEnumerable also stops folding past a delete", async () => {
    const mask = await run(`
      var p: any = {};
      Object.defineProperty(p, "e", { value: 5, enumerable: true, configurable: true, writable: true });
      __r += (p.propertyIsEnumerable("e") ? 1 : 0) * 1;
      __r += ((delete p.e) ? 1 : 0) * 2;
      __r += (!p.propertyIsEnumerable("e") ? 1 : 0) * 4;
    `);
    expect(mask).toBe(7);
  });

  it("a computed-key delete also disarms the fold (delete r[k], not just delete r.k)", async () => {
    const mask = await run(`
      var q: any = {};
      var key: any = "z";
      Object.defineProperty(q, "z", { value: 9, configurable: true, enumerable: true, writable: true });
      __r += (q.hasOwnProperty("z") ? 1 : 0) * 1;
      delete q[key];
      __r += (!q.hasOwnProperty("z") ? 1 : 0) * 2;
    `);
    expect(mask).toBe(3);
  });

  it("PRECONDITION: a receiver never deleted from keeps answering true (fold preserved)", async () => {
    // Green on BOTH arms by design. Its job is to prove the probe reaches the
    // substrate at all, and to pin the byte-identity side of the gate: no
    // delete on this receiver ⇒ no routing change ⇒ the fold still answers.
    const mask = await run(`
      var keep: any = {};
      Object.defineProperty(keep, "stays", { value: 3, configurable: true, enumerable: true, writable: true });
      __r += (keep.hasOwnProperty("stays") ? 1 : 0) * 1;
      __r += (keep.stays === 3 ? 1 : 0) * 2;
      __r += (Object.hasOwn(keep, "stays") ? 1 : 0) * 4;
    `);
    expect(mask).toBe(7);
  });

  it("deleting a DIFFERENT receiver does not disarm this one's fold", async () => {
    const mask = await run(`
      var a: any = {};
      var b: any = {};
      Object.defineProperty(a, "x", { value: 1, configurable: true, enumerable: true, writable: true });
      Object.defineProperty(b, "x", { value: 2, configurable: true, enumerable: true, writable: true });
      delete b.x;
      __r += (a.hasOwnProperty("x") ? 1 : 0) * 1;    // untouched receiver
      __r += (!b.hasOwnProperty("x") ? 1 : 0) * 2;   // deleted receiver
    `);
    expect(mask).toBe(3);
  });
});
