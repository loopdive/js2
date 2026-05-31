import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #1614 — super.method() where the parent is a builtin extern class (Set/Map/...)
// must compile (dispatched dynamically via __extern_method_call) instead of
// raising "Cannot find method 'X' on parent class 'Set'". Runtime behaviour of
// the Set-composition methods is covered by the test262 subclass-receiver suite.
describe("#1614 super-method calls on builtin extern-class parents", () => {
  it("compiles super.size/has/keys overrides inside a class extending Set", async () => {
    const src = `
      class MySet extends Set {
        size(...rest: any[]): any { return super.size(...rest); }
        has(...rest: any[]): any { return super.has(...rest); }
        keys(...rest: any[]): any { return super.keys(...rest); }
      }
      export function test(): number {
        const s = new MySet([1, 2]);
        return s instanceof Set ? 1 : 0;
      }
    `;
    const r = await compile(src);
    expect(r.success, `Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(true);
  });

  it("compiles a plain Set subclass using union()", async () => {
    const src = `
      class MySet extends Set {}
      export function test(): number {
        const s1 = new MySet([1, 2]);
        const s2 = new Set([2, 3]);
        const combined: any = (s1 as any).union(s2);
        return combined instanceof Set ? 1 : 0;
      }
    `;
    const r = await compile(src);
    expect(r.success).toBe(true);
  });
});
