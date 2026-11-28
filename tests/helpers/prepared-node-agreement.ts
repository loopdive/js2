// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7354 M1) Probes of the strict Prepared entry against node. A program computes a string `out` from many guarded
// sub-checks (the realm costs ~20 s per compile, so sub-checks are batched); node evaluates the same source for the
// answer, and the Prepared program asserts it: once with node's answer (must return) and once with a wrong one (must
// throw), so a check that cannot fail is caught.
import { runInNewContext } from "node:vm";
import { expect, vi } from "vitest";
import * as gc from "../../src/codegen/index.js";
import * as linear from "../../src/codegen-linear/index.js";
import { instantiatePreparedArtifact } from "../../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedAbortBodies,
  requiredPreparedAbortSites,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../../src/test262/test262-prepared-entry.js";
import { abortSiteOf } from "../../scripts/lib/wasm-exn-render.mjs";

export const preparedOptions = (): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target: "standalone",
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName: "test.js",
    allowJs: true,
  }) as Test262CompileOptions;

/**
 * (#7354 O1) The options `scripts/test262-worker.mjs` compiles an original-harness script row with: no semantic
 * diagnostics (a test262 script passes values the lib's signatures do not admit, e.g. `{get: 1}`), a script goal.
 */
export const runnerOptions = (): Test262CompileOptions => ({
  ...preparedOptions(),
  skipSemanticDiagnostics: true,
  deferTopLevelInit: true,
  scriptGoal: true,
  inferModuleStrictArguments: false,
});

/** Error diagnostics only: a catch binding read is a harmless warning (`'e' is of type 'unknown'`). */
const errors = (result: { errors: readonly { message: string; severity?: string }[] }) =>
  result.errors.filter((error) => error.severity !== "warning").map((error) => error.message);

/**
 * A realm compile blocks the vitest worker for tens of seconds. Give vitest's pending RPC reply a moment to arrive and
 * be read first: a reply left unread across a compile past the RPC deadline fails the run ("Timeout calling
 * onTaskUpdate", exit 1). Each program is also kept to well under a minute of compile.
 */
export const yieldToRpc = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/** Compile and run `source` through the strict Prepared entry; it must compile and validate. */
export async function runPrepared(
  source: string,
  options: Test262CompileOptions = preparedOptions(),
): Promise<"returned" | "threw"> {
  for (const spy of [
    vi.spyOn(gc, "generateModule"),
    vi.spyOn(gc, "generateMultiModule"),
    vi.spyOn(linear, "generateLinearModule"),
    vi.spyOn(linear, "generateLinearMultiModule"),
  ])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
  await yieldToRpc();
  const result = await compile(source, options);
  expect(errors(result)).toEqual([]);
  expect(requiredPreparedEmission(result)).toBeDefined();
  expect(WebAssembly.validate(result.binary)).toBe(true);
  try {
    const exports = instantiatePreparedArtifact(result).instance.exports;
    (exports.__module_init as (() => void) | undefined)?.();
    return "returned";
  } catch (error) {
    expect((error as object).constructor.name).toBe("Exception");
    return "threw";
  }
}

/**
 * `source` compiles and validates, and ends at the run-time abort (`js.value.unsupported`) where node returns. The
 * realm's RuntimeError class is not this vitest context's, so the trap is matched by its class name. (#7486) With
 * `reason`, the abort is the site with that reason, read as the census reads it (`abortSiteOf`): the options must
 * defer the top-level code, so the instance exists when it traps. `node`: (#7609) a script in a fresh realm, for a
 * program that reads the global object.
 */
export async function abortsAtRunTime(
  source: string,
  options: Test262CompileOptions = preparedOptions(),
  reason?: string,
  node: (source: string) => unknown = (body) => new Function(body)(),
): Promise<void> {
  expect(() => node(source)).not.toThrow();
  await yieldToRpc();
  const result = await compile(source, options);
  expect(errors(result)).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  let instance: WebAssembly.Instance | undefined;
  let trap: unknown;
  try {
    instance = instantiatePreparedArtifact(result).instance;
    (instance.exports.__module_init as (() => void) | undefined)?.();
  } catch (error) {
    trap = error;
  }
  expect((trap as Error | undefined)?.constructor.name).toBe("RuntimeError");
  expect((trap as Error).message).toBe("unreachable");
  if (reason !== undefined) expect(abortSiteOf(instance, requiredPreparedAbortSites(result))?.detail).toBe(reason);
}

/** node's `out` for `body` (a script that assigns the string `out`). */
export const nodeOut = (body: string): string => String(new Function(`${body}\nreturn out;`)());

/**
 * (#7354 G1) node's `out` for `body` in a fresh realm: for a program that writes a built-in (`TypeError.prototype.name
 * = …`), which must reach neither this worker nor a later program.
 */
export const freshRealmOut = (body: string): string => String(runInNewContext(`${body}\n;String(out);`, {}));

/** `body`'s `out` equals node's (`node`), and a program asserting a wrong `out` throws. */
export async function agreesWithNode(
  body: string,
  withWrong = true,
  options: Test262CompileOptions = preparedOptions(),
  node: (body: string) => string = nodeOut,
): Promise<void> {
  const expected = node(body);
  const asserting = (answer: string) => `${body}\nif (out !== ${JSON.stringify(answer)}) throw 1;`;
  expect(await runPrepared(asserting(expected), options)).toBe("returned");
  if (withWrong) expect(await runPrepared(asserting(`${expected}!`), options)).toBe("threw");
}

/** `source` throws in node and in the Prepared program. */
export async function throwsAsNode(source: string): Promise<void> {
  expect(() => new Function(source)()).toThrow(TypeError);
  expect(await runPrepared(source)).toBe("threw");
}

/** (#7354 U) The functions of `source`, which must compile, whose body is the run-time abort: `name: refusal`. */
export async function abortBodies(
  source: string,
  options: Test262CompileOptions = preparedOptions(),
): Promise<string[]> {
  await yieldToRpc();
  const result = await compile(source, options);
  expect(errors(result)).toEqual([]);
  return requiredPreparedAbortBodies(result)!.map((row) => `${row.name}: ${row.detail}`);
}

/**
 * The error diagnostics of `source`, which must not compile: the name the path refuses it by. (#7354 U) Compiled
 * without abort bodies, under which a refusal inside a function becomes that function's run-time abort
 * ({@link abortBodies}).
 */
export async function refusal(source: string, options: Test262CompileOptions = preparedOptions()): Promise<string> {
  const result = await compile(source, options, undefined, "refuse");
  expect(result.success).toBe(false);
  return errors(result).join("\n");
}

/** The gap wrapper of the dynamic-value legalization around `operation`. */
export const gapText = (operation: string) => `dynamic operation ${operation} has no Prepared intrinsic`;
