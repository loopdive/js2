import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

// #1680 — PrivateBrandCheck for private *accessor* (getter) and *method*
// reads. Per ES2022 §15.7 PrivateFieldGet step 4, reading `o.#m` when `o`
// lacks the brand of the declaring class must throw a TypeError. The prior
// #1365 brand check only covered struct-backed private *fields*; getter and
// method members are registered in classAccessorSet / classMethodSet, so the
// brand check was skipped and a wrong-brand receiver silently misbehaved.
async function run(source: string): Promise<number> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, (r as any).stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

describe("#1680 private getter/method brand check", () => {
  it("private getter read on same-brand receiver returns the value", async () => {
    const ret = await run(`
      class C {
        get #m(): string { return "test262"; }
        access(o: any): string { return o.#m; }
      }
      export function test(): f64 {
        const c = new C();
        return c.access(c) === "test262" ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("private getter read on a non-brand receiver throws TypeError", async () => {
    const ret = await run(`
      class C {
        get #m(): string { return "test262"; }
        access(o: any): string { return o.#m; }
      }
      export function test(): f64 {
        const c = new C();
        try {
          c.access({});
          return 0;
        } catch (e) {
          return e instanceof TypeError ? 1 : 2;
        }
      }
    `);
    expect(ret).toBe(1);
  });

  it("private field read brand check (regression of #1365) still throws", async () => {
    const ret = await run(`
      class C {
        #v: f64 = 7;
        field(o: any): f64 { return o.#v; }
      }
      export function test(): f64 {
        const c = new C();
        let ok = 0;
        if (c.field(c) === 7) ok += 1;
        try { c.field({}); } catch (e) { if (e instanceof TypeError) ok += 10; }
        return ok;
      }
    `);
    expect(ret).toBe(11);
  });
});
