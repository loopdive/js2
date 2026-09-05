// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// A self-recursive `const` arrow whose recursion is ALSO captured by a nested
// closure, where that nested closure is constructed inside a conditional arm.
//
// `arrow-phases.ts` already documents the hazard at the eager-box site: "A
// construction site in a conditional arm cannot own the canonical box for a
// captured parameter: compilation re-aims all later reads to that box even when
// the arm is skipped at runtime." Its guard, `canBoxBindingInDominatingParent`,
// admits two safe sources — a declared parameter of the owner, and a local
// initialised before the region. The self-recursive binding is NEITHER: inside
// the lifted body it resolves to `__self`, lifted param 0, whose NAME belongs to
// the outer binding and appears in no `owner.parameters` entry.
//
// So the box was created inside whichever conditional arm first constructed a
// nested closure over the recursion, and every LATER recursive reference was
// re-aimed at that box. On any path that skipped the arm the box is null:
//
//     const visit = (s) => {
//       if (Array.isArray(s)) { const r = []; s.forEach((v, i) => { r[i] = visit(v); }); return r; }
//       const t = {}; for (const k in s) t[k] = visit(s[k]); return t;   // ← reads the null box
//     };
//     visit({ a: [{ b: 7 }] });   // RuntimeError: dereferencing a null pointer
//
// **Source order alone decided whether the function trapped.** Putting the
// object branch first made the same program work, because the direct recursive
// call was then compiled before the box existed and resolved through `__self`.
// Both orders are pinned below.
//
// Reached by axios' `redactConfig` and `toJSONObject`, which are exactly this
// shape — an array arm using `forEach` plus an object arm walking entries.
// Eleven of `AxiosError.test.js`'s redaction tests trapped here.
//
// The fixtures are plain untyped `.js`, matching how the upstream npm suites
// feed package code in.

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

const ENTRY = `import { run } from "./mod.js";\nexport function test(): any { return (run as unknown as () => unknown)(); }`;

async function runModule(moduleSource: string): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), "js2-self-rec-arrow-"));
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

const ARRAY_ARM = `if (Array.isArray(s)) { const r = []; s.forEach((v, i) => { r[i] = visit(v); }); return r; }`;
const OBJECT_ARM = `const t = {}; for (const k in s) t[k] = visit(s[k]); return t;`;

describe("self-recursive arrow captured by a closure in a conditional arm", () => {
  it("recurses on the object path when the array arm is compiled first", async () => {
    expect(
      await runModule(`export function run() {
  const visit = (s) => {
    if (s === null || typeof s !== "object") return s;
    ${ARRAY_ARM}
    ${OBJECT_ARM}
  };
  return visit({ a: [{ b: 7 }] }).a[0].b;
}`),
    ).toBe(7);
  });

  it("still recurses when the object arm is compiled first", async () => {
    // This order already worked — it pins that the fix did not move it.
    expect(
      await runModule(`export function run() {
  const visit = (s) => {
    if (s === null || typeof s !== "object") return s;
    if (!Array.isArray(s)) { ${OBJECT_ARM} }
    ${ARRAY_ARM}
    return s;
  };
  return visit({ a: [{ b: 7 }] }).a[0].b;
}`),
    ).toBe(7);
  });

  it("recurses on the array path too", async () => {
    expect(
      await runModule(`export function run() {
  const visit = (s) => {
    if (s === null || typeof s !== "object") return s;
    ${ARRAY_ARM}
    ${OBJECT_ARM}
  };
  return visit([{ b: 1 }, { b: 2 }])[1].b;
}`),
    ).toBe(2);
  });

  it("recurses through `map` as well as `forEach`", async () => {
    expect(
      await runModule(`export function run() {
  const visit = (s) => {
    if (s === null || typeof s !== "object") return s;
    if (Array.isArray(s)) return s.map((v) => visit(v));
    const t = {};
    for (const [k, v] of Object.entries(s)) t[k] = visit(v);
    return t;
  };
  return visit({ a: [{ b: 3 }] }).a[0].b;
}`),
    ).toBe(3);
  });

  it("survives three arms where only the middle one captures the recursion", async () => {
    expect(
      await runModule(`export function run() {
  const visit = (s) => {
    if (typeof s === "number") return s + 1;
    if (Array.isArray(s)) { const r = []; s.forEach((v, i) => { r[i] = visit(v); }); return r; }
    if (s && typeof s === "object") { const t = {}; for (const k in s) t[k] = visit(s[k]); return t; }
    return s;
  };
  return visit({ a: { b: 4 } }).a.b;
}`),
    ).toBe(5);
  });

  // Guard — a recursion with no nested-closure capture never boxed at all.
  it("keeps a purely direct recursion working", async () => {
    expect(
      await runModule(`export function run() {
  const visit = (s) => {
    if (s === null || typeof s !== "object") return s;
    if (Array.isArray(s)) { const r = []; for (let i = 0; i < s.length; i++) r[i] = visit(s[i]); return r; }
    const t = {};
    for (const k in s) t[k] = visit(s[k]);
    return t;
  };
  return visit({ a: [{ b: 6 }] }).a[0].b;
}`),
    ).toBe(6);
  });
});
