import { describe, it, expect } from "vitest";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

// (#6789) Regression of #2025: `const m = obj.m; m()` on an object-literal
// method that reads `this` trapped with an uncatchable "dereferencing a null
// pointer" inside `__obj_meth_tramp_*`. The trampoline's catchable-TypeError
// arm was dropped because the method's this-usage was captured while its body
// was still empty (not compiled yet) and that stale "does not read `this`" was
// reused by the finalize rebuild. JS throws a catchable TypeError here.

async function exportsOf(src: string): Promise<Record<string, () => unknown>> {
  return (await compileAndInstantiate(src)) as Record<string, () => unknown>;
}

describe("#6789 extracted method with absent receiver throws a catchable TypeError", () => {
  it("object-literal method (the issue's repro); the instance survives", async () => {
    const ex = await exportsOf(`
      export function run(): string {
        const obj = { x: 1, m() { return this.x; } };
        const m = obj.m;
        try { m(); return "no-throw"; } catch (e) { return "caught " + (e instanceof TypeError); }
      }
      export function after(): string { return "alive"; }
    `);
    expect(ex.run!()).toBe("caught true");
    expect(ex.after!()).toBe("alive");
  });

  it("module-scope object-literal method with a parameter", async () => {
    const ex = await exportsOf(`
      const top = { y: 2, n(k: number) { return this.y * k; } };
      export function run(): string {
        const n = top.n;
        try { n(4); return "no-throw"; } catch (e) { return "caught " + (e instanceof TypeError); }
      }
    `);
    expect(ex.run!()).toBe("caught true");
  });

  it("class method extracted the same way behaves identically", async () => {
    const ex = await exportsOf(`
      class C { x = 1; method() { return this.x; } }
      export function run(): string {
        const inst = new C();
        const f = inst.method;
        try { f(); return "no-throw"; } catch (e) { return "caught " + (e instanceof TypeError); }
      }
    `);
    expect(ex.run!()).toBe("caught true");
  });

  it("an extracted method that never reads `this` still runs (no spurious throw)", async () => {
    const ex = await exportsOf(`
      export function run(): string {
        const obj = { x: 1, m() { return 7; }, e() {} };
        const m = obj.m;
        const e = obj.e;
        return String(m()) + "," + String(e());
      }
    `);
    expect(ex.run!()).toBe("7,undefined");
  });

  it("a method (or generator method) that only reads `this` as a value sees undefined, no throw", async () => {
    const ex = await exportsOf(`
      export function run(): string {
        let seen: any = 1;
        const obj = { m() { seen = this; return 2; } };
        const m = obj.m;
        const r = m();
        const gobj = { *g() { seen = this; yield 3; } };
        const g = gobj.g;
        let y: any = 0;
        try { y = g().next().value; } catch (e) { y = "threw"; }
        return String(r) + "," + String(seen === undefined) + "," + String(y);
      }
    `);
    expect(ex.run!()).toBe("2,true,3");
  });

  it("a present receiver still reaches the method", async () => {
    const ex = await exportsOf(`
      export function run(): string {
        const obj = { x: 41, m() { return this.x + 1; } };
        const m = obj.m;
        return String(obj.m()) + "," + String(m.call(obj));
      }
    `);
    expect(ex.run!()).toBe("42,42");
  });
});
