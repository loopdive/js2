// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #743 — the SATELLITE bitwise/shift producer rule
// (src/ir/fnctor-i32-producers.ts + the `InferExtension` hook in
// src/ir/propagate.ts).
//
// Before this slice the fnctor-graph satellite sent every bitwise expression to
// DYNAMIC, because the shared core only applies its `#1126 Stage 2` producer
// arms when `JS2WASM_IR_I32_DOMAIN=1` — a MAIN-map flag the satellite must not
// touch (#1712 byte-parity). The satellite's consumer collapses `i32`/`u32`
// into the same f64 slot as `f64`, so it can take the fact the core withholds.
//
// Three things are pinned here, in order of how expensive they are to get
// wrong:
//
//  1. SOUNDNESS. BigInt is the only value class for which `a | b` is not a
//     number, and `provablyNotBigInt` is the entire guard. The negative tests
//     (two dynamic operands) are the ones that matter — a rule that fires there
//     puts a BigInt in an f64 field slot.
//  2. THREADING. `ext` is an optional trailing parameter, so a recursion site
//     that forgets it compiles, runs, and silently answers the pre-extension
//     type for that subtree. Every fixture that places the bitwise expression
//     BELOW the top level exists for that failure mode alone.
//  3. MAIN-MAP INERTNESS. Nothing that does not pass an extension may observe
//     any change.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { fnctorFieldProvenanceRecords, resetFnctorFieldProvenance } from "../src/codegen/fnctor-field-provenance.js";
import { computeFnctorGraphCtorParamFacts } from "../src/ir/fnctor-method-edges.js";
import { _internals } from "../src/ir/propagate.js";
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

/**
 * The lattice kind the satellite proved for `P`'s single constructor parameter,
 * given a module that constructs `P` exactly once with `arg`.
 *
 * Routing through the ctor parameter (rather than reading an expression fact
 * directly) is deliberate: it is the only path the CONSUMER actually reads, so
 * a rule that fires but does not survive the fixpoint's joins cannot pass.
 */
function paramFactFor(arg: string, extra = ""): { kind: string } {
  const source = `
var P = function P(v) { this.v = v; };
function mk(a, b, c) { return new P(${arg}); }
${extra}
`;
  const { checker, file } = fixture(source);
  return computeFnctorGraphCtorParamFacts(file, { checker }).get("P")?.[0] ?? { kind: "<none>" };
}

function paramKindFor(arg: string, extra = ""): string {
  return paramFactFor(arg, extra).kind;
}

describe("#743 satellite i32 producers — the operator arms", () => {
  it.each([
    ["a | 0", "i32"],
    ["a & 0xffff", "i32"],
    ["a ^ 1", "i32"],
    ["a << 2", "i32"],
    ["a >> 2", "i32"],
    ["0 | a", "i32"],
    ["a >>> 0", "u32"],
  ])("%s → %s", (expr, kind) => {
    expect(paramKindFor(expr)).toBe(kind);
  });

  it("compound bitwise assignment carries the same fact as its binary twin", () => {
    // `x |= y` evaluates to the value stored, which is exactly `x | y`. Leaving
    // these out would be a silent hole: nothing about the compound form makes
    // the result less of an Int32.
    expect(paramKindFor("a |= 1")).toBe("i32");
    expect(paramKindFor("a &= 1")).toBe("i32");
    expect(paramKindFor("a ^= 1")).toBe("i32");
    expect(paramKindFor("a <<= 1")).toBe("i32");
    expect(paramKindFor("a >>= 1")).toBe("i32");
    expect(paramKindFor("a >>>= 1")).toBe("u32");
  });

  it("~ needs its single operand proved", () => {
    expect(paramKindFor("~0")).toBe("i32");
    // `~1n` is `-2n`. With nothing known about `a`, DYNAMIC is the only sound
    // answer — the same reasoning as the binary guard, from one operand.
    expect(paramKindFor("~a")).toBe("dynamic");
  });
});

describe("#743 satellite i32 producers — the BigInt guard", () => {
  it("two unproven operands stay dynamic (either could be a BigInt)", () => {
    expect(paramKindFor("a | b")).toBe("dynamic");
    expect(paramKindFor("a & b")).toBe("dynamic");
    expect(paramKindFor("a << b")).toBe("dynamic");
  });

  it("one proven NUMBER operand is enough — mixing throws, so a value that flows is Int32", () => {
    expect(paramKindFor("a | 1")).toBe("i32");
    expect(paramKindFor("1 | a")).toBe("i32");
  });

  it("string and boolean operands are proof: ToNumeric of either is a Number", () => {
    expect(paramKindFor('a | "s"')).toBe("i32");
    expect(paramKindFor("a | true")).toBe("i32");
  });

  it("an OBJECT operand is NOT proof — ToPrimitive runs user code and may return a BigInt", () => {
    // The receiver here is a satellite `object` atom, i.e. a shape the module
    // under analysis defines; nothing stops that shape carrying a
    // `Symbol.toPrimitive` that hands back a BigInt.
    expect(paramKindFor("({ x: 1 }) | b")).toBe("dynamic");
  });

  it(">>> needs no guard at all — BigInt does not implement unsigned shift", () => {
    // `1n >>> 1n` is a TypeError, not a BigInt. So the expression either throws
    // (no value reaches the slot) or both operands were Numbers.
    expect(paramKindFor("a >>> b")).toBe("u32");
  });
});

