// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5194 slice A — the exact ES2015 TypedArray.prototype.set residuals.
 *
 * The official rows all exercise the Test262 `new TA(makeCtorArg(...))`
 * harness boundary before they reach `.set`. Keep the corpus cohort here so
 * the constructor-carrier regression and the native set implementation are
 * measured together in host and standalone modes.
 */
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
const CORPUS_TIMEOUT = 180_000;
const RUNNER_TIMEOUT = 120_000;

const EXACT_ROWS = [
  "built-ins/TypedArray/prototype/set/array-arg-negative-integer-offset-throws.js",
  "built-ins/TypedArray/prototype/set/array-arg-offset-tointeger.js",
  "built-ins/TypedArray/prototype/set/array-arg-primitive-toobject.js",
  "built-ins/TypedArray/prototype/set/array-arg-return-abrupt-from-src-get-length.js",
  "built-ins/TypedArray/prototype/set/array-arg-return-abrupt-from-src-get-value.js",
  "built-ins/TypedArray/prototype/set/array-arg-return-abrupt-from-src-length-symbol.js",
  "built-ins/TypedArray/prototype/set/array-arg-return-abrupt-from-src-length.js",
  "built-ins/TypedArray/prototype/set/array-arg-return-abrupt-from-src-tonumber-value-symbol.js",
  "built-ins/TypedArray/prototype/set/array-arg-return-abrupt-from-src-tonumber-value.js",
  "built-ins/TypedArray/prototype/set/array-arg-return-abrupt-from-tointeger-offset-symbol.js",
  "built-ins/TypedArray/prototype/set/array-arg-return-abrupt-from-tointeger-offset.js",
  "built-ins/TypedArray/prototype/set/array-arg-return-abrupt-from-toobject-offset.js",
  "built-ins/TypedArray/prototype/set/array-arg-set-values.js",
  "built-ins/TypedArray/prototype/set/array-arg-src-tonumber-value-conversions.js",
  "built-ins/TypedArray/prototype/set/array-arg-src-values-are-not-cached.js",
  "built-ins/TypedArray/prototype/set/typedarray-arg-negative-integer-offset-throws.js",
  "built-ins/TypedArray/prototype/set/typedarray-arg-offset-tointeger.js",
  "built-ins/TypedArray/prototype/set/typedarray-arg-return-abrupt-from-tointeger-offset-symbol.js",
  "built-ins/TypedArray/prototype/set/typedarray-arg-return-abrupt-from-tointeger-offset.js",
  "built-ins/TypedArray/prototype/set/typedarray-arg-set-values-diff-buffer-other-type-conversions.js",
  "built-ins/TypedArray/prototype/set/typedarray-arg-set-values-diff-buffer-other-type.js",
  "built-ins/TypedArray/prototype/set/typedarray-arg-set-values-diff-buffer-same-type.js",
  "built-ins/TypedArray/prototype/set/typedarray-arg-set-values-same-buffer-other-type.js",
  "built-ins/TypedArray/prototype/set/typedarray-arg-set-values-same-buffer-same-type.js",
  "built-ins/TypedArray/prototype/set/typedarray-arg-src-range-greather-than-target-throws-rangeerror.js",
] as const;

const HAVE_TEST262 = existsSync(join(TEST262_ROOT, "harness", "assert.js"));

async function runControl(source: string, lane: Lane): Promise<{ value: number; imports: string[] }> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5194-es2015-typedarray-set-r2.ts",
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(
    result.success,
    `${lane} control compile failed:\n${result.errors?.map((error) => `L${error.line}: ${error.message}`).join("\n") ?? ""}`,
  ).toBe(true);
  if (!result.success) return { value: -1, imports: [] };

  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  if (lane === "standalone") {
    expect(imports, "standalone TypedArray set controls must emit zero imports").toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return { value: (instance.exports as { test: () => number }).test(), imports };
  }

  const built = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setInstance?.(instance);
  return { value: (instance.exports as { test: () => number }).test(), imports };
}

/** The callback-shaped constructor source that all 25 corpus rows use. */
const CONSTRUCTOR_CONTROL_SOURCE = `
  function identity(value: any): any { return value; }

  function exercise(TA: any, makeCtorArg: any): number {
    const sample: any = new TA(makeCtorArg([1, 2, 3, 4]));
    if (sample.length !== 4 || sample[0] !== 1 || sample[1] !== 2 || sample[2] !== 3 || sample[3] !== 4) return 1;

    const result: any = sample.set([42, 43], 1);
    if (sample[0] !== 1 || sample[1] !== 42 || sample[2] !== 43 || sample[3] !== 4) return 2;
    if (result !== undefined || result === null) return 3;
    return 0;
  }

  export function test(): number {
    const first = exercise(Float64Array, identity);
    if (first !== 0) return first;
    return exercise(Int8Array, identity);
  }
`;

/** AnyValue elements must retain their payload before constructor ToNumber. */
const MIXED_CARRIER_CONTROL_SOURCE = `
  function identity(value: any): any { return value; }

  function exercise(TA: any, source: any): number {
    const sample: any = new TA(source);
    if (sample.length !== 6) return 1;
    if (sample[0] !== 1 || sample[1] !== 2 || sample[2] !== 1 || sample[3] !== 0) return 2;
    if (sample[4] === sample[4] || sample[5] !== 7) return 3;
    return 0;
  }

  export function test(): number {
    let valueOfCalls = 0;
    const objectValue: any = {
      valueOf: function(): number {
        valueOfCalls += 1;
        return 7;
      }
    };
    const source: any = identity([1, "2", true, null, undefined, objectValue]);
    const result = exercise(Float64Array, source);
    if (result !== 0) return result;
    if (valueOfCalls !== 1) return 4;
    return 0;
  }
`;

