// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5124 — Map/Set zero-argument prototype methods must carry spec-correct
// `length` metadata in standalone, including the reflective closure surface.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";

type Lane = "host" | "standalone";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST262_ROOT = join(REPO_ROOT, "test262");

const OWNED_ROWS = [
  "built-ins/Map/prototype/clear/length.js",
  "built-ins/Map/prototype/entries/length.js",
  "built-ins/Map/prototype/keys/length.js",
  "built-ins/Map/prototype/values/length.js",
  "built-ins/Set/prototype/clear/length.js",
  "built-ins/Set/prototype/entries/length.js",
  "built-ins/Set/prototype/values/length.js",
] as const;

const ARRAY_SIBLING_ROWS = [
  "built-ins/Array/prototype/entries/length.js",
  "built-ins/Array/prototype/keys/length.js",
  "built-ins/Array/prototype/values/length.js",
] as const;

const EXACT_ROWS = [...OWNED_ROWS, ...ARRAY_SIBLING_ROWS] as const;

const CONTROL_SOURCE = `
  function read(proto: any, key: string): any {
    return proto[key];
  }

  function checkMetadata(fn: any, expectedName: string, expectedLength: number): number {
    if (typeof fn !== "function" || fn.name !== expectedName || fn.length !== expectedLength) return 0;
    const lengthDescriptor: any = Object.getOwnPropertyDescriptor(fn, "length");
    const nameDescriptor: any = Object.getOwnPropertyDescriptor(fn, "name");
    if (
      lengthDescriptor === undefined ||
      lengthDescriptor.value !== expectedLength ||
      lengthDescriptor.writable !== false ||
      lengthDescriptor.enumerable !== false ||
      lengthDescriptor.configurable !== true
    ) return 0;
    if (
      nameDescriptor === undefined ||
      nameDescriptor.value !== expectedName ||
      nameDescriptor.writable !== false ||
      nameDescriptor.enumerable !== false ||
      nameDescriptor.configurable !== true
    ) return 0;
    return 1;
  }

  function checkPrototypeDescriptor(proto: any, key: string): number {
    const descriptor: any = Object.getOwnPropertyDescriptor(proto, key);
    return descriptor !== undefined &&
      descriptor.writable === true &&
      descriptor.enumerable === false &&
      descriptor.configurable === true ? 1 : 0;
  }

  export function test(): number {
    // Direct reads cover all seven ES2015 Map/Set rows and the three analogous
    // Array sibling controls. The expected total keeps every row mandatory.
    let checks = 0;
    checks += checkMetadata(Map.prototype.clear, "clear", 0);
    checks += checkMetadata(Map.prototype.entries, "entries", 0);
    checks += checkMetadata(Map.prototype.keys, "keys", 0);
    checks += checkMetadata(Map.prototype.values, "values", 0);
    checks += checkMetadata(Set.prototype.clear, "clear", 0);
    checks += checkMetadata(Set.prototype.entries, "entries", 0);
    // Set.prototype.keys is specified as an alias of values, so SetFunctionName
    // exposes the canonical function name "values" for both spellings.
    checks += checkMetadata(Set.prototype.keys, "values", 0);
    checks += checkMetadata(Set.prototype.values, "values", 0);
    checks += checkMetadata(Array.prototype.entries, "entries", 0);
    checks += checkMetadata(Array.prototype.keys, "keys", 0);
    checks += checkMetadata(Array.prototype.values, "values", 0);
    if (checks !== 11) return 1;

    // Runtime-key reads must use the same metadata carrier as direct reads.
    const mapProto: any = Map.prototype;
    const setProto: any = Set.prototype;
    const arrayProto: any = Array.prototype;
    if (checkMetadata(read(mapProto, "clear"), "clear", 0) !== 1) return 2;
    if (checkMetadata(read(mapProto, "entries"), "entries", 0) !== 1) return 3;
    if (checkMetadata(read(mapProto, "keys"), "keys", 0) !== 1) return 4;
    if (checkMetadata(read(mapProto, "values"), "values", 0) !== 1) return 5;
    if (checkMetadata(read(setProto, "clear"), "clear", 0) !== 1) return 6;
    if (checkMetadata(read(setProto, "entries"), "entries", 0) !== 1) return 7;
    if (checkMetadata(read(setProto, "keys"), "values", 0) !== 1) return 8;
    if (checkMetadata(read(setProto, "values"), "values", 0) !== 1) return 9;
    if (checkMetadata(read(arrayProto, "entries"), "entries", 0) !== 1) return 10;
    if (checkMetadata(read(arrayProto, "keys"), "keys", 0) !== 1) return 11;
    if (checkMetadata(read(arrayProto, "values"), "values", 0) !== 1) return 12;

    // Set.keys and Set.values are one intrinsic function object; the alias must
    // survive both direct and dynamic reads. Symbol.iterator is the same alias.
    if (Set.prototype.keys !== Set.prototype.values) return 13;
    if (read(setProto, "keys") !== read(setProto, "values")) return 14;
    if (Set.prototype[Symbol.iterator] !== Set.prototype.values) return 15;

    // Prototype properties themselves retain ordinary writable method
    // descriptors, while the function metadata above remains non-writable.
    if (checkPrototypeDescriptor(Map.prototype, "clear") !== 1) return 16;
    if (checkPrototypeDescriptor(Map.prototype, "entries") !== 1) return 17;
    if (checkPrototypeDescriptor(Map.prototype, "keys") !== 1) return 18;
    if (checkPrototypeDescriptor(Map.prototype, "values") !== 1) return 19;
    if (checkPrototypeDescriptor(Set.prototype, "clear") !== 1) return 20;
    if (checkPrototypeDescriptor(Set.prototype, "entries") !== 1) return 21;
    if (checkPrototypeDescriptor(Set.prototype, "keys") !== 1) return 22;
    if (checkPrototypeDescriptor(Set.prototype, "values") !== 1) return 23;

    // Non-zero siblings guard the shared fallback and the Map-specific arity
    // override. These are deliberately actual metadata reads, not corpus rows.
    if (Map.prototype.set.length !== 2) return 24;
    if (Map.prototype.get.length !== 1) return 25;
    if (Map.prototype.forEach.length !== 1) return 26;
    if (Set.prototype.add.length !== 1) return 27;
    if (Set.prototype.forEach.length !== 1) return 28;
    if (Array.prototype.concat.length !== 1) return 29;

    // Actual zero-argument collection calls remain live and host-free: clear
    // mutates state without pulling the unrelated instance-iterator bridge into
    // this standalone import census.
    const map: any = new Map();
    map.set(1, 10);
    map.set(2, 20);
    map.clear();
    if (map.size !== 0) return 30;

    const set: any = new Set();
    set.add(4);
    set.add(5);
    set.clear();
    if (set.size !== 0) return 31;

    // TypedArray has a separate table: its direct iterator metadata remains
    // zero. Keep this static non-regression control host-free; a dynamic
    // concrete-view method call belongs to the existing TypedArray iterator
    // suite and would add unrelated view-dispatch imports to this module.
    if (Int8Array.prototype.entries.length !== 0) return 32;
    if (Int8Array.prototype.keys.length !== 0) return 33;
    if (Int8Array.prototype.values.length !== 0) return 34;
    return 0;
  }
`;

