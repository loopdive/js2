// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4376 — split very large synchronous module initialization into private,
// source-order helpers so a single Cranelift function body stays bounded.

import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
// Side-effect import: installs the statement/expression delegates used by
// generateModule when this test bypasses the normal compile entry point.
import "../src/codegen/expressions.js";
import {
  MODULE_INIT_CHUNK_MAX_AST_NODES,
  MODULE_INIT_CHUNK_MAX_ENTRIES,
  planModuleInitChunks,
} from "../src/codegen/module-init-chunks.js";
import { compile, compileMulti } from "../src/index.js";
import type { Instr, WasmFunction, WasmModule } from "../src/ir/types.js";
import { instantiateWasm } from "../src/runtime-instantiate.js";
import { buildImports } from "../src/runtime.js";

const FILE_NAME = "issue-4376-module-init-chunking.ts";
const EXPECTED_SEMANTIC_RESULT = 1_478_302;
const DEFAULT_PREPARED_ROUTE_SOURCE = [
  "let phase: number = 0;",
  ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES * 2 + 8 }, () => "phase = phase + 1;"),
  "export function probe(): number { return phase; }",
].join("\n");
const INLINE_CALLER_BOUNDARY_SOURCE = [
  // This stays below the inliner's single-caller cap but is much larger than
  // one planned leaf. Without a caller boundary it would be copied into the
  // first helper after planning.
  `function expand(value: number): number { return value${" + 1".repeat(80)}; }`,
  "let phase: number = 0;",
  "phase = expand(phase);",
  ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES * 2 }, () => "phase = phase + 1;"),
  "export function probe(): number { return phase; }",
].join("\n");
const SOURCE_INLINE_CALLER_BOUNDARY_SOURCE = [
  // This body is below `INLINE_MAX_INSTRS`, so the direct source inliner
  // would copy it into every planned leaf without the chunk-context admission
  // guard. Sixteen calls would then exceed the source-budget leaf bound.
  "function sourceExpand(value: number): number { return value + 1 + 1 + 1; }",
  "let phase: number = 0;",
  ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES * 2 }, () => "phase = sourceExpand(phase);"),
  "export function probe(): number { return phase; }",
].join("\n");

function constMutationAcrossChunkSource(mutation: string, declaration = "const locked: number = 1;"): string {
  return [
    declaration,
    "let phase: number = 0;",
    "let after: number = 0;",
    // Fill past one leaf. The prohibited update is consequently emitted by a
    // later helper, after `locked` has left its declaring FunctionContext.
    ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES + 4 }, () => "phase = phase + 1;"),
    `${mutation};`,
    "after = 1;",
    "export function probe(): number { return after; }",
  ].join("\n");
}

function constWriteSource(write: string, fillerCount: number, declaration = "const [locked] = [1];"): string {
  return [
    declaration,
    "let result: number = 0;",
    "let effects: number = 0;",
    ...(fillerCount === 0
      ? []
      : ["let phase: number = 0;", ...Array.from({ length: fillerCount }, () => "phase = phase + 1;")]),
    `try { ${write} } catch { result = effects; }`,
    "export function probe(): number { return result; }",
  ].join("\n");
}

function futureConstMutationSource(
  mutation: string,
  fillerCount: number,
  declaration = "const locked: number = 1;",
): string {
  return [
    "let effects: number = 0;",
    `try { ${mutation}; } catch (error) { effects += error instanceof ReferenceError ? 10 : 20; }`,
    ...(fillerCount === 0
      ? []
      : ["let phase: number = 0;", ...Array.from({ length: fillerCount }, () => "phase = phase + 1;")]),
    declaration,
    "export function probe(): number { return effects; }",
  ].join("\n");
}

function functionLocalFutureConstMutationSource(mutation: string, declaration = "const locked: number = 1;"): string {
  return [
    "export function probe(): number {",
    "  let effects: number = 0;",
    `  try { ${mutation}; } catch (error) { effects += error instanceof ReferenceError ? 10 : 20; }`,
    `  ${declaration}`,
    "  return effects;",
    "}",
  ].join("\n");
}

function generatedModule(
  source: string,
  options: Parameters<typeof generateModule>[1] = { deferTopLevelInit: true },
): WasmModule {
  const generated = generateModule(analyzeSource(source, FILE_NAME), options);
  const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
  expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
  return generated.module;
}

function moduleInitHelpers(module: WasmModule): WasmFunction[] {
  return module.functions.filter((func) => func.name.startsWith("__module_init_chunk_"));
}

function leafModuleInitHelpers(module: WasmModule): WasmFunction[] {
  return module.functions.filter((func) => /^__module_init_chunk_\d+$/.test(func.name));
}

