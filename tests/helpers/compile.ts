// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3109 — shared compile-and-run test harness.
 *
 * `tests/` re-declares a local `async function compileAndRun(source: string)`
 * in 130+ files across 10+ divergent signatures. This module extracts the
 * highest-duplication *identical-body* clusters ONCE so the copies can be
 * deleted.
 *
 * These are deliberately THREE distinct helpers, not one merged shape: the
 * clusters differ in how they wire host imports, and merging them would change
 * runtime behavior for the migrated tests (e.g. bare console-stub imports vs.
 * the full {@link buildImports} host object link different sets of imports).
 * Each function below is byte-for-byte behaviorally identical to the local copy
 * it replaces, so migration is a pure dedup with zero semantic drift. A test
 * whose local helper does something *extra* (custom import stubs, wasi knobs,
 * result-object shapes) is NOT a member of these clusters and keeps its local
 * helper.
 *
 * Import into a test file with an alias so the call sites stay unchanged, e.g.
 *   import { compileAndRunStubs as compileAndRun } from "./helpers/compile.js";
 */
import { expect } from "vitest";
import { compile } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";

/**
 * Cluster A (9 files): assert `result.success` (message includes the WAT), then
 * instantiate against bare no-op `env.console_log_*` stub imports and return the
 * exports. Used by tests whose compiled module only imports the console logging
 * builtins.
 */
export async function compileAndRunStubs(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const imports = {
    env: {
      console_log_number: () => {},
      console_log_string: () => {},
      console_log_bool: () => {},
    },
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

/**
 * Cluster B (5 files): assert `result.success` (message without WAT), then
 * instantiate against the compiler-provided `result.importObject` and return the
 * exports.
 */
export async function compileAndRunImportObject(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject!);
  return instance.exports as Record<string, Function>;
}

/**
 * Cluster C (5 files): guard on a non-empty `result.binary` (throwing on failure
 * rather than asserting `result.success`), then instantiate against the full
 * {@link buildImports} host object and return the exports. Compiles with
 * `{ fileName: "test.ts" }`.
 */
export async function compileAndRunBuildImports(source: string): Promise<Record<string, Function>> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.binary || result.binary.length === 0) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

/**
 * Cluster D (7 files — issue-779a/1678/1993/2002/2031/2669/2756): throw on
 * compile failure (plain message list, no WAT), link the full
 * {@link buildImports} host object, async-instantiate with the
 * `as unknown as WebAssembly.Imports` cast, return the exports.
 */
export async function compileAndRunHost(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return instance.exports as Record<string, Function>;
}

/**
 * Cluster E (5 files — for-of-string-generator, generators,
 * generator-method-destructuring, generator-yield-contexts, issue-287): throw
 * on compile failure (message includes the WAT), {@link buildImports} link,
 * return BOTH the exports and the instance.
 */
export async function compileAndRunInstance(source: string): Promise<{
  exports: Record<string, Function>;
  instance: WebAssembly.Instance;
}> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }

  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  // (#3032) The lazy-generator thunk contract requires consumers of
  // buildImports to wire setInstance — a lazy fn-expression generator's first
  // resume re-enters the module via the __call_fn_0 export.
  imports.setInstance?.(instance);
  return { exports: instance.exports as any, instance };
}

/**
 * Cluster F (4 files — issue-1128/1133/1134/1453): compile with
 * `{ fileName: "test.ts" }`, throw `Compile error: <first message>` on
 * failure, {@link buildImports} link, SYNCHRONOUS instantiation, call the
 * `test` export and return its value.
 */
