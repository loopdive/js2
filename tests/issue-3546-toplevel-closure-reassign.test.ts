/**
 * #3546 — module TOP-LEVEL closure reassignment must be visible to
 * cross-function reads/calls.
 *
 * Pre-fix, `let f = () => 1; f = () => 2;` at module top level wrote only the
 * `__module_init` local shadow that the DECLARATION created (variables.ts
 * arrow path: `local.tee` + box-on-store `global.set`); the top-level
 * REASSIGNMENT then hit the localMap entry inside `__module_init` and took
 * assignment.ts's LOCAL arm — the `$__mod_f` global (which every OTHER
 * function's `f()` resolves through) silently kept the FIRST closure. A
 * silent wrong answer: no trap, no diagnostic, `test()` returned 1.
 *
 * These assertions FAIL on the unfixed compiler (they assert the SECOND
 * closure is observed — got=1 pre-fix), per the wrong-answer-bug gating rule:
 * the guard is a positive behavioral assertion, not absence-of-trap.
 */
import { describe, expect, it } from "vitest";
import { compileSource } from "../src/compiler.ts";
import { buildImports } from "../src/runtime.ts";
import { instantiateWasm } from "../src/runtime-instantiate.ts";

async function run(source: string): Promise<unknown> {
  const r = await compileSource(source);
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const binary = new Uint8Array(r.binary);
  await WebAssembly.compile(binary as BufferSource);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await instantiateWasm(binary, imports.env, imports.string_constants, imports.string_constants16);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#3546 — top-level closure reassignment visible cross-function", () => {
  it("let: top-level reassign, called from an exported fn, sees the SECOND closure", async () => {
    const got = await run(`let f = (): number => 1;
f = (): number => 2;
export function test(): number { return f(); }`);
    expect(got).toBe(2);
  });

  it("var: same shape", async () => {
    const got = await run(`var f = (): number => 1;
f = (): number => 2;
export function test(): number { return f(); }`);
    expect(got).toBe(2);
  });

  it("reassigned closure capturing state behaves (not just constants)", async () => {
    const got = await run(`let base = 10;
let f = (): number => base + 1;
f = (): number => base + 2;
export function test(): number { return f(); }`);
    expect(got).toBe(12);
  });

  it("top-level call between the two assignments sees the FIRST closure", async () => {
    const got = await run(`let observed = 0;
let f = (): number => 1;
observed = f();
f = (): number => 2;
export function test(): number { return observed * 10 + f(); }`);
    expect(got).toBe(12); // 1 (before reassign) *10 + 2 (after)
  });

  // Controls — passed BEFORE the fix; must keep passing (no dual-store leaks).
  it("control: reassignment inside a function still works", async () => {
    const got = await run(`let f = (): number => 1;
export function set2(): void { f = (): number => 2; }
export function test(): number { set2(); return f(); }`);
    expect(got).toBe(2);
  });

  it("control: purely local shadow does NOT clobber the module binding", async () => {
    const got = await run(`const f = (): number => 1;
function inner(): number {
  const f = (): number => 5;
  return f();
}
export function test(): number { return inner() * 10 + f(); }`);
    expect(got).toBe(51);
  });

  it("control: top-level BLOCK-scoped shadow does not clobber the module binding", async () => {
    const got = await run(`let f = (): number => 1;
{
  let f = (): number => 7;
  f = (): number => 8;
}
export function test(): number { return f(); }`);
    expect(got).toBe(1);
  });

  it("control: scalar module let reassignment unaffected", async () => {
    const got = await run(`let x = 1;
x = 2;
export function test(): number { return x; }`);
    expect(got).toBe(2);
  });
});
