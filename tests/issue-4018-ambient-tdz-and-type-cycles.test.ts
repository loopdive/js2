// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4018 / #4019 — two hard codegen aborts on the ESLint `linter.js` frontier.
//
// #4018: `ctx.tdzLetConstNames` is graph-global, but `registerModuleTdzGlobal`
// looks the owning declaration up BY NAME in whichever source file it is
// currently visiting. A package that ships both an implementation and its
// `.d.ts` declares the same name twice, and the ambient `.d.ts` declaration
// won the lookup. Ambient declarations are skipped by `collectDeclarations`, so
// that node never receives a value global — and attaching a TDZ global to it
// tripped the structural-ABI invariant "TDZ global X was observed before its
// value global", aborting the entire compile.
//
// #4019: `objectIrTypeFromTsType` and `tsTypeToFieldIr` recurse into each other
// with no cycle guard, so a self-referential type descends until the stack
// dies. The resulting `RangeError` is caught by codegen's try/catch and
// surfaces as an opaque hard error. A larger `--stack-size` does not help.
//
// The #4018 fixture is the REAL installed `minimatch` package, deliberately.
// Several synthesized approximations (virtual `.d.ts` in `compileMulti`, an
// on-disk package with a `types` entry, self-referencing arrow consts) all
// FAILED to reproduce it, so shipping one of those would have been a vacuous
// test that passes for the wrong reason. minimatch is the verified reproducer:
// on the base commit it emits the TDZ error and no binary.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compile, compileProject } from "../src/index.js";

const requireFromTests = createRequire(import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** ESM entry of the installed minimatch package, or null when unavailable. */
function findMinimatchEsmEntry(): string | null {
  const logical = resolve(repositoryRoot, "node_modules/minimatch/dist/esm/index.js");
  if (existsSync(logical)) return logical;
  try {
    const pkg = dirname(requireFromTests.resolve("minimatch/package.json"));
    const candidate = resolve(pkg, "dist/esm/index.js");
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

const minimatchEntry = findMinimatchEsmEntry();
const MINIMATCH_SKIP = "[requires installed minimatch (transitive devDependency)]";

describe("#4018 — an ambient .d.ts declaration must not own a module TDZ global", () => {
  it.skipIf(minimatchEntry === null)(
    `compiles the real minimatch package instead of aborting on the TDZ invariant ${MINIMATCH_SKIP}`,
    async () => {
      if (minimatchEntry === null) throw new Error("minimatch fixture unavailable");
      const result = await compileProject(minimatchEntry, {
        allowJs: true,
        target: "gc",
        platform: "node",
      });

      // The precise regression: this exact diagnostic aborted the compile.
      const tdzErrors = result.errors.filter((e) => e.message.includes("was observed before its value global"));
      expect(tdzErrors.map((e) => e.message)).toEqual([]);

      // And it must get far enough to actually emit something — asserting only
      // the absence of one string would pass on any other early abort.
      expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
      expect(result.binary.byteLength).toBeGreaterThan(0);
    },
    120_000,
  );
});

describe("#4019 — self-referential types must not recurse until the stack dies", () => {
  // Each shape below is a cycle the IR object-shape walk can reach. The guard
  // returns null (fall back to legacy) rather than expanding forever: an
  // IrObjectShape is a finite flat field list, so a cyclic type has no finite
  // expansion and `null` is the correct answer, not merely a safe one.
  const cyclicShapes: { name: string; source: string }[] = [
    {
      name: "direct self-reference",
      source: `interface Node { value: number; parent: Node }
export function depth(n: Node): number { return n.value + n.parent.value; }`,
    },
    {
      name: "mutual recursion",
      source: `interface A { n: number; b: B }
interface B { n: number; a: A }
export function sum(a: A): number { return a.n + a.b.n; }`,
    },
    {
      name: "three-cycle",
      source: `interface X { n: number; y: Y }
interface Y { n: number; z: Z }
interface Z { n: number; x: X }
export function sum(x: X): number { return x.n + x.y.n + x.y.z.n; }`,
    },
  ];

  for (const { name, source } of cyclicShapes) {
    it(`compiles a ${name} without a stack overflow`, async () => {
      const result = await compile(source, { target: "gc" });
      const overflow = result.errors.filter((e) => e.message.includes("Maximum call stack size exceeded"));
      expect(overflow.map((e) => e.message)).toEqual([]);
      expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
    });
  }

  // Regression guard ON the guard. A cycle check that is too aggressive is a
  // silent correctness/coverage loss rather than a crash, so both shapes below
  // are checked by RUNNING them, not merely by compiling: a shape reached twice
  // through sibling fields must still work (the set is path-scoped, not
  // visited-ever), and a genuinely cyclic shape must still compute correctly
  // through the legacy fallback the guard routes it to.
  //
  // These assert observable behaviour, not which lowering path ran —
  // `irCompiledFuncs` is empty for both shapes, so it cannot discriminate.
  const runnable: { name: string; source: string; expected: number }[] = [
    {
      name: "acyclic shape shared by two sibling fields",
      source: `interface Leaf { n: number }
interface Pair { left: Leaf; right: Leaf }
export function total(): number {
  const p: Pair = { left: { n: 2 }, right: { n: 3 } };
  return p.left.n + p.right.n;
}`,
      expected: 5,
    },
    {
      name: "cyclic shape routed to the legacy fallback",
      source: `interface Node { value: number; next: Node | null }
export function total(): number {
  const tail: Node = { value: 4, next: null };
  const head: Node = { value: 6, next: tail };
  return head.value + (head.next === null ? 0 : head.next.value);
}`,
      expected: 10,
    },
  ];

  for (const { name, source, expected } of runnable) {
    it(`computes the right answer for an ${name}`, async () => {
      const result = await compile(source, { target: "gc" });
      expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);

      // Backfill imports the convenience `importObject` omits (`string_constants`
      // is missing on main) so this cannot fail for an unrelated pre-existing gap.
      const imports = { ...(result.importObject as Record<string, Record<string, unknown>>) };
      for (const imp of WebAssembly.Module.imports(new WebAssembly.Module(result.binary))) {
        const mod = (imports[imp.module] ??= {});
        if (mod[imp.name] !== undefined) continue;
        if (imp.kind === "function") mod[imp.name] = () => undefined;
        else if (imp.kind === "global") mod[imp.name] = new WebAssembly.Global({ value: "externref" }, undefined);
      }
      const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
      expect((instance.exports as { total: () => number }).total()).toBe(expected);
    });
  }
});
