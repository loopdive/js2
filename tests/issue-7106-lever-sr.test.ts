// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #7106 lever SR: string receivers and arguments the IR proves statically.
// A nullish, omitted or always-`undefined` argument (an empty IIFE, a `var`
// that is never written) converts as ToString / ToInteger at compile time;
// a string-literal number argument folds through ToInteger; `search` with a
// pattern that has no RegExp syntax is the index of that text; and a fresh
// `new String(v)` receiver is ToString(v), behind lever P's trust boundary.
// Each row's expected value is the JS engine's answer, recorded with the row.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";

type CompileTarget = undefined | "standalone";

type Row = readonly [body: string, expected: string | number];

/** Each claimed row: compared in Wasm against the engine's answer. */
const CLAIMED: Record<string, Row> = {
  concatNull: ['"lego".concat(null)', "legonull"],
  concatUndefined: ['"lego".concat(undefined)', "legoundefined"],
  concatEmptyIife: ['"lego".concat(function () {}())', "legoundefined"],
  concatHoistedVar: ['"lego".concat(hoisted)', "legoundefined"],
  indexOfOmitted: ['"abundefined".indexOf()', 2],
  lastIndexOfUndefined: ['"undefinedxundefined".lastIndexOf(undefined)', 10],
  searchOmitted: ['"abc".search()', 0],
  searchUndefined: ['"abc".search(undefined)', 0],
  searchNull: ['"gnulluna".search(null)', 1],
  searchLiteral: ['"abcbc".search("bc")', 1],
  charAtStringNumber: ['"abc".charAt("1")', "b"],
  charAtStringNaN: ['"abc".charAt("x")', "a"],
  sliceStringNumbers: ['"abcdef".slice("1", "3.9")', "bc"],
  substringNull: ['"abc".substring(null, "2")', "ab"],
  wrapperNumber: ["new String(12).charAt(1)", "2"],
  wrapperBoolean: ["new String(true).slice(1)", "rue"],
  wrapperString: ['new String("ab").concat("c")', "abc"],
  wrapperStaticArgument: ["new String(-0).concat(undefined)", "0undefined"],
};

/** Rows whose argument or receiver is not proven: legacy answers them. */
const REFUSED: Record<string, Row> = {
  initializedVar: ['"a".concat(initialized)', "a5"],
  writtenVar: ['"a".concat(written)', "a7"],
  nonEmptyIife: ['"a".concat(function () { return 1; }())', "a1"],
  searchSyntax: ['"a.b".search(".")', 0],
  searchExtraArgument: ['"abc".search("c", 0)', 2],
  wrapperObject: ['new String({ toString() { return "o"; } }).charAt(0)', "o"],
  wrapperNull: ["new String(null).charAt(0)", "n"],
  wrapperNoArgument: ['new String().concat("a")', "a"],
};

const BINDINGS = "var hoisted: any;\nvar initialized: any = 5;\nvar written: any;\nwritten = 7;";

/**
 * A program that may patch the prototype a borrowed or `search` row reads
 * keeps it legacy; compiled, not run. (A direct call on a primitive, such as
 * `"a".concat(null)`, ignores a patched `String.prototype` on both paths
 * already; that gap predates this lever.)
 */
const PATCHED: Record<string, readonly [patch: string, body: string]> = {
  stringWrapper: [
    'String.prototype.charAt = function () { return "patched"; };',
    'new String("ab").charAt(0) === "a" ? 1 : 0',
  ],
  regexpSearch: ["RegExp.prototype.exec = function () { return null; };", '"abc".search("b") === 1 ? 1 : 0'],
};

function source(cases: Record<string, Row>): string {
  return [
    BINDINGS,
    ...Object.entries(cases).map(
      ([name, [body, expected]]) =>
        `export function ${name}(): number { return ${body} === ${JSON.stringify(expected)} ? 1 : 0; }`,
    ),
  ].join("\n");
}

async function instantiate(result: CompileResult): Promise<Record<string, () => unknown>> {
  const imports = (result.importObject ?? {}) as WebAssembly.Imports & {
    setExports?: (exports: WebAssembly.Exports) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports);
  return instance.exports as Record<string, () => unknown>;
}

function outcome(result: CompileResult, name: string): IrObservedOutcome | undefined {
  return result.irOutcomes?.find((entry) => entry.displayName === name);
}

async function compileTarget(text: string, target: CompileTarget): Promise<CompileResult> {
  const result = await compile(text, {
    fileName: "issue-7106-lever-sr.ts",
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
    ...(target ? { target } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

describe("#7106 lever SR — string receivers and arguments", () => {
  it.each<CompileTarget>([undefined, "standalone"])("claims proven rows and answers as JS (%s)", async (target) => {
    const result = await compileTarget(source(CLAIMED), target);
    const exports = await instantiate(result);
    for (const name of Object.keys(CLAIMED)) {
      expect(outcome(result, name), name).toMatchObject({ irBodyEmitted: true });
      expect(exports[name]!(), name).toBe(1);
    }
  });

  it.each<CompileTarget>([undefined, "standalone"])("keeps unproven rows legacy (%s)", async (target) => {
    const result = await compileTarget(source(REFUSED), target);
    const exports = await instantiate(result);
    for (const name of Object.keys(REFUSED)) {
      expect(outcome(result, name)?.irBodyEmitted, name).not.toBe(true);
      expect(exports[name]!(), name).toBe(1);
    }
  });

  for (const [name, [patch, body]] of Object.entries(PATCHED)) {
    it.each<CompileTarget>([undefined, "standalone"])(`keeps ${name} legacy after a patch (%s)`, async (target) => {
      const result = await compileTarget(`${patch}\nexport function row(): number { return ${body}; }`, target);
      expect(outcome(result, "row")?.irBodyEmitted).not.toBe(true);
    });
  }
});
