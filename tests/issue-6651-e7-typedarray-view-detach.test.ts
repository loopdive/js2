// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 cluster E, slice E7 — a STATIC TypedArray view in a generic slot,
 * `%TypedArray%.prototype.toString` on a detached `any` receiver, and a
 * callable constructor argument. Standalone, no host.
 *
 *  - `new Int8Array(buffer)` is a static `$__ta_view`. A closure that returns
 *    it keeps the view (it used to cast it to the packed-vec return type:
 *    null), and in an externref slot it answers the §10.4.5 MOP — elements,
 *    writes into the shared bytes, and a detach-aware `length`.
 *  - `x.toString()` on a detached view throws (§23.2.3.32 → `join` →
 *    ValidateTypedArray); an attached view still renders its elements.
 *  - `new TA(fn)` consults `fn[Symbol.iterator]` (§23.2.5.1 step 6.b).
 *
 * `buf.__detached__ = true` is the standalone detach marker the Test262
 * `$DETACHBUFFER` shim writes. Every case but the attached-`toString` guard is
 * red on the base.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(body: string): Promise<unknown> {
  const result = await compile(`export function test(): number { ${body} }`, {
    fileName: "issue-6651-e7.ts",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

// Dynamic views (the `testWithTypedArrayConstructors` carrier), two kinds.
const FIX = `const ctors: any[] = [Float64Array, Int8Array]; var answer = 0;
  for (let i = 0; i < ctors.length; i++) { const C: any = ctors[i];`;

describe("#6651 E7 — static views in generic slots, detached toString, callable ctor args", () => {
  it("a closure returning a static view returns the view itself", async () => {
    expect(
      await run(`const ab = new ArrayBuffer(4); const target = new Int8Array(ab); target[1] = 7;
      const get = function () { return target; };
      const r: any = get();
      return (r === target ? 100 : 0) + (r[1] === 7 ? 10 : 0) + r.length;`),
    ).toBe(114);
  });

  it("a static view in an externref slot reads, writes and detaches like a view", async () => {
    expect(
      // A module that also builds a DYNAMIC view (every test262 TypedArray
      // module does): the static view borrows that carrier's MOP arms.
      await run(`const ctors: any[] = [Float64Array]; const C: any = ctors[0]; const dyn: any = new C(1);
      const ab = new ArrayBuffer(8); const target = new Int16Array(ab); target[1] = -7;
      const id = function (v: any): any { return v; };
      const g: any = id(target);
      g["3"] = 5;
      const before = (g["1"] === -7 ? 1000 : 0) + (target[3] === 5 ? 100 : 0) + g.length * 10;
      (ab as any).__detached__ = true;
      return before + g.length + (g[1] === undefined ? 1 : 0) + dyn.length * 0;`),
    ).toBe(1141);
  });

  it("toString throws on a detached view", async () => {
    expect(
      await run(`${FIX}
      const s: any = new C(1); (s.buffer as any).__detached__ = true; var kind = 0;
      try { s.toString(); kind = 1; } catch (e) { kind = e instanceof TypeError ? 2 : 3; }
      answer = answer * 10 + kind;
    } return answer;`),
    ).toBe(22);
  });

  it("toString on an attached view still joins its elements", async () => {
    expect(
      await run(`${FIX}
      const s: any = new C(2); s[0] = 4; s[1] = 5;
      answer = answer * 10 + (s.toString() === "4,5" ? 1 : 0);
    } return answer;`),
    ).toBe(11);
  });

  it("a callable constructor argument consults @@iterator", async () => {
    expect(
      await run(`${FIX}
      const obj: any = function () {}; var kind = 0;
      obj[Symbol.iterator] = 42;
      try { new C(obj); kind = 1; } catch (e) { kind = e instanceof TypeError ? 2 : 3; }
      answer = answer * 10 + kind;
    } return answer;`),
    ).toBe(22);
  });
});
