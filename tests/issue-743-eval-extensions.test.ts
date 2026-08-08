// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #743 — the SATELLITE evaluator extensions, levers 2 and 3
// (src/ir/fnctor-module-consts.ts + the conditional-join rule in
// src/ir/fnctor-eval-extensions.ts).
//
// The `Scope.flags` probe measured that acorn's slot needs EXACTLY three
// evaluator rules and that any two of them move nothing: the bitwise producer
// (shipped in the previous slice, pinned by tests/issue-743-i32-producers.ts),
// module-level numeric constants, and condition-agnostic conditionals. These
// two are the ones added here.
//
// What is expensive to get wrong, in order:
//
//  1. MODULE-CONSTANT SOUNDNESS. A `var X = 1` binding is a Number only if it
//     is (a) initialised from a constant numeric expression, (b) never written
//     anywhere in the module, and (c) never READ while it still holds its
//     hoisted `undefined`. The negatives below are one per obligation, and they
//     are the tests that matter — the positives only prove the rule fires.
//  2. SYMBOL, NOT NAME. A parameter that shadows a module constant must keep
//     its own fact.
//  3. THE ToPrimitive BOUNDARY IS UNCHANGED. Neither new rule may make an
//     `object` operand count as proof for the bitwise producer.

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { fnctorFieldProvenanceRecords, resetFnctorFieldProvenance } from "../src/codegen/fnctor-field-provenance.js";
import { compile } from "../src/index.js";
import { computeFnctorGraphCtorParamFacts } from "../src/ir/fnctor-method-edges.js";
import { ts } from "../src/ts-api.js";