async function runControl(lane: Lane): Promise<{ value: number; imports: string[] }> {
  const result = await compile(CONTROL_SOURCE, {
    allowJs: true,
    fileName: "issue-5124-es2015-prototype-method-zero-arity.ts",
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(
    result.success,
    `${lane} control compile failed:\n${result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")}`,
  ).toBe(true);
  if (!result.success) return { value: -1, imports: [] };

  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  if (lane === "standalone") expect(imports, "standalone controls must emit zero imports").toEqual([]);

  if (lane === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return { value: (instance.exports as { test: () => number }).test(), imports };
  }

  const built = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setInstance?.(instance);
  return { value: (instance.exports as { test: () => number }).test(), imports };
}

async function runExactRow(relativePath: (typeof EXACT_ROWS)[number], lane: Lane) {
  const filePath = join(TEST262_ROOT, "test", relativePath);
  try {
    return await runTest262File(filePath, `issue-5124-${lane}`, 120_000, lane === "standalone" ? lane : undefined);
  } finally {
    // Keep this wrapper's cleanup explicit so adding another exact row cannot
    // leak a mutated host builtin between authoritative runs.
    restoreHostBuiltins();
  }
}

describe("#5124 ES2015 Map/Set zero-arity prototype metadata", () => {
  it("host controls cover owned/sibling arities, aliases, calls, and TypedArray", async () => {
    const outcome = await runControl("host");
    expect(outcome.value).toBe(0);
  });

  it("standalone controls cover owned/sibling arities, aliases, calls, and TypedArray", async () => {
    const outcome = await runControl("standalone");
    expect(outcome.value).toBe(0);
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
