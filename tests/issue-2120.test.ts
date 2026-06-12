import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// #2120 — a captured `let` loop variable that is ALSO compound-assigned in the
// loop body produced an invalid module (F64Add left value type mismatch). The
// pre-box pass (#1589/#1617) stores the loop var in an i32 ref-cell, but the
// boxed compound-assignment path read the cell as i32 then emitted f64.add. The
// fix promotes any non-f64 cell value (i32 included) to f64 before the
// arithmetic and coerces back on writeback.

async function compileAndRun(source: string) {
  const result = await compile(source);
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  expect(WebAssembly.validate(result.binary), "module must validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject!);
  return instance.exports as Record<string, Function>;
}

describe("#2120 captured loop var also compound-assigned in body", () => {
  it("validates and returns the right value for `i += 1` in the body", async () => {
    const e = await compileAndRun(
      `export function test(): number {
         let f: () => number = () => -1;
         for (let i = 0; i < 4; i++) { f = () => i; i += 1; }
         return f();
       }`,
    );
    expect(e.test()).toBe(3);
  });

  it("handles `i -= 1` in a descending loop", async () => {
    const e = await compileAndRun(
      `export function test(): number {
         let f: () => number = () => -1;
         for (let i = 10; i > 0; i--) { f = () => i; i -= 1; }
         return f();
       }`,
    );
    expect(e.test()).toBe(1);
  });

  it("captured f64 loop var with body compound-assign stays correct (unregressed)", async () => {
    const e = await compileAndRun(
      `export function test(): number {
         let f: () => number = () => -1;
         for (let i = 0.0; i < 4; i += 1.5) { f = () => i; }
         return f();
       }`,
    );
    expect(e.test()).toBe(3.0);
  });

  it("loop var captured but NOT body-written validates (control)", async () => {
    const e = await compileAndRun(
      `export function test(): number {
         let f: () => number = () => -1;
         for (let i = 0; i < 4; i++) { f = () => i; }
         return f();
       }`,
    );
    expect(e.test()).toBe(3);
  });
});