function fixture(source: string): { checker: ts.TypeChecker; file: ts.SourceFile } {
  const files = new Map([
    ["/repo/a.ts", source],
    ["/repo/lib.d.ts", "declare var undefined: undefined;"],
  ]);
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noImplicitAny: false,
    strict: false,
    target: ts.ScriptTarget.ES2022,
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName) => files.has(fileName),
    readFile: (fileName) => files.get(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const text = files.get(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(["/repo/a.ts"], options, host);
  return { checker: program.getTypeChecker(), file: program.getSourceFile("/repo/a.ts")! };
}

/** The satellite's fact for `P`'s single constructor parameter, as the consumer reads it. */
function paramKind(source: string): string {
  const { checker, file } = fixture(source);
  return computeFnctorGraphCtorParamFacts(file, { checker }).get("P")?.[0]?.kind ?? "<none>";
}

const CTOR = "var P = function P(v) { this.v = v; };";
/**
 * `ts.isExternalModule` is a precondition of the module-constant rule (a
 * script's top-level `var` is a writable global-object property), so every
 * fixture that exercises it must actually be a module.
 */
const MODULE_MARK = "export function __keep() { return 1; }";

/** `new P(arg)` inside an UNREFERENCED top-level function — nothing runs during module init. */
function inLateFunction(arg: string, module: string): string {
  return `${CTOR}\nfunction mk(a, b) { return new P(${arg}); }\n${module}\n${MODULE_MARK}`;
}

describe("#743 module-constant rule — the fact", () => {
  it("a top-level numeric `var` types the argument it is passed as", () => {
    expect(paramKind(inLateFunction("K", "var K = 7;"))).toBe("f64");
  });

  it("`let` and `const` work the same way", () => {
    expect(paramKind(inLateFunction("K", "const K = 7;"))).toBe("f64");
    expect(paramKind(inLateFunction("K", "let K = 7;"))).toBe("f64");
  });

  it("a constant DERIVED from earlier constants resolves (acorn's `SCOPE_VAR` shape)", () => {
    // Same statement, left-to-right — the shape acorn actually ships:
    //   var SCOPE_TOP = 1, …, SCOPE_VAR = SCOPE_TOP | SCOPE_FUNCTION;
    expect(paramKind(inLateFunction("C", "var A = 1, B = 2, C = A | B;"))).toBe("f64");
    expect(paramKind(inLateFunction("C", "var A = 1;\nvar B = 2;\nvar C = (A | B) + 4;"))).toBe("f64");
  });

  it("feeds the bitwise producer — one proven operand is all it needs", () => {
    // This composition is the whole point: without the constant, `a | MASK`
    // has two unproven operands and stays DYNAMIC for the BigInt guard.
    expect(paramKind(inLateFunction("a | MASK", "var MASK = 255;"))).toBe("i32");
    expect(paramKind(inLateFunction("a | b", "var MASK = 255;"))).toBe("dynamic");
  });

  it("resolves by SYMBOL — a parameter of the same name keeps its own fact", () => {
    const source = `${CTOR}
var K = 7;
function mk(K) { return new P(K); }
function call() { return mk("s"); }
${MODULE_MARK}`;
    expect(paramKind(source)).toBe("string");
  });
});

describe("#743 module-constant rule — obligation 1: the value", () => {
  it("a non-constant initializer is refused", () => {
    expect(paramKind(inLateFunction("K", "function f() { return 1; }\nvar K = f();"))).toBe("dynamic");
    expect(paramKind(inLateFunction("K", "var K = Date.now();"))).toBe("dynamic");
  });

  it("a non-numeric initializer is refused", () => {
    expect(paramKind(inLateFunction("K", 'var K = "7";'))).toBe("dynamic");
    expect(paramKind(inLateFunction("K", "var K = {};"))).toBe("dynamic");
  });

  it("a BigInt literal is refused — `1n | 2n` is a BigInt, not an Int32", () => {
    expect(paramKind(inLateFunction("K", "var K = 1n;"))).toBe("dynamic");
    expect(paramKind(inLateFunction("K", "var K = 1n | 2n;"))).toBe("dynamic");
  });

  it("a FORWARD reference resolves nothing — and takes the referent with it", () => {
    // `C` is refused because `A` is not yet accepted when its initializer is
    // evaluated; `A` is refused because it has a read (inside C's initializer)
    // at a top-level statement that runs BEFORE its own declaration.
    const module = "var C = A | 1;\nvar A = 2;";
    expect(paramKind(inLateFunction("C", module))).toBe("dynamic");
    expect(paramKind(inLateFunction("A", module))).toBe("dynamic");
  });
});

describe("#743 module-constant rule — obligation 2: never written", () => {
  it.each([
    ["plain reassignment", "function poke() { K = 2; }"],
    ["reassignment to a non-number", 'function poke() { K = "s"; }'],
    ["compound bitwise assignment", "function poke() { K |= 1; }"],
    ["increment", "function poke() { K++; }"],
    ["decrement", "function poke() { --K; }"],
    ["array destructuring target", "function poke(a) { [K] = a; }"],
    ["object destructuring target", "function poke(o) { ({ K } = o); }"],
    ["renamed object destructuring target", "function poke(o) { ({ p: K } = o); }"],
    ["for-of target", "function poke(a) { for (K of a) { } }"],
  ])("%s anywhere in the module poisons the constant", (_label, writer) => {
    expect(paramKind(inLateFunction("K", `var K = 7;\n${writer}`))).toBe("dynamic");
  });

  it("a read that merely SITS in an assignment LHS is not a write", () => {
    // `obj[K] = 1` reads K. Treating the whole LHS subtree as a write would be
    // sound but would reject exactly the mask-and-index constants this rule is
    // for, so the walk climbs only the destructuring "pattern spine".
    expect(paramKind(inLateFunction("K", "var K = 7;\nfunction poke(o) { o[K] = 1; }"))).toBe("f64");
  });

  it("`with` and direct `eval` poison every constant in the module", () => {
    // Both can name a binding without leaving an identifier occurrence for the
    // write scan to see.
    expect(paramKind(inLateFunction("K", "var K = 7;\nfunction poke(o) { with (o) { } }"))).toBe("dynamic");
    expect(paramKind(inLateFunction("K", 'var K = 7;\nfunction poke() { eval("K = 2"); }'))).toBe("dynamic");
  });

  it("a script (no module marker) is refused — its top-level `var` is a global property", () => {
    expect(paramKind(`${CTOR}\nfunction mk(a, b) { return new P(K); }\nvar K = 7;`)).toBe("dynamic");
  });
});

describe("#743 module-constant rule — obligation 3: never read before initialisation", () => {
  // `var K = 1` holds `undefined` from module instantiation until its own
  // statement runs. An f64 fact for a read in that window turns `undefined`
  // into NaN at a coercing store — the same hazard `readFieldFact` refuses for
  // a field outside its definiteness snapshot.

  it("a hoisted reader CALLED before the declaration poisons it", () => {
    const source = `${CTOR}
var early = readK();
function readK() { return K; }
var K = 7;
function mk(a, b) { return new P(K); }
${MODULE_MARK}`;
    expect(paramKind(source)).toBe("dynamic");
  });

  it("the same hoisted reader, referenced only AFTER the declaration, is fine", () => {
    // The bound for a hoisted declaration comes from its REFERENCES, not from
    // statement 0. Costing it at 0 instead — the obvious conservative shortcut
    // — rejects acorn's `functionFlags` and with it the entire lever.
    const source = `${CTOR}
function readK() { return K; }
var K = 7;
var late = readK();
function mk(a, b) { return new P(K); }
${MODULE_MARK}`;
    expect(paramKind(source)).toBe("f64");
  });

  it("a top-level read before the declaration poisons it", () => {
    const source = `${CTOR}
var snapshot = K;
var K = 7;
function mk(a, b) { return new P(K); }
${MODULE_MARK}`;
    expect(paramKind(source)).toBe("dynamic");
  });

  it("an IIFE before the declaration poisons it", () => {
    const source = `${CTOR}
var early = (function () { return K; })();
var K = 7;
function mk(a, b) { return new P(K); }
${MODULE_MARK}`;
    expect(paramKind(source)).toBe("dynamic");
  });

  it("an import makes every hoisted declaration unbounded (cyclic-import callback)", () => {
    // A cycle can call an exported function before this module's top level has
    // run, so with any import present a hoisted declaration has no lower bound
    // at all and the constants its body reads are refused.
    const source = `import { x } from "./other.js";
${CTOR}
function readK() { return K; }
var K = 7;
function mk(a, b) { return new P(K); }
${MODULE_MARK}`;
    expect(paramKind(source)).toBe("dynamic");
  });
});

describe("#743 conditional-join rule", () => {
  it("a DYNAMIC condition no longer discards both branches", () => {
    expect(paramKind(inLateFunction("a ? 1 : 2", ""))).toBe("f64");
  });

  it("a NUMBER condition works too — the core's guard admits only bool/unknown", () => {
    // `boolCompatible` is `bool || unknown`, so even `1 ? 2 : 3` was DYNAMIC
    // before this rule. ToBoolean is total over every type, including Number.
    expect(paramKind(inLateFunction("1 ? 2 : 3", ""))).toBe("f64");
    expect(paramKind(inLateFunction('"s" ? 2 : 3', ""))).toBe("f64");
  });

  it("the result is the JOIN, so disagreeing branches still widen", () => {
    expect(paramKind(inLateFunction('a ? 1 : "s"', ""))).toBe("union");
    // An EMPTY object literal is the core's DYNAMIC, and DYNAMIC absorbs. (A
    // bare unresolved parameter would NOT widen: `unknown` is lattice bottom,
    // so `join(f64, unknown)` is `f64` — the join is not a "disagreement" test.)
    expect(paramKind(inLateFunction("a ? 1 : ({})", ""))).toBe("dynamic");
  });

  it("composes with the module constants and the bitwise producer", () => {
    // acorn's shape: `SCOPE_FUNCTION | (async ? SCOPE_ASYNC : 0)`.
    expect(paramKind(inLateFunction("A | (a ? B : 0)", "var A = 2, B = 4;"))).toBe("i32");
    // …and the conditional is reached through the producer's operand recursion.
    expect(paramKind(inLateFunction("(a ? 1 : 2) | b", ""))).toBe("i32");
  });

  it("an OBJECT-valued conditional is still NOT proof for the bitwise producer", () => {
    // The ToPrimitive boundary from the previous slice: an `object` atom may
    // carry a `Symbol.toPrimitive` returning a BigInt. Neither new rule may
    // widen what counts as proof.
    expect(paramKind(inLateFunction("(a ? { x: 1 } : { x: 2 }) | b", ""))).toBe("dynamic");
    expect(paramKind(inLateFunction("({ x: 1 }) | b", ""))).toBe("dynamic");
  });
});

// ── End-to-end: a slot that needs BOTH new rules reaches the emitted binary ──

// `S.flags` is written only from `on ? LO : HI`: no bitwise operator anywhere,
// so the previous slice's producer rule cannot type it, and both module
// constants and the conditional join are required.
const E2E_SRC = `
var LO = 1;
var HI = 2;
var S = function S(flags) { this.flags = flags; };
function enter(on) { return new S(on ? LO : HI); }
export function top() { return enter(1).flags === 1 && enter(0).flags === 2 ? 1 : -1; }
`;

async function compileE2E(): Promise<{ binary: Uint8Array; slots: Map<string, string> }> {
  resetFnctorFieldProvenance();
  const r = await compile(E2E_SRC, {
    fileName: "t.mjs",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(r.success, r.errors.map((e) => e.message).join("; ")).toBe(true);
  const slots = new Map<string, string>();
  for (const rec of fnctorFieldProvenanceRecords()) slots.set(`${rec.owner}.${rec.field}`, rec.slot);
  return { binary: r.binary as Uint8Array, slots };
}

async function run(binary: Uint8Array): Promise<unknown> {
  const module = await WebAssembly.compile(binary);
  if (WebAssembly.Module.imports(module).length > 0) return "has-imports";
  const { exports } = await WebAssembly.instantiate(module, {});
  return (exports as { top(): unknown }).top();
}

describe("#743 evaluator extensions — end to end", () => {
  const savedCtor = process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES;
  const savedProv = process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE;
  beforeEach(() => {
    resetFnctorFieldProvenance();
    process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE = "1";
    // (#743 defaults flip) The field-SLOT consumer is opt-in — see
    // src/derivation-flags.ts. These pins are about it, so they ask for it.
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_SLOTS = "1";
  });
  afterEach(() => {
    resetFnctorFieldProvenance();
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
    if (savedCtor === undefined) delete process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES;
    else process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = savedCtor;
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
    if (savedProv === undefined) delete process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE;
    else process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE = savedProv;
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
    delete process.env.JS2WASM_FNCTOR_CTOR_PARAM_SLOTS;
  });

  it("a const-and-conditional slot emits f64 with the flag on, externref with it off, same answer", async () => {
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "1";
    const on = await compileE2E();
    expect(on.slots.get("S.flags")).toBe("f64");
    const onResult = await run(on.binary);
    expect(onResult).toBe(1);

    // (#743 defaults flip, 2026-08-08) OFF is a SPELLING now — unset is ON, so
    // deleting the variable here would silently test the flag-ON path.
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "0";
    const off = await compileE2E();
    expect(off.slots.get("S.flags")).toBe("externref");
    expect(await run(off.binary)).toEqual(onResult);
  });
});