describe("#743 satellite i32 producers — the extension reaches every recursion site", () => {
  it("through parentheses", () => {
    expect(paramKindFor("((a | 0))")).toBe("i32");
  });

  it("through an arithmetic parent (i32 widens to f64, it does not fall to dynamic)", () => {
    expect(paramKindFor("(a | 0) + 1")).toBe("f64");
  });

  it("through both arms of a conditional", () => {
    expect(paramKindFor("true ? (a | 0) : (b >>> 0)")).toBe("f64");
  });

  it("through an object literal and back out through a property access", () => {
    expect(paramKindFor("({ m: a | 0 }).m")).toBe("i32");
  });

  it("through an element access with a literal key", () => {
    expect(paramKindFor('({ m: a >>> 0 })["m"]')).toBe("u32");
  });

  // The two return-path fixtures below deliberately hide the bitwise
  // expression inside an object literal whose field is then read back by a
  // second callee, because a BARE `return x | 0` cannot detect a dropped
  // `ext`: the checker itself types `x | 0` as `number`, so `seedReturnType`
  // seeds `f64` and the walk's contribution is invisible either way. Routing
  // the value through a shape the checker can only call `any` makes the seed
  // lattice BOTTOM, so the answer is exactly what the walk produced.
  const PICK = "function pick(o) { return o.m; }";

  it("through a callee's RETURN (walkBodyForReturns)", () => {
    expect(paramKindFor("flags(a)", `${PICK}\nfunction flags(x) { return pick({ m: x | 0 }); }`)).toBe("i32");
  });

  it("through a local declared inside a callee's body", () => {
    // The variable arm of `walkBodyForReturns` is the subtlest threading site:
    // `t` must carry `u32` INTO the returned object literal's shape. If the arm
    // drops `ext`, `t` is `dynamic`, a non-atom field widens the whole literal,
    // and the fact arriving at `P` is `dynamic` — not merely a coarser number.
    expect(paramFactFor("flags(a)", "function flags(x) { var t = x >>> 0; return { m: t }; }")).toEqual({
      kind: "object",
      fields: [{ name: "m", type: { kind: "u32" } }],
    });
  });

  it("a bare bitwise return widens to f64 — the CHECKER's `number` seed, not a lost fact", () => {
    expect(paramKindFor("flags(a)", "function flags(x) { return x | 0; }")).toBe("f64");
  });

  it("three levels deep, under a unary operator", () => {
    expect(paramKindFor("-((a | 0) + 1)")).toBe("f64");
  });
});

describe("#743 satellite i32 producers — the MAIN lattice is untouched", () => {
  const expressionOf = (text: string): ts.Expression => {
    const sf = ts.createSourceFile("/x.ts", `(${text});`, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    return (sf.statements[0] as ts.ExpressionStatement).expression;
  };

  it("the core evaluator without an extension still answers dynamic for bitwise", () => {
    // This is the invariant the whole `InferExtension` design exists to keep:
    // the satellite's precision must be unreachable from the always-on path,
    // which passes no extension at all.
    const scope = new Map([["a", _internals.F64]]);
    expect(_internals.inferExpr(expressionOf("a | 0"), scope, new Map())).toEqual(_internals.DYNAMIC);
    expect(_internals.inferExpr(expressionOf("a >>> 0"), scope, new Map())).toEqual(_internals.DYNAMIC);
    expect(_internals.inferExpr(expressionOf("~a"), scope, new Map())).toEqual(_internals.DYNAMIC);
  });

  it("the i32-domain flag is still the main map's only switch", () => {
    expect(_internals.i32DomainEnabled()).toBe(process.env.JS2WASM_IR_I32_DOMAIN === "1");
  });
});

// ── End-to-end: a bitwise-only field slot reaches the emitted binary ─────────

// Every write into `S.flags` is a bitwise expression, so before this slice the
// slot could only box. `mask` is deliberately reached only through a RETURN so
// the fixture also exercises the cross-function path.
const E2E_SRC = `
var S = function S(flags) { this.flags = flags; };
function mask(x) { return (x | 0) & 0xff; }
function enter(x) { return new S(mask(x)); }
export function top() { return enter(0x1ff).flags === 0xff ? 1 : -1; }
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

describe("#743 satellite i32 producers — end to end", () => {
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

  it("a bitwise-only slot emits f64 with the flag on, externref with it off, same answer", async () => {
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

  it("flag off: the producer rule is invisible in the emitted bytes", async () => {
    // (#743 defaults flip, 2026-08-08) OFF is a SPELLING now — unset is ON, so
    // deleting the variable here would silently test the flag-ON path.
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "0";
    const a = await compileE2E();
    const b = await compileE2E();
    expect(Buffer.from(a.binary).equals(Buffer.from(b.binary))).toBe(true);
  });
});
