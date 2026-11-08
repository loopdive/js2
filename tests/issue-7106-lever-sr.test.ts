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
  lastIndexOfOmitted: ['"undefinedxundefined".lastIndexOf()', 10],
  lastIndexOfUndefined: ['"undefinedxundefined".lastIndexOf(undefined)', 10],
  searchOmitted: ['"abc".search()', 0],
  searchUndefined: ['"abc".search(undefined)', 0],
  searchNull: ['"gnulluna".search(null)', 1],
  searchLiteral: ['"abcbc".search("bc")', 1],
  searchSlash: ['"a/b".search("/")', 1],
  charAtStringNumber: ['"abc".charAt("1")', "b"],
  charAtStringNaN: ['"abc".charAt("x")', "a"],
  sliceStringNumbers: ['"abcdef".slice("1", "3.9")', "bc"],
  substringNull: ['"abc".substring(null, "2")', "ab"],
  borrowStaticArguments: ["String.prototype.concat.call(5, null)", "5null"],
  wrapperNumber: ["new String(12).charAt(1)", "2"],
  wrapperBoolean: ["new String(true).slice(1)", "rue"],
  wrapperString: ['new String("ab").concat("c")', "abc"],
  wrapperStaticArgument: ["new String(-0).concat(undefined)", "0undefined"],
};

/** The receiver's effect comes before the argument's: `"101".charAt(2)`, not `"102".charAt(1)`. */
const EVALUATION_ORDER =
  'export function wrapperEvaluationOrder(): number { let i = 0; return new String(100 + (i = i + 1)).charAt((i = i + 1)) === "1" ? 1 : 0; }';

/** Rows whose argument, pattern or receiver is not proven, with the reason each is refused. */
const REFUSED: Record<string, readonly [...Row, code: string]> = {
  initializedVar: ['"a".concat(initialized)', "a5", "string-method-unsupported"],
  writtenVar: ['"a".concat(written)', "a7", "string-method-unsupported"],
  nonEmptyIife: ['"a".concat(function () { return 1; }())', "a1", "string-method-unsupported"],
  searchSyntax: ['"a.b".search(".")', 0, "string-method-unsupported"],
  searchBoolean: ['"atrue".search(true)', 1, "string-method-unsupported"],
  searchExtraArgument: ['"abc".search("c", 0)', 2, "string-method-unsupported"],
  wrapperObject: ['new String({ toString() { return "o"; } }).charAt(0)', "o", "string-method-unsupported"],
  wrapperNull: ["new String(null).charAt(0)", "n", "string-method-unsupported"],
  wrapperNoArgument: ['new String().concat("a")', "a", "constructor-resolution-unsupported"],
  wrapperNoRow: ['new String("ab").valueOf()', "ab", "constructor-resolution-unsupported"],
};

const BINDINGS = "var hoisted: any;\nvar initialized: any = 5;\nvar written: any;\nwritten = 7;";

/**
 * A program whose prelude makes a row's static reading unsound keeps the row
 * legacy, refused at the string-method surface. Legacy's own answer to these
 * rows is wrong on both lanes (measured on the lever P base: it ignores the
 * patch or the computed write), so they are compiled, not compared; a read of
 * another function's `var` must still throw. (A direct call on a primitive,
 * such as `"a".trim()`, ignores a patched `String.prototype` on both paths
 * already; that gap predates this lever.)
 */
const GUARDED: Record<string, { prelude: string; body: string; expected: string | number; throws?: true }> = {
  patchedStringWrapper: {
    prelude: 'String.prototype.charAt = function () { return "patched"; };',
    body: 'new String("ab").charAt(0)',
    expected: "patched",
  },
  patchedRegExpSearch: {
    prelude: "RegExp.prototype.exec = function () { return null; };",
    body: '"abc".search("b")',
    expected: -1,
  },
  patchedRegExpSearchOmitted: {
    prelude: "RegExp.prototype.exec = function () { return null; };",
    body: '"abc".search()',
    expected: -1,
  },
  patchedRegExpSearchBorrow: {
    prelude: "RegExp.prototype.exec = function () { return null; };",
    body: 'String.prototype.search.call("abc")',
    expected: -1,
  },
  patchedObjectSearch: {
    prelude: "(Object.prototype as any)[Symbol.search] = function () { return 42; };",
    body: '"abc".search("b")',
    expected: 42,
  },
  aliasedRegExp: {
    prelude: "var R: any = RegExp; R.prototype.exec = function () { return null; };",
    body: '"abc".search("b")',
    expected: -1,
  },
  aliasedStringBorrow: {
    prelude: 'var S: any = String; S.prototype.charAt = function () { return "P"; };',
    body: 'String.prototype.charAt.call("ab", 0)',
    expected: "P",
  },
  varOfAnotherFunction: {
    prelude: "function declares() { var elsewhere: any; }",
    body: '"a".concat(elsewhere)',
    expected: "unreached",
    throws: true,
  },
  globalNameVar: { prelude: "var NaN: any;", body: '"a".concat(NaN)', expected: "aNaN" },
  computedGlobalWrite: {
    prelude: 'var viaThis: any; var key = "viaThis"; (this as any)[key] = "set";',
    body: '"a".concat(viaThis)',
    expected: "aset",
  },
  indirectEval: {
    prelude: "var viaEval: any; (0, eval)(\"viaEval = 'set'\");",
    body: '"a".concat(viaEval)',
    expected: "aset",
  },
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
    const result = await compileTarget(`${source(CLAIMED)}\n${EVALUATION_ORDER}`, target);
    const exports = await instantiate(result);
    for (const name of [...Object.keys(CLAIMED), "wrapperEvaluationOrder"]) {
      expect(outcome(result, name), name).toMatchObject({ irBodyEmitted: true });
      expect(exports[name]!(), name).toBe(1);
    }
  });

  it.each<CompileTarget>([undefined, "standalone"])("keeps unproven rows legacy (%s)", async (target) => {
    const rows = Object.fromEntries(
      Object.entries(REFUSED).map(([name, [body, expected]]) => [name, [body, expected]]),
    );
    const result = await compileTarget(source(rows as Record<string, Row>), target);
    const exports = await instantiate(result);
    for (const [name, [, , code]] of Object.entries(REFUSED)) {
      expect(outcome(result, name), name).toMatchObject({ irBodyEmitted: false, code });
      expect(exports[name]!(), name).toBe(1);
    }
  });

  for (const [name, { prelude, body, expected, throws }] of Object.entries(GUARDED)) {
    it.each<CompileTarget>([undefined, "standalone"])(`keeps ${name} legacy (%s)`, async (target) => {
      const row = `export function row(): number { return ${body} === ${JSON.stringify(expected)} ? 1 : 0; }`;
      const result = await compileTarget(`${prelude}\n${row}`, target);
      expect(outcome(result, "row")).toMatchObject({ irBodyEmitted: false, code: "string-method-unsupported" });
      if (throws) expect((await instantiate(result)).row!).toThrow();
    });
  }
});
