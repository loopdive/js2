// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// `key in instance` with a RUNTIME key, where the key names a prototype method.
//
// §7.3.12 [[HasProperty]] is prototype-inclusive, but the dynamic-key arm of
// `compileInOperator` compared the key only against the receiver's PHYSICAL
// struct fields. A class's instance methods live on the prototype and have no
// field, so a runtime key naming one matched nothing and answered `false`.
// A string-LITERAL key takes the checker-backed static fold and answers
// correctly, which is exactly what hid it.
//
// marked's `use()` is the loop verbatim —
//   `for (let i in n.hooks) { if (!(i in r)) throw new Error(...) }`
// with `r = new _Hooks()` — so every `marked.use({hooks})` threw
// "hook 'preprocess' does not exist".
//
// The sources are plain untyped `.js`, matching how the upstream suites feed
// package code in. Annotating the receiver `: any` forces the externref
// `__extern_has` arm instead and does NOT exercise this path.

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
  const root = mkdtempSync(join(tmpdir(), "js2-in-proto-"));
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

describe("`in` with a runtime key over prototype methods", () => {
  it("finds an instance method through a runtime key", async () => {
    expect(
      await runModule(`class Hooks { preprocess(m) { return m; } }
export function run() {
  const d = new Hooks();
  const src = { preprocess(m) { return m; } };
  let found = 0;
  for (const i in src) { if (i in d) found++; }
  return found;
}`),
    ).toBe(1);
  });

  it("still answers false for a runtime key the prototype does not carry", async () => {
    expect(
      await runModule(`class Hooks { preprocess(m) { return m; } }
export function run() {
  const d = new Hooks();
  const src = { nope(m) { return m; } };
  let found = 0;
  for (const i in src) { if (i in d) found++; }
  return found;
}`),
    ).toBe(0);
  });

  it("finds an inherited method through a runtime key", async () => {
    expect(
      await runModule(`class Base { preprocess(m) { return m; } }
class Hooks extends Base { postprocess(m) { return m; } }
export function run() {
  const d = new Hooks();
  const src = { preprocess(m) { return m; }, postprocess(m) { return m; } };
  let found = 0;
  for (const i in src) { if (i in d) found++; }
  return found;
}`),
    ).toBe(2);
  });

  it("keeps the literal-key answer unchanged", async () => {
    expect(
      await runModule(`class Hooks { preprocess(m) { return m; } }
export function run() {
  const d = new Hooks();
  return ("preprocess" in d ? 1 : 0) + ("nope" in d ? 10 : 0);
}`),
    ).toBe(1);
  });

  it("runs marked's hook-validation loop without throwing", async () => {
    // Verbatim shape from marked's `use()`. On the parent commit this THROWS
    // `hook 'preprocess' does not exist` before returning anything.
    expect(
      await runModule(`class Hooks { preprocess(m) { return m; } postprocess(m) { return m; } }
export function run() {
  const pack = { hooks: { preprocess(md) { return "# p" + md; } } };
  const defaults = new Hooks();
  let installed = 0;
  for (const i in pack.hooks) {
    if (!(i in defaults)) throw new Error("hook '" + i + "' does not exist");
    installed++;
  }
  return installed;
}`),
    ).toBe(1);
  });
});
