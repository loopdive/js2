// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7313 — rows, not arms, for the array-search and string-method calls that
// kept test module-init legacy:
//   - array `indexOf` / `lastIndexOf` / `includes` take a proven-number
//     `fromIndex`, `lastIndexOf` scans downward, and a literal boolean vec is
//     a searchable element family;
//   - a static `undefined` / `null` / `true` / `false` is a string method's
//     search or fill argument by its ToString;
//   - `replaceAll` is a row beside `replace` (the same `$`-pattern helper).
// Every expectation is node's own answer for the same literal expression.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

process.env.JS2WASM_IR_SHAPE_DIAG = "1";
const { compile } = await import("../src/index.js");
const { assembleOriginalHarness } = await import("./test262-original-harness.js");
const { originalHarnessCompileOptions, parseMeta, runTest262File } = await import("./test262-runner.js");

const LANES = ["standalone", undefined] as const;
const dir = mkdtempSync(join(tmpdir(), "issue-7313-"));

const ARRAYS: Readonly<Record<string, readonly string[]>> = {
  "[1, 2, 3, 2, 1]": ["2", "4"],
  "[1.5, NaN, -0, 0, 7]": ["NaN", "-0"],
  "[true, false, true, true]": ["true", "false"],
  "['a', 'b', 'a', 'c']": ["'a'", "'z'"],
};
const FROM_INDEX = ["", "1", "-2", "-100", "100", "NaN", "Infinity", "-Infinity", "1.7", "-1.2", "-0"];

const STRING_CALLS = [
  "'undefined'.indexOf(undefined)",
  "'undefined'.indexOf(null)",
  "'xnullx'.indexOf(null)",
  "'atruebfalse'.lastIndexOf(false)",
  "'abcundefined'.includes(undefined)",
  "'Xundefined'.endsWith(null)",
  "'ab'.padStart(5, null)",
  "'ab'.padStart(6, true)",
  "'ab'.padStart(4, undefined)",
  "'xnullxnull'.indexOf(null, true)",
  "'Ninguém é igual a ninguém.'.replaceAll('é', '$&$&')",
  "'Ninguém é igual a ninguém.'.replaceAll('é', '[$`]')",
  "'Ninguém é igual a ninguém.'.replaceAll('é', \"[$']\")",
  "'Ninguém é igual a ninguém.'.replaceAll('é', '$$')",
  "'Ninguém é igual a ninguém.'.replaceAll('é', '$1')",
  "'Ninguém é igual a ninguém.'.replaceAll('zz', 'q')",
];

function arrayCalls(): string[] {
  const calls: string[] = [];
  for (const [receiver, needles] of Object.entries(ARRAYS)) {
    for (const method of ["indexOf", "lastIndexOf", "includes"]) {
      for (const needle of needles) {
        for (const from of FROM_INDEX) calls.push(`${receiver}.${method}(${needle}${from ? `, ${from}` : ""})`);
      }
    }
  }
  return calls;
}

function literal(value: unknown): string {
  if (Object.is(value, -0)) return "-0";
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** A test262-style fixture asserting node's answer for each call. */
function fixture(name: string, calls: readonly string[]): string {
  const path = join(dir, `${name}.js`);
  const asserts = calls.map(
    (call) => `assert.sameValue(${call}, ${literal(new Function(`return ${call};`)())}, ${JSON.stringify(call)});`,
  );
  writeFileSync(path, `/*---\ndescription: issue-7313\n---*/\n${asserts.join("\n")}\n`);
  return path;
}

async function legacyUnits(path: string): Promise<string[]> {
  const source = readFileSync(path, "utf8");
  const meta = parseMeta(source);
  const variant = assembleOriginalHarness(source, meta).primary;
  const result = await compile(variant.source, {
    ...originalHarnessCompileOptions(meta, "standalone"),
    fileName: path,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? [], path).toEqual([]);
  return (result.irOutcomes ?? [])
    .filter((outcome) => !outcome.irBodyEmitted)
    .map((outcome) => `${outcome.displayName}: ${outcome.detail ?? outcome.code}`);
}

describe("#7313 literal array-search and string-method rows", () => {
  it("lowers array search with fromIndex, lastIndexOf and a boolean literal vec, as node answers", async () => {
    const path = fixture("array-search", arrayCalls());
    expect(await legacyUnits(path)).toEqual([]);
    for (const lane of LANES) {
      expect(await runTest262File(path, "issue-7313", undefined, lane)).toMatchObject({ status: "pass" });
    }
  });

  it("lowers static-literal search / fill arguments and replaceAll, as node answers", async () => {
    const path = fixture("string-methods", STRING_CALLS);
    expect(await legacyUnits(path)).toEqual([]);
    for (const lane of LANES) {
      expect(await runTest262File(path, "issue-7313", undefined, lane)).toMatchObject({ status: "pass" });
    }
  });

  it("brings the four census files to zero legacy units, passing", async () => {
    for (const file of [
      "built-ins/Array/prototype/indexOf/15.4.4.14-7-4.js",
      "built-ins/Array/prototype/lastIndexOf/15.4.4.15-8-b-i-2.js",
      "built-ins/String/prototype/indexOf/S15.5.4.7_A1_T7.js",
      "built-ins/String/prototype/replaceAll/getSubstitution-0x0024.js",
    ]) {
      const path = join("test262/test", file);
      expect(await legacyUnits(path), file).toEqual([]);
      for (const lane of LANES) {
        expect(await runTest262File(path, "issue-7313", undefined, lane), file).toMatchObject({ status: "pass" });
      }
    }
  });

  it("keeps a mixed-family vec, a non-number fromIndex and normalize legacy", async () => {
    for (const [name, call, part] of [
      ["mixed", "[0, true].lastIndexOf(true)", "array-method-unsupported"],
      ["from-string", "[1, 2].indexOf(1, '1')", "array-method-unsupported"],
      ["normalize", "'foo'.normalize('NFD')", "string-method-unsupported"],
    ] as const) {
      const units = await legacyUnits(fixture(name, [call]));
      expect(units.join("\n"), name).toContain(part);
    }
  });

  it("refuses, before the claim, a fromIndex module binding the script also writes a string to", async () => {
    const path = join(dir, "written-string.js");
    writeFileSync(
      path,
      `/*---\ndescription: issue-7313\n---*/\nvar n = 0;\nn = "1";\nassert.sameValue([1, 2, 1].indexOf(1, n), 2);\n`,
    );
    expect((await legacyUnits(path)).join("\n")).toContain("array-method-unsupported");
    for (const lane of LANES) {
      expect(await runTest262File(path, "issue-7313", undefined, lane)).toMatchObject({ status: "pass" });
    }
  });
});
