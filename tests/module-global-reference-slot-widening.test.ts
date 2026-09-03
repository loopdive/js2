// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// A module-scope `let`/`var` whose REFERENCE initializer pins a concrete
// struct/vec slot, later assigned a PRIMITIVE.
//
// `moduleGlobalWasmType` commits the slot from the initializer, so
// `let x = { a: 1 }` types `__mod_x` as `(ref null $obj)`. A later `x = true`
// then has nowhere to go: `coerceType`'s terminal fallback is
// `drop` + `pushDefaultValue`, and the module emits
//
//     i32.const 1     ;; the boolean
//     drop            ;; discarded
//     ref.null $obj   ;; stored instead
//
// The module VALIDATES — this is a silent wrong answer, not a trap. Every read
// after the assignment answers `null`. This is #4204's defect in the opposite
// direction: that one widened a PRIMITIVE-initialized slot that later received
// a reference; this one widens a REFERENCE-initialized slot that later
// receives a primitive.
//
// The fixtures are plain untyped `.js`, matching how the upstream npm suites
// feed package code in. An explicit annotation (`let x: any = …`) selects the
// externref slot up front and does NOT exercise this path at all.
//
// Function-local `let` is unaffected — only the module-global typer pins the
// slot from the initializer — so the local case is included as a guard.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const ENTRY = `import { run } from "./mod.js";\nexport function test(): number { return (run as unknown as () => number)(); }`;

async function runModule(moduleSource: string): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), "js2-ref-slot-widen-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "mod.js"), moduleSource);
  writeFileSync(join(root, "entry.ts"), ENTRY);
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("module global on a reference slot that later receives a primitive", () => {
  it("stores a boolean into an object-literal-initialized `let`", async () => {
    expect(
      await runModule(`let x = { a: 1 };
export function run() { x = true; return x === true ? 1 : 0; }`),
    ).toBe(1);
  });

  it("stores a number into an object-literal-initialized `let`", async () => {
    expect(
      await runModule(`let x = { a: 1 };
export function run() { x = 5; return x === 5 ? 1 : 0; }`),
    ).toBe(1);
  });

  it("stores a string into an array-literal-initialized `let`", async () => {
    expect(
      await runModule(`let x = [1, 2];
export function run() { x = "s"; return x === "s" ? 1 : 0; }`),
    ).toBe(1);
  });

  it("stores a boolean into a `new C()`-initialized `let`", async () => {
    expect(
      await runModule(`class C { m() { return 1; } }
let x = new C();
export function run() { x = true; return x === true ? 1 : 0; }`),
    ).toBe(1);
  });

  it("stores a number into an object-initialized `var`", async () => {
    expect(
      await runModule(`var x = { a: 1 };
export function run() { x = 7; return x === 7 ? 1 : 0; }`),
    ).toBe(1);
  });

  it("distinguishes a stored `undefined` from the slot's null default", async () => {
    expect(
      await runModule(`let x = { a: 1 };
export function run() { x = undefined; return x === undefined ? 1 : (x === null ? 2 : 0); }`),
    ).toBe(1);
  });

  it("writes back a number through a compound assignment", async () => {
    expect(
      await runModule(`let x = { a: 1 };
export function run() { x = 2; x += 3; return x === 5 ? 1 : 0; }`),
    ).toBe(1);
  });

  it("stores a primitive assigned from a variable, not just a literal", async () => {
    expect(
      await runModule(`let x = { a: 1 };
export function run() { const v = 9; x = v; return x === 9 ? 1 : 0; }`),
    ).toBe(1);
  });

  // Guards — these already pass on the parent commit and must stay passing.
  // Each one is a shape the widening deliberately does NOT fire on.

  it("leaves an object-to-object reassignment on its concrete slot", async () => {
    expect(
      await runModule(`let x = { a: 1 };
export function run() { x = { b: 2 }; return x.b === 2 ? 1 : 0; }`),
    ).toBe(1);
  });

  it("leaves a never-reassigned binding alone", async () => {
    expect(
      await runModule(`let x = { a: 1 };
export function run() { return x.a === 1 ? 1 : 0; }`),
    ).toBe(1);
  });

  it("keeps a function-local `let` working", async () => {
    expect(await runModule(`export function run() { let x = { a: 1 }; x = true; return x === true ? 1 : 0; }`)).toBe(1);
  });

  it("does not widen a `const` binding", async () => {
    expect(
      await runModule(`const x = { a: 1 };
export function run() { return x.a === 1 ? 1 : 0; }`),
    ).toBe(1);
  });
});