export async function compileAndRunTestSync(src: string): Promise<any> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`Compile error: ${r.errors?.[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(r.binary), imports);
  return (instance.exports as any).test();
}

/**
 * Cluster G (3 files — issue-841/862/864, plus issue-830/1036 via
 * `optionalTest`): result-object shape — `{ success:false, error }` on compile
 * failure OR any instantiate/run throw; `{ success:true, result }` from the
 * `test` export otherwise. `optionalTest` selects the `.test?.()`
 * optional-call variant (issue-830/1036) — the only behavioral difference is
 * a missing `test` export (undefined result vs a TypeError capture).
 */
export async function compileAndRunResultObject(
  source: string,
  optionalTest = false,
): Promise<{ success: boolean; result?: number; error?: string }> {
  const compiled = await compile(source, { fileName: "test.ts" });
  if (!compiled.success) return { success: false, error: compiled.errors[0]?.message };
  try {
    const imports = buildImports(compiled.imports, undefined, compiled.stringPool);
    const mod = new WebAssembly.Module(compiled.binary);
    const inst = new WebAssembly.Instance(mod, imports);
    const ret = optionalTest ? (inst.exports as any).test?.() : (inst.exports as any).test();
    return { success: true, result: ret };
  } catch (e: any) {
    return { success: false, error: `${e.constructor.name}: ${e.message}` };
  }
}

/**
 * Cluster H (2 files — issue-1442/1444): cluster F plus a
 * `setInstance` wire-up after instantiation (host-closure callback support).
 */
export async function compileAndRunTestSyncSetExports(source: string): Promise<any> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile error: ${result.errors?.[0]?.message}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const mod = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(mod, imports);
  imports.setInstance?.(instance);
  return (instance.exports as any).test();
}

/**
 * Cluster I (2 files — issue-1494/1502): optional extra host deps threaded
 * into {@link buildImports}, a `WebAssembly.validate` guard (with WAT in the
 * message), and a `setInstance` wire-up; returns the exports.
 */
export async function compileAndRunRuntimeDeps(
  source: string,
  deps?: Record<string, unknown>,
): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  if (!WebAssembly.validate(result.binary)) {
    throw new Error(`Invalid Wasm binary\nWAT:\n${result.wat}`);
  }
  const runtimeResult = buildImports(result.imports ?? [], deps, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, runtimeResult);
  runtimeResult.setInstance?.(instance);
  return instance.exports as Record<string, Function>;
}

/**
 * Cluster J (2 files — parseint-edge, stdlib): `expect(result.success)` with
 * the WAT in the assertion message (like {@link compileAndRunStubs}) but
 * linking the full {@link buildImports} host object.
 */
export async function compileAndRunBuildImportsExpect(source: string) {
  const result = await compile(source);
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return instance.exports as Record<string, Function>;
}

/**
 * Cluster K (2 files — function-expressions, issue-280): compile and link the
 * full declared runtime-import surface, then rethrow instantiation failures
 * with the WAT. Prepared closure bodies can require string constants and
 * arity-padding helpers even when the old direct body needed only callbacks.
 */
export async function compileAndRunStubsCallback(source: string) {
  const result = await compile(source);
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    return instance.exports as Record<string, Function>;
  } catch (e) {
    throw new Error(`Instantiation failed: ${e}\nWAT:\n${result.wat}`);
  }
}

/**
 * Cluster L (2 files — issue-1127-samevalue, issue-1132-neg-zero): compile
 * with `{ fileName: "test.ts" }`, throw `Compilation failed: <first message>`
 * on failure, synchronous instantiation, return the `test` export's number.
 */
export async function compileAndRunTestSyncNumber(source: string): Promise<number> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compilation failed: ${result.errors[0]?.message}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const mod = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(mod, imports);
  return (instance.exports as any).test();
}

/**
 * Cluster M (2 files — issue-1068/1070): cluster F with all compile-error
 * messages joined by `"; "` in the throw.
 */
export async function compileAndRunTestSyncJoined(source: string): Promise<any> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile error: ${result.errors?.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const mod = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(mod, imports);
  return (instance.exports as any).test();
}

/**
 * Cluster N (2 files — issue-1594b, issue-723-tdz): bare
 * `expect(result.success)` (no message), synchronous instantiation against
 * REFLECTED no-op stub imports (those files carried their own local
 * `buildImports(wasmModule)` that synthesizes an identity-function /
 * name-string / tag stub per declared import — NOT src/runtime's
 * {@link buildImports}), return the `getResult` export's number.
 */
export async function compileAndRunGetResult(code: string): Promise<number> {
  const result = await compile(code);
  expect(result.success).toBe(true);
  const wasmModule = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(wasmModule, reflectedStubImports(wasmModule));
  const exports = instance.exports as any;
  return exports.getResult();
}

/** The cluster-N files' local import synthesizer, moved verbatim. */
function reflectedStubImports(wasmModule: WebAssembly.Module): Record<string, Record<string, any>> {
  const importObj: Record<string, Record<string, any>> = {};
  for (const imp of WebAssembly.Module.imports(wasmModule)) {
    if (!importObj[imp.module]) importObj[imp.module] = {};
    if (imp.kind === "function") {
      importObj[imp.module]![imp.name] = (...args: any[]) => args[0];
    } else if (imp.kind === "global") {
      importObj[imp.module]![imp.name] = imp.name;
    } else if (imp.kind === "tag") {
      importObj[imp.module]![imp.name] = new WebAssembly.Tag({ parameters: ["externref"] });
    }
  }
  return importObj;
}

/**
 * Cluster O (2 files — issue-1179, issue-1179-followup): call an arbitrary
 * named export with number args. Compiles with `{ fileName: "t.js" }`.
 */
export async function compileAndRunFn(src: string, fn: string, args: number[] = []): Promise<number> {
  const r = await compile(src, { fileName: "t.js" });
  if (!r.success) {
    throw new Error(`Compile failed: ${r.errors.map((e) => e.message).join(", ")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports[fn] as (...a: number[]) => number)(...args);
}