/** Array-like and primitive sources preserve observable indexed conversion. */
const ARRAYLIKE_CONTROL_SOURCE = `
  function identity(value: any): any { return value; }

  export function test(): number {
    const sample: any = new Float64Array(identity([1, 2, 3, 4, 5]));
    const source: any = { length: 2, "0": 7, "1": 17 };
    const objectResult: any = sample.set(source, 1);
    if (sample[0] !== 1 || sample[1] !== 7 || sample[2] !== 17 || sample[3] !== 4 || sample[4] !== 5) return 1;
    if (objectResult !== undefined || objectResult === null) return 2;

    const chars: any = new Float64Array(identity([1, 2, 3, 4, 5]));
    const stringResult: any = chars.set("678", 1);
    if (chars[0] !== 1 || chars[1] !== 6 || chars[2] !== 7 || chars[3] !== 8 || chars[4] !== 5) return 3;
    if (stringResult !== undefined || stringResult === null) return 4;
    return 0;
  }
`;

/** A same-buffer source must be snapshotted; a different-kind source converts. */
const BUFFER_COPY_CONTROL_SOURCE = `
  function identity(value: any): any { return value; }

  export function test(): number {
    const same: any = new Float64Array(identity([1, 2, 3, 4]));
    const sameSource: any = new Float64Array(same.buffer, 0, 2);
    const sameResult: any = same.set(sameSource, 1);
    if (same[0] !== 1 || same[1] !== 1 || same[2] !== 2 || same[3] !== 4) return 1;
    if (sameResult !== undefined || sameResult === null) return 2;

    const wide: any = new Float64Array(identity(4));
    const packed: any = new Int8Array(identity([7, 8]));
    const differentResult: any = wide.set(packed, 1);
    if (wide[0] !== 0 || wide[1] !== 7 || wide[2] !== 8 || wide[3] !== 0) return 3;
    if (differentResult !== undefined || differentResult === null) return 4;
    return 0;
  }
`;

/** A getter abrupt completes after the earlier indexed writes, as specified. */
const ABRUPT_ORDER_CONTROL_SOURCE = `
  function identity(value: any): any { return value; }

  export function test(): number {
    const sample: any = new Float64Array(identity([1, 2, 3, 4]));
    const sentinel: any = {};
    const source: any = { length: 3, "0": 42 };
    Object.defineProperty(source, "1", {
      get: function(): number { throw sentinel; }
    });
    try {
      sample.set(source);
      return 1;
    } catch (error) {
      if (error !== sentinel) return 2;
    }
    if (sample[0] !== 42 || sample[1] !== 2 || sample[2] !== 3 || sample[3] !== 4) return 3;

    const symbolSample: any = new Float64Array(identity([1, 2]));
    try {
      symbolSample.set([9], Symbol("offset"));
      return 4;
    } catch (error) {
      if (!(error instanceof TypeError)) return 5;
    }
    if (symbolSample[0] !== 1 || symbolSample[1] !== 2) return 6;
    return 0;
  }
`;

const CONTROL_CASES = [
  {
    name: "dynamic constructor carriers preserve initial values, set writes, and undefined",
    source: CONSTRUCTOR_CONTROL_SOURCE,
    lanes: ["host", "standalone"],
  },
  {
    name: "mixed AnyValue constructor elements retain numeric/string/object conversions",
    source: MIXED_CARRIER_CONTROL_SOURCE,
    lanes: ["standalone"],
  },
  {
    name: "array-like and primitive string sources retain indexed observation",
    source: ARRAYLIKE_CONTROL_SOURCE,
    lanes: ["host", "standalone"],
  },
  {
    name: "same-buffer and different-kind copies preserve set semantics",
    source: BUFFER_COPY_CONTROL_SOURCE,
    lanes: ["host", "standalone"],
  },
  {
    name: "abrupt indexed access is catchable after partial writes and Symbol offset rejects",
    source: ABRUPT_ORDER_CONTROL_SOURCE,
    lanes: ["host", "standalone"],
  },
] as const;

describe("#5194 ES2015 standalone TypedArray.prototype.set slice A", () => {
  for (const { name, source, lanes } of CONTROL_CASES) {
    if (lanes.some((lane) => lane === "host")) {
      it(`host control: ${name}`, { timeout: CORPUS_TIMEOUT }, async () => {
        expect((await runControl(source, "host")).value).toBe(0);
      });
    }

    if (lanes.some((lane) => lane === "standalone")) {
      it(`standalone control: ${name}`, { timeout: CORPUS_TIMEOUT }, async () => {
        const outcome = await runControl(source, "standalone");
        expect(outcome.value).toBe(0);
        expect(outcome.imports).toEqual([]);
      });
    }
  }

  for (const relativePath of EXACT_ROWS) {
    const filePath = join(TEST262_ROOT, "test", relativePath);
    const exactIt = HAVE_TEST262 && existsSync(filePath) ? it : it.skip;

    exactIt(`host exact Test262 row: ${relativePath}`, { timeout: CORPUS_TIMEOUT }, async () => {
      try {
        const result = await runTest262File(filePath, "issue-5194-host", RUNNER_TIMEOUT);
        expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
      } finally {
        restoreHostBuiltins();
      }
    });

    exactIt(`standalone exact Test262 row: ${relativePath}`, { timeout: CORPUS_TIMEOUT }, async () => {
      try {
        const result = await runTest262File(filePath, "issue-5194-standalone", RUNNER_TIMEOUT, "standalone");
        expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
      } finally {
        restoreHostBuiltins();
      }
    });
  }
});
