// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5212 — a standalone Map/Set subclass must consume the value already
// evaluated for `super(iterable)`. The provider is deliberately tested with
// the same literal carrier shape as direct `new Map([[k, v]])` /
// `new Set([v])`: no AST is available after the class call has crossed the
// externref boundary, and the argument must not be evaluated twice.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

type Lane = "host" | "standalone";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST262_ROOT = join(REPO_ROOT, "test262");

// These are the two exact rows allocated to this issue. They are skipped when
// the optional test262 submodule is absent from a local checkout, while CI runs
// both rows in both lanes whenever the corpus is available.
const EXACT_ROWS = [
  "language/statements/class/subclass/builtin-objects/Map/regular-subclassing.js",
  "language/statements/class/subclass/builtin-objects/Set/regular-subclassing.js",
] as const;

const CONTROL_SOURCE = `
  class ImplicitMap extends Map<number, number> {}
  class ExplicitMap extends Map<number, number> {
    constructor(entries?: ReadonlyArray<readonly [number, number]> | null) {
      super(entries);
    }
  }
  class ImplicitSet extends Set<number> {}
  class ExplicitSet extends Set<number> {
    constructor(values?: ReadonlyArray<number> | null) {
      super(values);
    }
  }

  let order = 0;
  function mapKey(): number {
    order = order * 10 + 1;
    return 1;
  }
  function mapValue(): number {
    order = order * 10 + 2;
    return 7;
  }

  export function test(): number {
    // Implicit and explicit subclass constructors both retain the native
    // iterable state, then inherited Map mutation operates on that same map.
    const implicitMap = new ImplicitMap([[1, 10], [2, 20]]);
    implicitMap.set(3, 30);
    const explicitMap = new ExplicitMap([[4, 40]]);
    explicitMap.set(5, 50);
    if (
      implicitMap.size !== 3 ||
      implicitMap.get(1) !== 10 ||
      implicitMap.get(2) !== 20 ||
      implicitMap.get(3) !== 30 ||
      explicitMap.size !== 2 ||
      explicitMap.get(4) !== 40 ||
      explicitMap.get(5) !== 50 ||
      !(implicitMap instanceof ImplicitMap) ||
      !(implicitMap instanceof Map) ||
      !(explicitMap instanceof ExplicitMap) ||
      !(explicitMap instanceof Map)
    ) return 1;

    // Set seeding uses the same native carrier contract and SameValueZero
    // storage as direct new Set construction, so duplicates do not increase size.
    const implicitSet = new ImplicitSet([1, 1, 2]);
    implicitSet.add(3);
    const explicitSet = new ExplicitSet([4, 4]);
    explicitSet.add(5);
    if (
      implicitSet.size !== 3 ||
      !implicitSet.has(2) ||
      !implicitSet.has(3) ||
      explicitSet.size !== 2 ||
      !explicitSet.has(4) ||
      !explicitSet.has(5) ||
      !(implicitSet instanceof ImplicitSet) ||
      !(implicitSet instanceof Set) ||
      !(explicitSet instanceof ExplicitSet) ||
      !(explicitSet instanceof Set)
    ) return 2;

    // The callbacks run while the source array is materialized. The provider
    // must only read that carrier, preserving order and avoiding re-evaluation.
    const ordered = new ImplicitMap([[mapKey(), mapValue()]]);
    if (order !== 12 || ordered.get(1) !== 7 || ordered.size !== 1) return 3;

    // Missing, null, and undefined iterable arguments all produce empty
    // collections, matching direct native Map/Set construction.
    const emptyMap = new ImplicitMap();
    const nullMap = new ImplicitMap(null);
    const undefinedMap = new ImplicitMap(undefined);
    const emptySet = new ImplicitSet();
    const nullSet = new ImplicitSet(null);
    const undefinedSet = new ImplicitSet(undefined);
    return emptyMap.size === 0 && nullMap.size === 0 && undefinedMap.size === 0 &&
      emptySet.size === 0 && nullSet.size === 0 && undefinedSet.size === 0 ? 0 : 4;
  }
`;

async function runControl(source: string, lane: Lane): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    fileName: "issue-5212-es2015-class-collection-super.ts",
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(
    result.success,
    `${lane} control compile failed:\n${result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")}`,
  ).toBe(true);
  if (!result.success) return -1;

  if (lane === "standalone") {
    const imports = result.imports.map((entry) => `${entry.module}::${entry.name}`);
    expect(imports, "Map/Set subclass controls must stay host-free").toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return (instance.exports as { test: () => number }).test();
  }

  const built = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

async function runExactRow(relativePath: (typeof EXACT_ROWS)[number], lane: Lane) {
  const filePath = join(TEST262_ROOT, "test", relativePath);
  try {
    return await runTest262File(filePath, `issue-5212-${lane}`, 120_000, lane === "standalone" ? lane : undefined);
  } finally {
    restoreHostBuiltins();
  }
}

describe("#5212 standalone Map/Set subclass iterable construction", () => {
  it("host control retains iterable state, ordering, identity, and empty forms", async () => {
    await expect(runControl(CONTROL_SOURCE, "host")).resolves.toBe(0);
  });

  it("standalone control retains iterable state without host imports", async () => {
    await expect(runControl(CONTROL_SOURCE, "standalone")).resolves.toBe(0);
  });

  for (const relativePath of EXACT_ROWS) {
    const filePath = join(TEST262_ROOT, "test", relativePath);
    const exactIt = existsSync(filePath) && existsSync(join(TEST262_ROOT, "harness", "assert.js")) ? it : it.skip;

    exactIt(`host exact Test262 row: ${relativePath}`, { timeout: 180_000 }, async () => {
      const result = await runExactRow(relativePath, "host");
      expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    });

    exactIt(`standalone exact Test262 row: ${relativePath}`, { timeout: 180_000 }, async () => {
      const result = await runExactRow(relativePath, "standalone");
      expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    });
  }
});
