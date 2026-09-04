// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5317 r4 step 4 — `%TypedArray%.prototype.join` separator coercion.
 *
 * On base every one of these rows died with `illegal cast` (a TRAP, not a
 * failed assertion): both native join lanes cast the separator argument
 * straight to `$AnyString`, so any separator that is not already a string —
 * a plain object with a user `toString`, a Symbol, `null`, a number — took
 * down the module instead of running §23.1.3.15 step 3.
 *
 * The pins below hold the three spec arms: `undefined` ⇒ `","`, a Symbol ⇒
 * TypeError, everything else ⇒ ToString (so a throwing user `toString`
 * propagates). The `Array.prototype.join` controls are here because both
 * lanes share the emitter — a regression on the untyped lane would show up
 * as a wrong string or a re-introduced trap in exactly these cases.
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

/** Rows that flip base `fail`/trap -> `pass` with the separator coercion. */
const EXACT_ROWS = [
  "built-ins/TypedArray/prototype/join/return-abrupt-from-separator.js",
  "built-ins/TypedArray/prototype/join/return-abrupt-from-separator-symbol.js",
  "built-ins/TypedArray/prototype/join/custom-separator-result-from-tostring-on-each-value.js",
  "built-ins/TypedArray/prototype/join/custom-separator-result-from-tostring-on-each-simple-value.js",
] as const;

const HAVE_TEST262 = existsSync(join(TEST262_ROOT, "harness", "assert.js"));

async function runControl(source: string, lane: Lane): Promise<{ value: number; imports: string[] }> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5317-r4-join-separator.ts",
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
    expect(imports, "standalone join controls must emit zero imports").toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return { value: (instance.exports as { test: () => number }).test(), imports };
  }

  const built = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setInstance?.(instance);
  return { value: (instance.exports as { test: () => number }).test(), imports };
}

/** The typed-array lane: undefined => ",", object => ToString, null => "null". */
const TA_SEPARATOR_SOURCE = `
  function identity(value: any): any { return value; }

  export function test(): number {
    const sample: any = new Float64Array(identity([1, 2, 3]));

    if (sample.join(identity(undefined)) !== "1,2,3") return 1;
    if (sample.join(identity(null)) !== "1null2null3") return 2;
    if (sample.join(identity("-")) !== "1-2-3") return 3;

    const objectSeparator: any = { toString: function(): string { return "**"; } };
    if (sample.join(identity(objectSeparator)) !== "1**2**3") return 4;

    const sentinel: any = {};
    const throwing: any = { toString: function(): string { throw sentinel; } };
    try {
      sample.join(identity(throwing));
      return 5;
    } catch (error) {
      if (error !== sentinel) return 6;
    }

    try {
      sample.join(identity(Symbol("sep")));
      return 7;
    } catch (error) {
      if (!(error instanceof TypeError)) return 8;
    }
    return 0;
  }
`;

/** The untyped-array lane shares the emitter - pin it against drift. */
const ARRAY_SEPARATOR_SOURCE = `
  function identity(value: any): any { return value; }

  export function test(): number {
    const sample: any = identity([1, 2, 3]);

    if (sample.join(",") !== "1,2,3") return 1;
    if (sample.join(identity(undefined)) !== "1,2,3") return 2;
    if (sample.join(identity(null)) !== "1null2null3") return 3;

    const objectSeparator: any = { toString: function(): string { return "|"; } };
    if (sample.join(identity(objectSeparator)) !== "1|2|3") return 4;

    try {
      sample.join(identity(Symbol("sep")));
      return 5;
    } catch (error) {
      if (!(error instanceof TypeError)) return 6;
    }
    return 0;
  }
`;

const CONTROL_CASES = [
  {
    name: "typed-array join coerces undefined/null/object/Symbol separators per §23.1.3.15 step 3",
    source: TA_SEPARATOR_SOURCE,
    lanes: ["standalone"],
  },
  {
    name: "untyped-array join keeps the same three separator arms",
    source: ARRAY_SEPARATOR_SOURCE,
    lanes: ["standalone"],
  },
] as const;

describe("#5317 r4 — TypedArray.prototype.join separator coercion", () => {
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

    exactIt(`standalone exact Test262 row: ${relativePath}`, { timeout: CORPUS_TIMEOUT }, async () => {
      try {
        const result = await runTest262File(filePath, "issue-5317-standalone", RUNNER_TIMEOUT, "standalone");
        expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
      } finally {
        restoreHostBuiltins();
      }
    });
  }
});
