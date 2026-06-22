import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

// #2612 — an async function EXPRESSION bound to a `var`/`let` and consumed as a
// thenable (`ref(3).then(...)`) must be Promise-wrapped. `isAsyncCallExpression`
// missed the `var ref; ref = async function …` two-step shape because
// `ctx.asyncFunctions` only holds async DECLARATIONS, and the TS signature /
// call-signature fallbacks see no `Promise<T>` on the initializer-less `var`
// binding. Fix: resolve the callee symbol and detect a `VariableDeclaration`
// initializer OR a later `name = async function …` assignment whose RHS is an
// async function expression / async arrow → treat the call as async so
// `wrapAsyncReturn` produces a real Promise the `.then` consumer can chain off.

async function runHost(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "t.ts" });
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  return (instance.exports as { test(): unknown }).test();
}

describe("#2612 async fn-expr via var/expr binding wrapped in Promise", () => {
  it("var ref; ref = async function ref(...) — ref(3) is a thenable", async () => {
    const ret = await runHost(`
      var callCount = 0;
      var ref;
      ref = async function ref(x, y = x) { callCount = callCount + 1; };
      export function test(): number {
        const p: any = ref(3);
        return (p !== null && typeof p.then === "function") ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("nameless async function expression bound to a var", async () => {
    const ret = await runHost(`
      var callCount = 0;
      var ref;
      ref = async function(a) { callCount = callCount + 1; };
      export function test(): number {
        const p: any = ref(42);
        return (p !== null && typeof p.then === "function") ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("async arrow bound via const initializer", async () => {
    const ret = await runHost(`
      const ref = async (x: number) => x;
      export function test(): number {
        const p: any = ref(7);
        return (p !== null && typeof p.then === "function") ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("a non-async function bound to a var is NOT treated as async (no spurious wrap)", async () => {
    const ret = await runHost(`
      var plain;
      plain = function plain(x: number) { return x; };
      export function test(): number {
        // A sync fn returns its raw value; the result must NOT be a Promise.
        const r: any = plain(5);
        return (typeof r === "number" && r === 5) ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });
});