/**
 * Cluster P (2 files — issue-1024, issue-1085): compile with
 * `{ fileName: "test.ts" }`, throw `Compile error: <first message>`,
 * async instantiate, return the `test` export's number.
 */
export async function compileAndRunTestNumber(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`Compile error: ${r.errors[0]?.message}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as Record<string, Function>).test() as number;
}

/**
 * Cluster Q (6 files — the `tests/equivalence/ir-slice*` IR-vs-legacy pairs):
 * compile with `{ experimentalIR }`, throw `compile failed: <first message>`,
 * instantiate against bare no-op `env.console_log_*` stub imports, then call an
 * arbitrary named export with the given args and return its result. Callers pass
 * `experimentalIR` true/false to compare the IR path against legacy. Byte-for-byte
 * identical to the local `compileAndRun` + `ENV_STUB` these files declared.
 */
export async function compileAndRunIRVariant(
  source: string,
  fnName: string,
  args: ReadonlyArray<string | number | boolean>,
  experimentalIR: boolean,
): Promise<unknown> {
  const r = await compile(source, { experimentalIR });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "<unknown>"}`);
  }
  const imports = buildImports(
    r.imports,
    {
      console_log_number: () => {},
      console_log_string: () => {},
      console_log_bool: () => {},
    },
    r.stringPool,
  );
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const fn = instance.exports[fnName] as (...a: unknown[]) => unknown;
  return fn(...args);
}

/**
 * Cluster R (2 files — issue-298, var-hoisting): compile with
 * `{ fileName: "test.ts" }`, guard on a non-empty `result.binary` (NOT
 * `result.success` — var hoisting trips a TS "used before assigned" diagnostic
 * that is not a real codegen failure), link the full {@link buildImports} host
 * object, and return the exports.
 */
export async function compileAndRunHoistExports(source: string): Promise<Record<string, Function>> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.binary || result.binary.length === 0) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

/**
 * Cluster S (2 files — issue-1441, issue-1057): compile with
 * `{ fileName: "test.ts" }`, throw `Compile error: <first message>`, link the
 * full {@link buildImports} host object via the synchronous
 * `new WebAssembly.Module`/`Instance` path, then wire `setExports` so the runtime
 * can reach `__vec_len` for the `constructor === Array` lookup on vec wrapper
 * structs (#1441), and return the `test` export's result.
 */
export async function compileAndRunVecSetExports(source: string): Promise<any> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile error: ${result.errors?.[0]?.message}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const mod = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(mod, imports);
  imports.setInstance?.(instance);
  return (instance.exports as any).test();
}