/** Return one complete WAT function form without mistaking a helper prefix for the dispatcher. */
function watFunction(wat: string, name: string): string {
  const start = wat.indexOf(`(func $${name} `);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let index = start; index < wat.length; index++) {
    const char = wat[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') {
      quote = true;
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return wat.slice(start, index + 1);
  }
  throw new Error(`unterminated WAT function ${name}`);
}

function watFunctionNames(wat: string): readonly string[] {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  return [...imports, ...definitions];
}

/** Resolve WAT's numeric direct-call operands back to their final function names. */
function watCallTargets(wat: string, body: string): readonly string[] {
  const names = watFunctionNames(wat);
  return [...body.matchAll(/\b(?:return_)?call (\d+)/g)].map((match) => names[Number(match[1])] ?? "<missing>");
}

/** Count final WAT instructions recursively, excluding WAT-only scope forms. */
function watInstructionCount(body: string): number {
  return body
    .split("\n")
    .slice(1, -1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("(local "))
    .filter(
      (line) =>
        line !== ")" &&
        line !== "(then" &&
        line !== "(else" &&
        line !== "(do" &&
        line !== "(catch_all" &&
        !line.startsWith("(catch "),
    ).length;
}

function watModuleInitLeafNames(wat: string): readonly string[] {
  return watFunctionNames(wat).filter((name) => /^__module_init_chunk_\d+$/.test(name));
}

/** Count an emitted body including structured arms, not only its top-level array. */
function instructionCount(body: readonly Instr[]): number {
  let count = 0;
  const pending = [...body];
  while (pending.length > 0) {
    const instruction = pending.pop()!;
    count++;
    const nested = instruction as unknown as {
      body?: Instr[];
      then?: Instr[];
      else?: Instr[];
      catchAll?: Instr[];
      catches?: Array<{ body?: Instr[] }>;
    };
    for (const arm of [nested.body, nested.then, nested.else, nested.catchAll]) {
      if (arm) pending.push(...arm);
    }
    for (const caught of nested.catches ?? []) {
      if (caught.body) pending.push(...caught.body);
    }
  }
  return count;
}

async function instantiateHost(result: Awaited<ReturnType<typeof compile>>): Promise<WebAssembly.Instance> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setInstance?.(instance);
  return instance;
}

async function expectLiveChunkedPublicDispatcher(
  options: { readonly disableIrFirst?: boolean; readonly experimentalIR?: boolean } = {},
): Promise<void> {
  const result = await compile(DEFAULT_PREPARED_ROUTE_SOURCE, {
    fileName: FILE_NAME,
    deferTopLevelInit: true,
    ...options,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect([...result.wat.matchAll(/\(func \$__module_init\b/g)]).toHaveLength(1);
  const dispatcher = watFunction(result.wat, "__module_init");
  // Helpers alone could be dead after a late IR replacement. The exported
  // dispatcher itself must retain the call edge to the bounded body.
  expect(watCallTargets(result.wat, dispatcher)).toContain("__module_init_chunk_0");

  const instance = await instantiateHost(result);
  const exports = instance.exports as { __module_init: () => void; probe: () => number };
  exports.__module_init();
  expect(exports.probe()).toBe(MODULE_INIT_CHUNK_MAX_ENTRIES * 2 + 8);
}

/**
 * This places a static initializer at one helper boundary and a module closure
 * declaration at the next. Its reassignment is deliberately in a later helper;
 * the final labelled loop is one complete top-level entry as well.
 */
const SEMANTIC_SOURCE = [
  "var phase: number = 0;",
  ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES - 2 }, () => "phase = phase + 1;"),
  "class Marker { static marker: number = (phase = phase * 10 + 7); }",
  "phase = phase * 10 + 8;",
  ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES - 2 }, () => "phase = phase;"),
  "let f = (): number => phase * 10 + 2;",
  "f = (): number => phase * 10 + 3;",
  "phase = f();",
  "outer: for (let i = 0; i < 3; i += 1) { if (i === 1) continue outer; phase = phase * 10 + i; }",
  "export function probe(): number { return phase; }",
].join("\n");

