// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #7106 lever SR: string receivers and arguments the IR proves statically.
// A nullish, omitted or always-`undefined` argument (an empty IIFE, a `var`
// that is never written) converts as ToString / ToInteger at compile time;
// a string-literal number argument folds through ToInteger; `search` with a
// pattern that has no RegExp syntax is the index of that text; and a fresh
// `new String(v)` receiver is ToString(v), behind lever P's trust boundary.
// Each row's expected value is the JS engine's answer, recorded with the row.

import { describe, expect, it, vi } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { isAlwaysUndefinedVar } from "../src/shared/always-undefined-binding.js";
import { ts } from "../src/ts-api.js";

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

const ARGUMENT = "expr-string-method-argument";
const SURFACE = "expr-string-method-surface";
const REGEXP_PROTOCOL = "expr-string-method-regexp-protocol";
const BORROW_RECEIVER = "expr-string-borrow-receiver";
const BORROW_PATCHED = "expr-string-borrow-patched-prototype";
const NO_CONSTRUCTOR = "expr-new-ctor-unknown";

/** Rows whose argument, pattern or receiver is not proven, with the arm that refuses each. */
const REFUSED: Record<string, readonly [...Row, arm: string]> = {
  initializedVar: ['"a".concat(initialized)', "a5", ARGUMENT],
  writtenVar: ['"a".concat(written)', "a7", ARGUMENT],
  nonEmptyIife: ['"a".concat(function () { return 1; }())', "a1", ARGUMENT],
  searchSyntax: ['"a.b".search(".")', 0, ARGUMENT],
  searchBoolean: ['"atrue".search(true)', 1, ARGUMENT],
  searchExtraArgument: ['"abc".search("c", 0)', 2, SURFACE],
  wrapperObject: ['new String({ toString() { return "o"; } }).charAt(0)', "o", BORROW_RECEIVER],
  wrapperNull: ["new String(null).charAt(0)", "n", BORROW_RECEIVER],
  wrapperNoArgument: ['new String().concat("a")', "a", NO_CONSTRUCTOR],
  wrapperNoRow: ['new String("ab").valueOf()', "ab", NO_CONSTRUCTOR],
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
const GUARDED: Record<
  string,
  { prelude: string; body: string; expected: string | number; arm: string; throws?: true }
> = {
  patchedStringWrapper: {
    prelude: 'String.prototype.charAt = function () { return "patched"; };',
    body: 'new String("ab").charAt(0)',
    expected: "patched",
    arm: BORROW_PATCHED,
  },
  patchedRegExpSearch: {
    prelude: "RegExp.prototype.exec = function () { return null; };",
    body: '"abc".search("b")',
    expected: -1,
    arm: REGEXP_PROTOCOL,
  },
  patchedRegExpSearchOmitted: {
    prelude: "RegExp.prototype.exec = function () { return null; };",
    body: '"abc".search()',
    expected: -1,
    arm: REGEXP_PROTOCOL,
  },
  patchedRegExpSearchBorrow: {
    prelude: "RegExp.prototype.exec = function () { return null; };",
    body: 'String.prototype.search.call("abc")',
    expected: -1,
    arm: REGEXP_PROTOCOL,
  },
  patchedObjectSearch: {
    prelude: "(Object.prototype as any)[Symbol.search] = function () { return 42; };",
    body: '"abc".search("b")',
    expected: 42,
    arm: REGEXP_PROTOCOL,
  },
  aliasedRegExp: {
    prelude: "var R: any = RegExp; R.prototype.exec = function () { return null; };",
    body: '"abc".search("b")',
    expected: -1,
    arm: REGEXP_PROTOCOL,
  },
  aliasedStringBorrow: {
    prelude: 'var S: any = String; S.prototype.charAt = function () { return "P"; };',
    body: 'String.prototype.charAt.call("ab", 0)',
    expected: "P",
    arm: BORROW_PATCHED,
  },
  varOfAnotherFunction: {
    prelude: "function declares() { var elsewhere: any; }",
    body: '"a".concat(elsewhere)',
    expected: "unreached",
    throws: true,
    arm: ARGUMENT,
  },
  globalNameVar: { prelude: "var NaN: any;", body: '"a".concat(NaN)', expected: "aNaN", arm: ARGUMENT },
  computedGlobalWrite: {
    prelude: 'var viaThis: any; var key = "viaThis"; (this as any)[key] = "set";',
    body: '"a".concat(viaThis)',
    expected: "aset",
    arm: ARGUMENT,
  },
  indirectEval: {
    prelude: "var viaEval: any; (0, eval)(\"viaEval = 'set'\");",
    body: '"a".concat(viaEval)',
    expected: "aset",
    arm: ARGUMENT,
  },
  // Review round 2: a constructor reached through a member, a host global name, and code built from text.
  qualifiedRegExp: {
    prelude: '(globalThis as any)["RegExp"].prototype.exec = function () { return null; };',
    body: '"abc".search("b")',
    expected: -1,
    arm: REGEXP_PROTOCOL,
  },
  qualifiedStringBorrow: {
    prelude: '(this as any).String.prototype.charAt = function () { return "P"; };',
    body: 'String.prototype.charAt.call("ab", 0)',
    expected: "P",
    arm: BORROW_PATCHED,
  },
  hostGlobalNameVar: { prelude: "var print: any;", body: '"a".concat(print)', expected: "unreached", arm: ARGUMENT },
  functionConstructorSearch: {
    prelude: 'Function("RegExp.prototype.exec = function () { return null; }")();',
    body: '"abc".search("b")',
    expected: -1,
    arm: REGEXP_PROTOCOL,
  },
  functionConstructorBorrow: {
    prelude: "Function(\"String.prototype.charAt = function () { return 'P'; }\")();",
    body: 'String.prototype.charAt.call("ab", 0)',
    expected: "P",
    arm: BORROW_PATCHED,
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

/**
 * The refusal arm (`detail`) is recorded only under `JS2WASM_IR_SHAPE_DIAG=1`,
 * which the selector reads at module load, so the refused rows compile through
 * a fresh import with the flag set (as tests/issue-7106-prophelper-isenumerable.test.ts does).
 */
async function compileWithArms(text: string, target: CompileTarget): Promise<CompileResult> {
  const previous = process.env.JS2WASM_IR_SHAPE_DIAG;
  process.env.JS2WASM_IR_SHAPE_DIAG = "1";
  vi.resetModules();
  try {
    const { compile: compileDiag } = await import("../src/index.js");
    return checked(await compileDiag(text, options(target)));
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_SHAPE_DIAG");
    else process.env.JS2WASM_IR_SHAPE_DIAG = previous;
    vi.resetModules();
  }
}

function refusedAt(result: CompileResult, name: string, arm: string): void {
  const row = outcome(result, name);
  expect(row?.irBodyEmitted, name).toBe(false);
  expect((row as { detail?: string } | undefined)?.detail, name).toMatch(new RegExp(`^${arm}:`));
}

function options(target: CompileTarget) {
  return {
    fileName: "issue-7106-lever-sr.ts",
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
    ...(target ? { target } : {}),
  };
}

function checked(result: CompileResult): CompileResult {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

async function compileTarget(text: string, target: CompileTarget): Promise<CompileResult> {
  return checked(await compile(text, options(target)));
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
    const result = await compileWithArms(source(rows as Record<string, Row>), target);
    const exports = await instantiate(result);
    for (const [name, [, , arm]] of Object.entries(REFUSED)) {
      refusedAt(result, name, arm);
      expect(exports[name]!(), name).toBe(1);
    }
  });

  for (const [name, { prelude, body, expected, arm, throws }] of Object.entries(GUARDED)) {
    it.each<CompileTarget>([undefined, "standalone"])(`keeps ${name} legacy (%s)`, async (target) => {
      const row = `export function row(): number { return ${body} === ${JSON.stringify(expected)} ? 1 : 0; }`;
      const result = await compileWithArms(`${prelude}\n${row}`, target);
      refusedAt(result, "row", arm);
      if (throws) expect((await instantiate(result)).row!).toThrow();
    });
  }

  // Review round 2: a parameter initializer cannot see a body `var` (the IR refuses such a
  // function on its parameters first, so the proof is checked directly).
  it("proves a function's var only inside its body", () => {
    const read = (text: string): ts.Identifier => {
      const file = ts.createSourceFile("proof.js", text, ts.ScriptTarget.Latest, true);
      const find = (node: ts.Node): ts.Identifier | undefined =>
        ts.isIdentifier(node) && node.text === "v" && ts.isCallExpression(node.parent)
          ? node
          : ts.forEachChild(node, find);
      return find(file)!;
    };
    expect(isAlwaysUndefinedVar(read('function f(a = "x".concat(v)) { var v; return a; }'))).toBe(false);
    expect(isAlwaysUndefinedVar(read('function f() { var v; return "x".concat(v); }'))).toBe(true);
  });
});