describe("#4376 — bounded module-init helpers", () => {
  it("counts all nested AST children before applying the source-entry budget", () => {
    // The large binary expression is a LATER child of CallExpression. Returning
    // Array#push's number from the forEachChild callback would stop at the callee
    // and incorrectly leave both source entries in one chunk.
    const terms = Array.from({ length: MODULE_INIT_CHUNK_MAX_AST_NODES }, () => "1").join(" + ");
    const source = analyzeSource(`consume(${terms});\nphase = 1;`, FILE_NAME).sourceFile;
    const entries = source.statements.map((node) => ({ node }));
    const chunks = planModuleInitChunks(entries);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual([entries[0]]);
    expect(chunks[1]).toEqual([entries[1]]);
  });

  it("uses private [] -> [] helpers with bounded bodies behind one public dispatcher", () => {
    // More than one full fan-out level forces a compact private dispatcher tree,
    // rather than merely moving the giant body from __module_init into one call
    // list. Every user statement remains a whole planner entry.
    const source = [
      "var phase: number = 0;",
      ...Array.from(
        { length: MODULE_INIT_CHUNK_MAX_ENTRIES * MODULE_INIT_CHUNK_MAX_ENTRIES + 1 },
        () => "phase = phase + 1;",
      ),
      "export function probe(): number { return phase; }",
    ].join("\n");
    const module = generatedModule(source);
    const dispatchers = module.functions.filter((func) => func.name === "__module_init");
    const helpers = moduleInitHelpers(module);
    const leaves = leafModuleInitHelpers(module);

    expect(dispatchers).toHaveLength(1);
    expect(module.exports.filter((entry) => entry.name === "__module_init")).toHaveLength(1);
    expect(leaves.length).toBeGreaterThan(MODULE_INIT_CHUNK_MAX_ENTRIES);
    expect(helpers.some((func) => func.name.startsWith("__module_init_chunk_dispatch_"))).toBe(true);
    for (const helper of helpers) {
      expect(helper.exported).toBe(false);
      const type = module.types[helper.typeIdx];
      expect(type?.kind).toBe("func");
      if (type?.kind === "func") {
        expect(type.params).toEqual([]);
        expect(type.results).toEqual([]);
      }
    }

    // Each simple source entry emits at most four body instructions in this
    // fixture. A monolithic body exceeds this bound; a 16-entry leaf does not.
    expect(Math.max(...leaves.map((helper) => instructionCount(helper.body)))).toBeLessThanOrEqual(
      MODULE_INIT_CHUNK_MAX_ENTRIES * 8,
    );
    expect(instructionCount(dispatchers[0]!.body)).toBeLessThanOrEqual(MODULE_INIT_CHUNK_MAX_ENTRIES * 2);
  });

  it("still chunks ordinary top-level const declarations", () => {
    // TypeScript's AwaitUsing flag includes Const, so this guards the resource
    // lifetime hard-disable against accidentally treating every const as using.
    const source = [
      ...Array.from(
        { length: MODULE_INIT_CHUNK_MAX_ENTRIES + 4 },
        (_, index) => `const value${index}: number = ${index};`,
      ),
      "export function probe(): number { return value19; }",
    ].join("\n");
    const module = generatedModule(source);

    expect(leafModuleInitHelpers(module)).not.toEqual([]);
  });

  it("keeps chunk helper identities disjoint from user chunk-prefixed functions", async () => {
    // This user-visible name used to collide with the first private leaf. It
    // must remain an ordinary inlinable source function, while the allocator
    // gives the private leaf a distinct WAT name and records only that exact
    // name as an inliner boundary.
    const source = [
      `export function __module_init_chunk_0(value: number): number { return value${" + 1".repeat(16)}; }`,
      "export function callUser(): number { return __module_init_chunk_0(83); }",
      "let phase: number = 0;",
      ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES * 2 }, () => "phase = phase + 1;"),
      "export function probe(): number { return phase; }",
    ].join("\n");
    const result = await compile(source, {
      fileName: FILE_NAME,
      deferTopLevelInit: true,
      experimentalIR: false,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const names = watFunctionNames(result.wat);
    expect(new Set(names).size).toBe(names.length);
    const dispatcher = watFunction(result.wat, "__module_init");
    const dispatchTargets = watCallTargets(result.wat, dispatcher);
    expect(dispatchTargets).not.toContain("__module_init_chunk_0");
    const privateLeafNames = dispatchTargets.filter(
      (name) => name.startsWith("__module_init_chunk_") && name !== "__module_init_chunk_0",
    );
    expect(privateLeafNames.length).toBeGreaterThan(1);
    expect(
      Math.max(...privateLeafNames.map((name) => watInstructionCount(watFunction(result.wat, name)))),
    ).toBeLessThanOrEqual(MODULE_INIT_CHUNK_MAX_ENTRIES * 8);
    // The 16-add user function exceeds source-inlining's tiny body cap, so a
    // retained direct call here would prove the late marker still classified a
    // user prefix match as a private chunk helper.
    expect(watCallTargets(result.wat, watFunction(result.wat, "callUser"))).not.toContain("__module_init_chunk_0");

    const instance = await instantiateHost(result);
    const exports = instance.exports as {
      __module_init: () => void;
      __module_init_chunk_0: (value: number) => number;
      callUser: () => number;
      probe: () => number;
    };
    exports.__module_init();
    expect(exports.__module_init_chunk_0(83)).toBe(99);
    expect(exports.callUser()).toBe(99);
    expect(exports.probe()).toBe(MODULE_INIT_CHUNK_MAX_ENTRIES * 2);
  });

  it("enforces module const bindings by exact identity across helper boundaries", async () => {
    // Compound and unary updates must use the declaration oracle after the
    // declaration's helper has returned; a carried name-only set would both
    // leak unrelated bindings and conceal this path's missing lookup.
    for (const mutation of ["locked += 2", "locked++", "++locked"]) {
      const result = await compile(constMutationAcrossChunkSource(mutation), {
        fileName: FILE_NAME,
        target: "standalone",
        deferTopLevelInit: true,
        experimentalIR: false,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(watModuleInitLeafNames(result.wat).length).toBeGreaterThan(1);

      const { instance } = await WebAssembly.instantiate(result.binary, {});
      const exports = instance.exports as { __module_init: () => void; probe: () => number };
      expect(() => exports.__module_init()).toThrow();
      // Reaching this assignment would prove that the const update was lowered
      // as a normal global write instead of the required abrupt completion.
      expect(exports.probe()).toBe(0);
    }

    for (const [declaration, mutation] of [
      ["const [locked] = [1];", "locked += 2"],
      ["const { locked } = { locked: 1 };", "locked++"],
      ["const { locked } = { locked: 1 };", "++locked"],
    ]) {
      const result = await compile(constMutationAcrossChunkSource(mutation, declaration), {
        fileName: FILE_NAME,
        target: "standalone",
        deferTopLevelInit: true,
        experimentalIR: false,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const { instance } = await WebAssembly.instantiate(result.binary, {});
      const exports = instance.exports as { __module_init: () => void; probe: () => number };
      expect(() => exports.__module_init()).toThrow();
      // The oracle exposes destructured bindings as BindingElements, so these
      // cases prove the exact-const lookup climbs to its declaration list.
      expect(exports.probe()).toBe(0);
    }

    for (const [declaration, write] of [
      ["const [locked] = [1];", "locked = (effects = 1);"],
      ["const { locked } = { locked: 1 };", "locked = (effects = 1);"],
      ["const [locked] = [1];", "for (locked of [(effects = 1)]) {}"],
      ["const [locked] = [1];", "for ([locked] of [[effects = 1]]) {}"],
    ]) {
      for (const fillerCount of [0, MODULE_INIT_CHUNK_MAX_ENTRIES + 4]) {
        const result = await compile(constWriteSource(write, fillerCount, declaration), {
          fileName: FILE_NAME,
          target: "standalone",
          deferTopLevelInit: true,
          experimentalIR: false,
        });
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        const { instance } = await WebAssembly.instantiate(result.binary, {});
        const exports = instance.exports as { __module_init: () => void; probe: () => number };
        exports.__module_init();
        // Both simple assignment and each for-of write consume their RHS/value
        // before the exact destructured const binding throws TypeError.
        expect(exports.probe()).toBe(1);
      }
    }

    const nestedShadow = [
      "let value: number = 1;",
      "let phase: number = 0;",
      "{ const value: number = 2; }",
      ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES + 4 }, () => "phase = phase + 1;"),
      "value += 2;",
      "export function probe(): number { return value; }",
    ].join("\n");
    const shadowResult = await compile(nestedShadow, {
      fileName: FILE_NAME,
      target: "standalone",
      deferTopLevelInit: true,
      experimentalIR: false,
    });
    expect(shadowResult.success, shadowResult.errors.map((error) => error.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(shadowResult.binary, {});
    const shadowExports = instance.exports as { __module_init: () => void; probe: () => number };
    shadowExports.__module_init();
    // A block-local const must not affect the outer mutable binding.
    expect(shadowExports.probe()).toBe(3);

    for (const sameNameMutable of [
      [
        "{ const locked: number = 1; }",
        "let locked: number = 0;",
        "let phase: number = 0;",
        ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES + 4 }, () => "phase = phase + 1;"),
        "locked += 3;",
        "export function probe(): number { return locked; }",
      ].join("\n"),
      [
        "const locked: number = 2;",
        "class C { static value: number = 0; static { let locked: number = 1; locked += 2; C.value = locked; } }",
        "let phase: number = 0;",
        ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES + 4 }, () => "phase = phase + 1;"),
        "export function probe(): number { return C.value; }",
      ].join("\n"),
      [
        "const locked: number = 2;",
        "let observed: number = 0;",
        "namespace N { let locked: number = 1; locked += 2; observed = locked; }",
        "let phase: number = 0;",
        ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES + 4 }, () => "phase = phase + 1;"),
        "export function probe(): number { return observed; }",
      ].join("\n"),
    ]) {
      const mutableResult = await compile(sameNameMutable, {
        fileName: FILE_NAME,
        target: "standalone",
        deferTopLevelInit: true,
        experimentalIR: false,
      });
      expect(mutableResult.success, mutableResult.errors.map((error) => error.message).join("\n")).toBe(true);
      const { instance: mutableInstance } = await WebAssembly.instantiate(mutableResult.binary, {});
      const mutableExports = mutableInstance.exports as { __module_init: () => void; probe: () => number };
      mutableExports.__module_init();
      // An ended lexical is not a later module binding, while a static-block or
      // runtime-namespace local shadows the active outer const by declaration
      // identity. None may be mistaken for the outer const by a name-only set.
      expect(mutableExports.probe()).toBe(3);
    }

    const scalarProjection = [
      'const parts = "a,b".split(",");',
      "let phase: number = 0;",
      ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES + 4 }, () => "phase = phase + 1;"),
      "let observed: number = parts.length;",
      "export function probe(): number { return observed; }",
    ].join("\n");
    const scalarResult = await compile(scalarProjection, {
      fileName: FILE_NAME,
      target: "standalone",
      deferTopLevelInit: true,
      experimentalIR: false,
    });
    expect(scalarResult.success, scalarResult.errors.map((error) => error.message).join("\n")).toBe(true);
    const { instance: scalarInstance } = await WebAssembly.instantiate(scalarResult.binary, {});
    const scalarExports = scalarInstance.exports as { __module_init: () => void; probe: () => number };
    scalarExports.__module_init();
    expect(scalarExports.probe()).toBe(2);

    const closureBinding = [
      "let callback = (): number => 41;",
      "let phase: number = 0;",
      ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES + 4 }, () => "phase = phase + 1;"),
      "callback = (): number => 42;",
      ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES + 4 }, () => "phase = phase + 1;"),
      "phase = callback();",
      "export function probe(): number { return phase; }",
    ].join("\n");
    const closureResult = await compile(closureBinding, {
      fileName: FILE_NAME,
      target: "standalone",
      deferTopLevelInit: true,
      experimentalIR: false,
    });
    expect(closureResult.success, closureResult.errors.map((error) => error.message).join("\n")).toBe(true);
    const { instance: closureInstance } = await WebAssembly.instantiate(closureResult.binary, {});
    const closureExports = closureInstance.exports as { __module_init: () => void; probe: () => number };
    closureExports.__module_init();
    // `moduleBindingShadowLocals` is intentionally helper-local; every source
    // binding write is mirrored to the module global before the helper returns.
    expect(closureExports.probe()).toBe(42);
  });

  it("keeps nested, rest, and for-of writes in module storage across helpers", async () => {
    const filler = Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES + 4 }, () => "phase = phase + 1;");
    const sources = [
      {
        expected: 9,
        source: [
          "let locked: number = 0;",
          "let phase: number = 0;",
          ...filler,
          "({ nested: [locked] } = { nested: [9] });",
          "export function probe(): number { return locked; }",
        ].join("\n"),
      },
      {
        expected: 9,
        source: [
          "let locked: number = 0;",
          "let phase: number = 0;",
          ...filler,
          "({ nested: { locked } } = { nested: { locked: 9 } });",
          "export function probe(): number { return locked; }",
        ].join("\n"),
      },
      {
        expected: 29,
        source: [
          "let values: number[] = [];",
          "let phase: number = 0;",
          ...filler,
          "[...values] = [4, 5];",
          "export function probe(): number { return values.length * 10 + values[0] + values[1]; }",
        ].join("\n"),
      },
      {
        expected: 7,
        source: [
          "let locked: number = 0;",
          "let phase: number = 0;",
          ...filler,
          "for (locked of [7]) {}",
          "export function probe(): number { return locked; }",
        ].join("\n"),
      },
      {
        // The closure's helper-local shadow must follow the durable write too:
        // its immediate read occurs before this helper returns, while later
        // helpers still observe the global projection.
        expected: 2,
        source: [
          "let callback = (): number => 1;",
          "let phase: number = 0;",
          "({ nested: [callback] } = { nested: [(): number => 2] });",
          "let result: number = callback();",
          ...filler,
          "export function probe(): number { return result; }",
        ].join("\n"),
      },
    ];

    for (const { source, expected } of sources) {
      const result = await compile(source, {
        fileName: FILE_NAME,
        target: "standalone",
        deferTopLevelInit: true,
        experimentalIR: false,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(watModuleInitLeafNames(result.wat).length).toBeGreaterThan(1);
      const { instance } = await WebAssembly.instantiate(result.binary, {});
      const exports = instance.exports as { __module_init: () => void; probe: () => number };
      exports.__module_init();
      expect(exports.probe()).toBe(expected);
    }
  });

  it("keeps the default public IR route on the direct chunked module-init path", async () => {
    // `compile()` defaults experimentalIR to on. This exact lexical/scalar
    // population is otherwise eligible for the prepared one-body IR owner;
    // passing no experimentalIR option proves the admission fallback prevents
    // that route from replacing the bounded direct dispatcher.
    await expectLiveChunkedPublicDispatcher();
  });

  it("keeps the late experimental-IR overlay from replacing the live dispatcher", async () => {
    // `disableIrFirst` deliberately leaves experimentalIR enabled but moves
    // integration after direct body emission. It must obey the same central
    // selection withdrawal as the default route.
    await expectLiveChunkedPublicDispatcher({ experimentalIR: true, disableIrFirst: true });
  });

  it("chunks the combined multi-source initializer and evaluates dependencies before importers", async () => {
    // Each source contributes ten complete entries — under the per-file cap —
    // while the linked graph contributes twenty. This matches the Deno shape:
    // planning must see the complete ordered graph, not only each source file.
    const contributorEntries = MODULE_INIT_CHUNK_MAX_ENTRIES - 6;
    const files = {
      "./dependency.ts": [
        "export let dependencyValue: number = 0;",
        ...Array.from({ length: contributorEntries - 1 }, () => "dependencyValue = dependencyValue + 1;"),
        "export function dependencyProbe(): number { return dependencyValue; }",
      ].join("\n"),
      "./entry.ts": [
        'import { dependencyValue } from "./dependency";',
        "let observed: number = dependencyValue;",
        ...Array.from({ length: contributorEntries - 1 }, () => "observed = observed + 1;"),
        "export function probe(): number { return observed * 100 + dependencyValue; }",
      ].join("\n"),
    };
    const result = await compileMulti(files, "./entry.ts", {
      fileName: FILE_NAME,
      target: "standalone",
      deferTopLevelInit: true,
      experimentalIR: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect([...result.wat.matchAll(/\(func \$__module_init\b/g)]).toHaveLength(1);
    expect(watCallTargets(result.wat, watFunction(result.wat, "__module_init"))).toContain("__module_init_chunk_0");

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as { __module_init: () => void; probe: () => number };
    exports.__module_init();
    // dependencyValue reaches 9 before entry's read; observed then reaches
    // 18. A per-file or reverse-order plan would instead produce 909.
    expect(exports.probe()).toBe((contributorEntries * 2 - 2) * 100 + (contributorEntries - 1));
  });

  it("keeps destructured TDZ flags exact across same-named linked sources", async () => {
    for (const write of ["locked = (effects = 1);", "({ nested: [locked] } = { nested: [(effects = 1)] });"]) {
      for (const dynamic of [false, true]) {
        const files = {
          "./dependency.ts": [
            ...(dynamic ? ["function readDependencyLocked(): number { return locked; }"] : []),
            "let locked: number = 1;",
            "export const dependency: number = 7;",
          ].join("\n"),
          "./entry.ts": [
            'import { dependency } from "./dependency";',
            "let effects: number = 0;",
            ...(dynamic ? [`function attempt(): void { ${write} }`] : []),
            `try { ${dynamic ? "attempt();" : write} } catch (error) { effects += error instanceof ReferenceError ? 10 : 20; }`,
            "let phase: number = 0;",
            ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES + 4 }, () => "phase = phase + 1;"),
            "const { nested: [locked] } = { nested: [1] };",
            "export function probe(): number { return phase * 10000 + dependency * 100 + effects; }",
          ].join("\n"),
        };
        const result = await compileMulti(files, "./entry.ts", {
          fileName: FILE_NAME,
          target: "standalone",
          deferTopLevelInit: true,
          experimentalIR: false,
        });
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(watModuleInitLeafNames(result.wat).length).toBeGreaterThan(1);

        const { instance } = await WebAssembly.instantiate(result.binary, {});
        const exports = instance.exports as { __module_init: () => void; probe: () => number };
        exports.__module_init();
        // The RHS runs before PutValue, then the entry's exact still-zero
        // sidecar throws ReferenceError. An unrelated dependency `locked` flag
        // may be elided (static case) or initialized (dynamic case), never used.
        expect(exports.probe()).toBe(200_711);
      }
    }
  });

  it("does not let an earlier pattern initialize a later source's direct TDZ flag", async () => {
    const fillerCount = MODULE_INIT_CHUNK_MAX_ENTRIES + 4;
    const result = await compileMulti(
      {
        "./dependency.ts": "export const [locked] = [1]; export const dependency: number = 7;",
        "./entry.ts": [
          'import { dependency } from "./dependency";',
          "let effects: number = 0;",
          "try { locked = (effects = 1); } catch (error) { effects += error instanceof ReferenceError ? 10 : 20; }",
          "let phase: number = 0;",
          ...Array.from({ length: fillerCount }, () => "phase = phase + 1;"),
          "let locked: number = 2;",
          "export function probe(): number { return phase * 10000 + dependency * 100 + effects; }",
        ].join("\n"),
      },
      "./entry.ts",
      { fileName: FILE_NAME, target: "standalone", deferTopLevelInit: true, experimentalIR: false },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(watModuleInitLeafNames(result.wat).length).toBeGreaterThan(1);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as { __module_init: () => void; probe: () => number };
    exports.__module_init();
    // The dependency's pattern owns only its exact sidecar. It cannot mark the
    // entry's later direct lexical initialized through the shared spelling.
    expect(exports.probe()).toBe(fillerCount * 10_000 + 711);
  });

  it("keeps final leaf bodies bounded when the user inliner sees a large single-caller callee", async () => {
    const result = await compile(INLINE_CALLER_BOUNDARY_SOURCE, {
      fileName: FILE_NAME,
      deferTopLevelInit: true,
      experimentalIR: false,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const leafNames = watModuleInitLeafNames(result.wat);
    expect(leafNames.length).toBeGreaterThan(1);
    // This is the final emitted representation, after `inlineUserFunctions`.
    // A direct call to `expand` may remain, but its body must not be copied
    // into a source-budgeted helper after the planner has sealed that leaf.
    expect(
      Math.max(...leafNames.map((name) => watInstructionCount(watFunction(result.wat, name)))),
    ).toBeLessThanOrEqual(MODULE_INIT_CHUNK_MAX_ENTRIES * 8);

    const instance = await instantiateHost(result);
    const exports = instance.exports as { __module_init: () => void; probe: () => number };
    exports.__module_init();
    expect(exports.probe()).toBe(80 + MODULE_INIT_CHUNK_MAX_ENTRIES * 2);
  });

  it("keeps source-inlinable calls outside planned module-init leaves", async () => {
    const result = await compile(SOURCE_INLINE_CALLER_BOUNDARY_SOURCE, {
      fileName: FILE_NAME,
      deferTopLevelInit: true,
      experimentalIR: false,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const leafNames = watModuleInitLeafNames(result.wat);
    expect(leafNames.length).toBeGreaterThan(1);
    const leafBodies = leafNames.map((name) => watFunction(result.wat, name));
    // The final IR inliner is separately fenced, but this edge proves the
    // earlier `ctx.inlinableFunctions` source path was fenced as well.
    expect(leafBodies.some((body) => watCallTargets(result.wat, body).includes("sourceExpand"))).toBe(true);
    expect(Math.max(...leafBodies.map(watInstructionCount))).toBeLessThanOrEqual(MODULE_INIT_CHUNK_MAX_ENTRIES * 8);

    const instance = await instantiateHost(result);
    const exports = instance.exports as { __module_init: () => void; probe: () => number };
    exports.__module_init();
    expect(exports.probe()).toBe(3 * MODULE_INIT_CHUNK_MAX_ENTRIES * 2);
  });

  it("preserves TDZ ordering for const writes and updates", async () => {
    for (const [mutation, expectedEffects, declaration] of [
      ["locked += (effects = 1)", 10, "const locked: number = 1;"],
      ["++locked", 10, "const locked: number = 1;"],
      ["locked++", 10, "const locked: number = 1;"],
      ["for (locked of [2]) {}", 10, "const locked: number = 1;"],
      ["for ([locked] of [[2]]) {}", 10, "const locked: number = 1;"],
      ["locked = (effects = 1)", 11, "const locked: number = 1;"],
      ["[locked] = [(effects = 1)]", 11, "const [locked] = [1];"],
      ["({ locked } = { locked: (effects = 1) })", 11, "const { locked } = { locked: 1 };"],
    ] as const) {
      for (const fillerCount of [0, MODULE_INIT_CHUNK_MAX_ENTRIES + 4]) {
        const result = await compile(futureConstMutationSource(mutation, fillerCount, declaration), {
          fileName: FILE_NAME,
          target: "standalone",
          deferTopLevelInit: true,
          experimentalIR: false,
        });
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        if (fillerCount === 0) expect(watModuleInitLeafNames(result.wat)).toEqual([]);
        else expect(watModuleInitLeafNames(result.wat).length).toBeGreaterThan(1);
        const { instance } = await WebAssembly.instantiate(result.binary, {});
        const exports = instance.exports as { __module_init: () => void; probe: () => number };
        exports.__module_init();
        // Compound/update/for-of checks happen before their values are used;
        // simple assignment evaluates its RHS first, then PutValue throws.
        expect(exports.probe()).toBe(expectedEffects);
      }

      const localResult = await compile(functionLocalFutureConstMutationSource(mutation, declaration), {
        fileName: FILE_NAME,
        target: "standalone",
        experimentalIR: false,
      });
      expect(localResult.success, localResult.errors.map((error) => error.message).join("\n")).toBe(true);
      const { instance: localInstance } = await WebAssembly.instantiate(localResult.binary, {});
      expect((localInstance.exports as { probe: () => number }).probe()).toBe(expectedEffects);
    }
  });

  it("preserves static/source order, module lexical state, labelled loops, and startup routing", async () => {
    const deferred = await compile(SEMANTIC_SOURCE, { fileName: FILE_NAME, deferTopLevelInit: true });
    expect(deferred.success, deferred.errors.map((error) => error.message).join("\n")).toBe(true);
    const deferredInstance = await instantiateHost(deferred);
    const deferredExports = deferredInstance.exports as { __module_init?: () => void; probe: () => number };
    expect(typeof deferredExports.__module_init).toBe("function");
    expect(deferredExports.probe()).toBe(0);
    deferredExports.__module_init!();
    expect(deferredExports.probe()).toBe(EXPECTED_SEMANTIC_RESULT);

    const ordinary = await compile(SEMANTIC_SOURCE, { fileName: FILE_NAME });
    expect(ordinary.success, ordinary.errors.map((error) => error.message).join("\n")).toBe(true);
    const ordinaryInstance = await instantiateHost(ordinary);
    const ordinaryExports = ordinaryInstance.exports as { __module_init?: () => void; probe: () => number };
    expect(ordinaryExports.__module_init).toBeUndefined();
    expect(ordinaryExports.probe()).toBe(EXPECTED_SEMANTIC_RESULT);
  });

  it("keeps top-level try/catch whole and propagates a later helper throw", async () => {
    const source = [
      "var phase: number = 0;",
      ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES - 1 }, () => "phase = phase + 1;"),
      "try { phase = phase * 10 + 1; throw 7; } catch (error) { phase = phase * 10 + 2; }",
      "throw 99;",
      "phase = 9999;",
      "export function probe(): number { return phase; }",
    ].join("\n");
    const result = await compile(source, { fileName: FILE_NAME, target: "standalone", deferTopLevelInit: true });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.wat).toContain("(try_table");
    expect(result.wat).not.toMatch(/\(try(?:\s|$)/);
    expect(result.wat).toContain("$__module_init_chunk_1");

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as { __module_init: () => void; probe: () => number };
    expect(() => exports.__module_init()).toThrow();
    expect(exports.probe()).toBe(1512);
  });

  it("leaves top-level await unsplit while retaining the existing WASI _start route", async () => {
    const topLevelAwait = await compile(
      [
        "var phase: number = 0;",
        ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES + 4 }, () => "phase = phase + 1;"),
        "await 0;",
        "phase = phase + 1;",
        "export function probe(): number { return phase; }",
      ].join("\n"),
      { fileName: FILE_NAME, target: "standalone", deferTopLevelInit: true },
    );
    expect(topLevelAwait.success, topLevelAwait.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(topLevelAwait.wat).not.toContain("$__module_init_chunk_");

    const wasi = await compile(SEMANTIC_SOURCE, {
      fileName: FILE_NAME,
      target: "wasi",
      deferTopLevelInit: true,
    });
    expect(wasi.success, wasi.errors.map((error) => error.message).join("\n")).toBe(true);
    expect([...wasi.wat.matchAll(/\(func \$__module_init\b/g)]).toHaveLength(1);
    expect(wasi.wat).toContain("$__module_init_chunk_0");
    expect(wasi.wat).toContain("(global $__init_done");
    const exportNames = WebAssembly.Module.exports(new WebAssembly.Module(wasi.binary)).map((entry) => entry.name);
    expect(exportNames).toContain("_start");
    expect(exportNames).not.toContain("__module_init");

    const { instance } = await WebAssembly.instantiate(wasi.binary, {});
    const wasiExports = instance.exports as { _start: () => void; probe: () => number };
    wasiExports._start();
    expect(wasiExports.probe()).toBe(EXPECTED_SEMANTIC_RESULT);
  });

  it("keeps module-scope using and await using declarations in one initializer lifetime", () => {
    for (const declaration of ["using resource: any = null;", "await using resource: any = null;"]) {
      const source = [
        declaration,
        ...Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES + 4 }, (_, index) => `const value${index} = ${index};`),
        "export function probe(): number { return 1; }",
      ].join("\n");
      const module = generatedModule(source);

      expect(module.functions.filter((func) => func.name === "__module_init")).toHaveLength(1);
      expect(moduleInitHelpers(module)).toEqual([]);
    }
  });
});
