// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4487 — IR adoption of SPREAD in array literals.
//
// Measured on origin/main 793b5c0 (`.tmp/spread-probe.ts`, run with
// `JS2WASM_IR_SHAPE_DIAG=1`): EVERY array-literal spread rejected at one
// undifferentiated arm, `expr-arraylit-spread:SpreadElement` — `[...a]`,
// `[...a, x]`, `[x, ...a, y]`, `[...a, ...b]`, `[...param]`, `[...g()]`,
// `[..."ab"]` alike, while the same literal without the spread was claimed.
//
// The IR's only array allocator is `vec.new_fixed`, whose count is a
// COMPILE-TIME number (WasmGC lowers it to `array.new_fixed`), and there is no
// bulk-copy primitive. So the adoptable set is exactly the spreads whose
// element count is provable statically; those expand element-wise into the
// existing fixed literal. Everything else genuinely needs a runtime-sized
// allocation and keeps its own reject arm.
//
// Every positive case here is CLAIM-BACKED (the selector must actually claim
// AND the slot must carry an IR body), so a green "IR matches legacy"
// assertion can never be satisfied vacuously by the legacy body. Each is also
// checked against a JS twin executed by Node, so the oracle is the language,
// not the other backend. The negative boundaries pin the shapes that must stay
// rejected — including the ones whose adoption would be UNSOUND — so a future
// widening cannot silently claim them.

import ts from "typescript";
import { describe, expect, it } from "vitest";

// The selector's reject-arm recorder is armed by an env var READ AT MODULE
// LOAD (`SHAPE_DIAG_ON` in `src/ir/select.ts`), so setting it inside a test is
// too late — a static import would already have evaluated the module and the
// arm assertions below would all read the undifferentiated
// `body-shape-rejected` bucket. Arm it first, then pull the compiler in
// dynamically. The var only makes rejections carry a `detail` string; the
// selection itself is byte-identical either way. It is restored immediately so
// other files sharing this worker's `process.env` are unaffected.
const previousShapeDiag = process.env.JS2WASM_IR_SHAPE_DIAG;
process.env.JS2WASM_IR_SHAPE_DIAG = "1";
const { compile } = await import("../src/index.js");
const { planIrCompilation } = await import("../src/ir/select.js");
const { buildImports } = await import("../src/runtime.js");
const { staticSpreadSourceShape } = await import("../src/ir/array-spread-shape.js");
// Restored as `""` rather than deleted (`delete` is lint-banned here): the
// selector tests `=== "1"`, so an empty string disarms it just as an absent
// var does.
process.env.JS2WASM_IR_SHAPE_DIAG = previousShapeDiag ?? "";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

const JS_STRING_STUB = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) => s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  fromCharCode: (c: number) => String.fromCharCode(c),
  cast: (s: unknown) => String(s),
  test: (v: unknown) => (typeof v === "string" ? 1 : 0),
};

async function instantiate(source: string, experimentalIR: boolean): Promise<Record<string, unknown>> {
  const r = await compile(source, { experimentalIR });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
    "wasm:js-string": JS_STRING_STUB,
  });
  return instance.exports as Record<string, unknown>;
}

function claims(source: string, name: string): boolean {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  return new Set(planIrCompilation(sf, { experimentalIR: true }).funcs).has(name);
}

/** The proximate selector reject arm, or `"CLAIMED"`. */
function rejectArm(source: string, name: string): string {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  const selection = planIrCompilation(sf, { experimentalIR: true, trackFallbacks: true });
  if (selection.funcs.has(name)) return "CLAIMED";
  const fallback = (selection.fallbacks ?? []).find((f) => f.name === name);
  return fallback?.detail ?? fallback?.reason ?? "not-claimed";
}

/** Genuine emission, not a mere claim: the slot must carry an IR body. */
async function irEmitted(source: string, name: string): Promise<boolean> {
  const r = await compile(source, { trackIrOutcomes: true });
  const outcome = (r.irOutcomes ?? []).find((o) => o.displayName === name);
  return outcome?.kind === "emitted" && outcome.irBodyEmitted === true;
}

/**
 * The full positive contract for one adopted shape: the selector claims it,
 * the IR body really ships, and BOTH backends agree with Node running the
 * JavaScript twin. `expected` is stated independently so a JS twin that
 * drifted from the TS source cannot silently define its own oracle.
 */
async function expectAdopted(
  source: string,
  name: string,
  args: number[],
  jsTwin: (...a: number[]) => number,
  expected: number,
): Promise<void> {
  expect(claims(source, name)).toBe(true);
  expect(await irEmitted(source, name)).toBe(true);
  expect(jsTwin(...args)).toBe(expected); // Node is the oracle.
  const legacy = await instantiate(source, false);
  const ir = await instantiate(source, true);
  const call = (exports: Record<string, unknown>) => (exports[name] as (...a: number[]) => number)(...args);
  expect(call(legacy)).toBe(expected);
  expect(call(ir)).toBe(expected);
}

/** A rejected shape must still compile (clean fallback) and still be correct. */
async function expectRejectedButCorrect(source: string, name: string, args: number[], expected: number): Promise<void> {
  expect(claims(source, name)).toBe(false);
  const legacy = await instantiate(source, false);
  const ir = await instantiate(source, true);
  const call = (exports: Record<string, unknown>) => (exports[name] as (...a: number[]) => number)(...args);
  expect(call(legacy)).toBe(expected);
  expect(call(ir)).toBe(expected);
}

// `sum` / `at` helpers keep the probe bodies to shapes the IR already claims
// (a counted `for` over `.length` with `+=`), so the ONLY new thing under test
// is the spread itself.
const SUM_BODY = (literal: string) =>
  `let s = 0; const b = ${literal}; for (let i = 0; i < b.length; i++) { s += b[i]; } return s;`;

/** Positional fingerprint: order-sensitive, so a permuted result cannot pass. */
const WEIGHTED_BODY = (literal: string) =>
  `let s = 0; const b = ${literal}; for (let i = 0; i < b.length; i++) { s += b[i] * (i + 1); } return s;`;

describe("#4487 — array-literal spread over statically-provable sources is IR-claimed", () => {
  it("`[...a]` copies a const vec (length + elements)", async () => {
    await expectAdopted(
      `export function f(x: number): number { const a = [1, 2, 3]; ${SUM_BODY("[...a]")} }`,
      "f",
      [0],
      () => {
        const a = [1, 2, 3];
        let s = 0;
        const b = [...a];
        for (let i = 0; i < b.length; i++) s += b[i]!;
        return s;
      },
      6,
    );
  });

  it("`[...a, x]` — trailing scalar after the spread", async () => {
    await expectAdopted(
      `export function f(x: number): number { const a = [1, 2, 3]; ${SUM_BODY("[...a, x]")} }`,
      "f",
      [4],
      (x) => {
        const a = [1, 2, 3];
        let s = 0;
        const b = [...a, x];
        for (let i = 0; i < b.length; i++) s += b[i]!;
        return s;
      },
      10,
    );
  });

  it("`[x, ...a, y]` — spread in the MIDDLE keeps positional order", async () => {
    await expectAdopted(
      `export function f(x: number, y: number): number { const a = [2, 3]; ${WEIGHTED_BODY("[x, ...a, y]")} }`,
      "f",
      [1, 4],
      (x, y) => {
        const a = [2, 3];
        let s = 0;
        const b = [x, ...a, y];
        for (let i = 0; i < b.length; i++) s += b[i]! * (i + 1);
        return s;
      },
      30,
    );
  });

  it("`[...a, ...b]` — two spreads concatenate in order", async () => {
    await expectAdopted(
      `export function f(x: number): number { const a = [1, 2]; const c = [3, 4]; ${WEIGHTED_BODY("[...a, ...c]")} }`,
      "f",
      [0],
      () => {
        const a = [1, 2];
        const c = [3, 4];
        let s = 0;
        const b = [...a, ...c];
        for (let i = 0; i < b.length; i++) s += b[i]! * (i + 1);
        return s;
      },
      30,
    );
  });

  it("`[...a, ...a]` — the SAME source spread twice", async () => {
    await expectAdopted(
      `export function f(x: number): number { const a = [1, 2]; ${WEIGHTED_BODY("[...a, ...a]")} }`,
      "f",
      [0],
      () => {
        const a = [1, 2];
        let s = 0;
        const b = [...a, ...a];
        for (let i = 0; i < b.length; i++) s += b[i]! * (i + 1);
        return s;
      },
      16,
    );
  });

  it("`[...[1, 2], x]` — inline literal operand (no allocation of the operand)", async () => {
    await expectAdopted(
      `export function f(x: number): number { ${WEIGHTED_BODY("[...[1, 2], x]")} }`,
      "f",
      [5],
      (x) => {
        let s = 0;
        const b = [...[1, 2], x];
        for (let i = 0; i < b.length; i++) s += b[i]! * (i + 1);
        return s;
      },
      20,
    );
  });

  it("length is the SUM of the source lengths, not the element count", async () => {
    await expectAdopted(
      `export function f(x: number): number { const a = [1, 2, 3]; const b = [...a, x]; return b.length; }`,
      "f",
      [9],
      (x) => {
        const a = [1, 2, 3];
        const b = [...a, x];
        return b.length;
      },
      4,
    );
  });

  it("boolean vecs spread too (i32 carrier)", async () => {
    await expectAdopted(
      `export function f(x: number): number { const a = [true, false]; const b = [...a, true]; let s = 0; for (let i = 0; i < b.length; i++) { if (b[i]) { s += 1; } } return s + x; }`,
      "f",
      [0],
      () => {
        const a = [true, false];
        const b = [...a, true];
        let s = 0;
        for (let i = 0; i < b.length; i++) if (b[i]) s += 1;
        return s;
      },
      2,
    );
  });

  it("a source ALSO read via `.length` elsewhere still claims", async () => {
    await expectAdopted(
      `export function f(x: number): number { const a = [1, 2]; const n = a.length; const b = [...a, x]; let s = 0; for (let i = 0; i < b.length; i++) { s += b[i]; } return s + n; }`,
      "f",
      [7],
      (x) => {
        const a = [1, 2];
        const n = a.length;
        const b = [...a, x];
        let s = 0;
        for (let i = 0; i < b.length; i++) s += b[i]!;
        return s + n;
      },
      12,
    );
  });
});

describe("#4487 — the spread result is a COPY, not an alias", () => {
  // The decisive property. `vec.new_fixed` allocates a fresh backing array, so
  // writing through the RESULT must not be visible through the SOURCE. (The
  // mirror-image probe — write through the source, read the copy — cannot be
  // claim-backed: a write through the source is exactly what the length-
  // invariance analysis refuses, and it is pinned as a negative below.)
  it("writing b[0] does not change a[0] (claim-backed)", async () => {
    const src = `export function f(x: number): number { const a = [1, 2, 3]; const b = [...a]; b[0] = 100; return a[0] + x; }`;
    await expectAdopted(
      src,
      "f",
      [0],
      () => {
        const a = [1, 2, 3];
        const b = [...a];
        b[0] = 100;
        return a[0]!;
      },
      1,
    );
    // …and the write really did land in the copy, so the `1` above is a copy
    // proof rather than a write that silently went nowhere.
    await expectAdopted(
      `export function f(x: number): number { const a = [1, 2, 3]; const b = [...a]; b[0] = 100; return b[0] + x; }`,
      "f",
      [0],
      () => {
        const a = [1, 2, 3];
        const b = [...a];
        b[0] = 100;
        return b[0]!;
      },
      100,
    );
  });

  it("two spreads of one source produce two independent vecs", async () => {
    await expectAdopted(
      `export function f(x: number): number { const a = [1, 2]; const b = [...a]; const c = [...a]; b[0] = 50; return c[0] + a[0] + x; }`,
      "f",
      [0],
      () => {
        const a = [1, 2];
        const b = [...a];
        const c = [...a];
        b[0] = 50;
        return c[0]! + a[0]!;
      },
      2,
    );
  });
});

describe("#4487 — dynamic-length sources still reject, under their own arm", () => {
  const ARM = "expr-arraylit-spread-dynamic-source:ArrayLiteralExpression";

  it("spread of a PARAMETER (length unknown at compile time)", () => {
    const src = `export function f(p: number[]): number { const b = [...p]; return b.length; }`;
    expect(rejectArm(src, "f")).toBe(ARM);
  });

  it("spread of a CALL RESULT", async () => {
    const src = `function g(): number[] { return [1, 2]; }\nexport function f(x: number): number { const b = [...g(), x]; let s = 0; for (let i = 0; i < b.length; i++) { s += b[i]; } return s; }`;
    expect(rejectArm(src, "f")).toBe(ARM);
    await expectRejectedButCorrect(src, "f", [3], 6);
  });

  it("spread of a STRING (iterator protocol)", async () => {
    const src = `export function f(x: number): number { const b = [..."ab"]; return b.length + x; }`;
    expect(rejectArm(src, "f")).toBe(ARM);
    await expectRejectedButCorrect(src, "f", [0], 2);
  });

  it("spread of a `let` binding (rebindable)", async () => {
    const src = `export function f(x: number): number { let a = [1, 2]; const b = [...a, x]; return b.length; }`;
    expect(rejectArm(src, "f")).toBe(ARM);
    await expectRejectedButCorrect(src, "f", [7], 3);
  });

  it("spread of a MODULE-level const (any function could mutate it)", () => {
    const src = `const a = [1, 2];\nexport function f(x: number): number { const b = [...a, x]; return b.length; }`;
    expect(rejectArm(src, "f")).toBe(ARM);
  });

  it("nested spread inside the operand literal", () => {
    const src = `export function f(x: number): number { const a = [1]; const b = [...[...a, 2], x]; return b.length; }`;
    expect(rejectArm(src, "f")).toBe(ARM);
  });
});

describe("#4487 — UNSOUND-to-adopt sources reject (length could change under us)", () => {
  const ARM = "expr-arraylit-spread-dynamic-source:ArrayLiteralExpression";

  // Each of these would make the compile-time length WRONG if it were adopted,
  // so these assertions are load-bearing correctness pins, not taste.
  it("source is `push`ed — length grows", async () => {
    const src = `export function f(x: number): number { const a = [1, 2]; a.push(3); const b = [...a, x]; return b.length; }`;
    expect(rejectArm(src, "f")).toBe(ARM);
    await expectRejectedButCorrect(src, "f", [0], 4);
  });

  it("source has an element WRITTEN (an out-of-range index extends it)", async () => {
    const src = `export function f(x: number): number { const a = [1, 2]; a[5] = 9; const b = [...a]; return b.length + x; }`;
    expect(rejectArm(src, "f")).toBe(ARM);
    await expectRejectedButCorrect(src, "f", [0], 6);
  });

  it("source has `.length` assigned — truncation", async () => {
    const src = `export function f(x: number): number { const a = [1, 2, 3]; a.length = 1; const b = [...a]; return b.length + x; }`;
    expect(rejectArm(src, "f")).toBe(ARM);
    await expectRejectedButCorrect(src, "f", [0], 1);
  });

  it("source ESCAPES into a call that could resize it", async () => {
    const src = `function g(v: number[]): number { v.push(9); return 0; }\nexport function f(x: number): number { const a = [1, 2]; g(a); const b = [...a]; return b.length + x; }`;
    expect(rejectArm(src, "f")).toBe(ARM);
    await expectRejectedButCorrect(src, "f", [0], 3);
  });

  it("source is captured by a closure that pushes to it", async () => {
    const src = `export function f(x: number): number { const a = [1, 2]; const grow = () => { a.push(7); }; grow(); const b = [...a]; return b.length + x; }`;
    // Measured: an EARLIER gate (`closure-return-type`) claims the attribution
    // here, so the arm is not this issue's. What matters is that the function
    // is not claimed and stays correct; the spread analysis's own refusal of
    // this shape is pinned directly in the unit block below.
    expect(rejectArm(src, "f")).toBe("closure-return-type:ArrowFunction");
    await expectRejectedButCorrect(src, "f", [0], 3);
  });

  it("a competing binding of the same name makes the name-text scan ambiguous", () => {
    const src = `export function f(x: number): number { const a = [1, 2]; if (x > 0) { const inner = [9, 9, 9]; return inner.length; } const b = [...a]; return b.length; }`;
    // Rename-collision variant: a second `a` binding in a nested block. The
    // selector's own `vardecl-shadow` gate fires first — again an earlier arm,
    // with the spread analysis's refusal pinned in the unit block below.
    const shadowed = `export function f(x: number): number { const a = [1, 2]; if (x > 0) { const a = [9, 9, 9]; return a.length; } const b = [...a]; return b.length; }`;
    expect(rejectArm(shadowed, "f")).toBe("vardecl-shadow:Identifier");
    // The non-colliding twin is unaffected — the refusal is about the collision,
    // not about merely having another array around.
    expect(rejectArm(src, "f")).toBe("CLAIMED");
  });
});

describe("#4487 — `staticSpreadSourceShape` unit boundaries", () => {
  /** Classify the first array-literal spread operand in `source`. */
  function shapeOf(source: string) {
    const sf = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
    let operand: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
      if (!operand && ts.isSpreadElement(node) && node.parent && ts.isArrayLiteralExpression(node.parent)) {
        operand = node.expression;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (!operand) throw new Error("no array-literal spread found in probe source");
    return staticSpreadSourceShape(operand);
  }

  const inFn = (body: string) => `function f(p: number[]): number { ${body} }`;

  it("dense const literal → fixed-const-vec with its length", () => {
    expect(shapeOf(inFn(`const a = [1, 2, 3]; const b = [...a]; return b.length;`))).toEqual({
      kind: "fixed-const-vec",
      length: 3,
      elements: expect.anything(),
    });
  });

  it("inline literal operand → inline-literal", () => {
    const shape = shapeOf(inFn(`const b = [...[1, 2], 3]; return b.length;`));
    expect(shape?.kind).toBe("inline-literal");
    expect(shape?.elements.length).toBe(2);
  });

  it.each([
    ["push resizes the source", `const a = [1, 2]; a.push(3); const b = [...a]; return b.length;`],
    ["an index WRITE can extend the source", `const a = [1, 2]; a[5] = 9; const b = [...a]; return b.length;`],
    ["`.length =` truncates the source", `const a = [1, 2]; a.length = 1; const b = [...a]; return b.length;`],
    ["the source escapes into a call", `const a = [1, 2]; g(a); const b = [...a]; return b.length;`],
    ["the source escapes as a return value", `const a = [1, 2]; const b = [...a]; h(b, a); return b.length;`],
    [
      "a closure captures and pushes",
      `const a = [1, 2]; const grow = () => { a.push(7); }; grow(); const b = [...a]; return b.length;`,
    ],
    [
      "a competing binding shadows the name",
      `const a = [1, 2]; { const a = [9]; g(a); } const b = [...a]; return b.length;`,
    ],
    ["the binding is `let`, not `const`", `let a = [1, 2]; const b = [...a]; return b.length;`],
    ["the source is a parameter", `const b = [...p]; return b.length;`],
    ["the source is a call result", `const b = [...g()]; return b.length;`],
    ["the source is a string", `const b = [..."ab"]; return b.length;`],
    ["the source literal is itself sparse", `const a = [1, , 3]; const b = [...a]; return b.length;`],
    ["the source literal itself spreads", `const a = [...p]; const b = [...a]; return b.length;`],
  ])("refuses: %s", (_label, body) => {
    expect(shapeOf(inFn(body))).toBeNull();
  });

  it("refuses a module-level const (mutable from any function)", () => {
    const src = `const a = [1, 2];\nfunction f(): number { const b = [...a]; return b.length; }`;
    expect(shapeOf(src)).toBeNull();
  });

  // The sharpest failure mode this analysis can have: binding the spread to a
  // declaration that is NOT the one in scope there. A function-wide search for
  // the name finds the block-local `a` (length 2), while the spread actually
  // refers to the module-level `a` (length 3) — adopting that would compile a
  // wrong length, i.e. a miscompile rather than a missed optimisation.
  it("refuses a declaration whose BLOCK SCOPE does not contain the spread", () => {
    const src =
      `const a = [1, 2, 3];\n` +
      `function f(): number { { const a = [1, 2]; g(a); } const b = [...a]; return b.length; }`;
    expect(shapeOf(src)).toBeNull();
  });

  it("accepts a declaration in an inner block when the spread is inside it too", () => {
    const src = `function f(): number { { const a = [1, 2]; const b = [...a]; return b.length; } }`;
    expect(shapeOf(src)).toEqual({ kind: "fixed-const-vec", length: 2, elements: expect.anything() });
  });

  it("refuses a use that precedes its declaration (temporal dead zone)", () => {
    const src = `function f(): number { const b = [...a]; const a = [1, 2]; return b.length; }`;
    expect(shapeOf(src)).toBeNull();
  });

  it("accepts read-only uses: index read, `.length`, for-of, and a second spread", () => {
    const body = `const a = [1, 2]; const n = a.length; const first = a[0]; for (const v of a) { g([v]); } const c = [...a]; const b = [...a, n, first]; return b.length + c.length;`;
    expect(shapeOf(inFn(body))?.kind).toBe("fixed-const-vec");
  });
});

describe("#4487 — neighbouring rejects keep their own, more specific arms", () => {
  it("elision beats spread in attribution", () => {
    const src = `export function f(x: number): number { const a = [1, 2]; const b = [...a, , x]; return b.length; }`;
    expect(rejectArm(src, "f")).toBe("expr-arraylit-sparse:ArrayLiteralExpression");
  });

  it("a mixed number/string literal still reports the family arm", () => {
    const src = `export function f(x: number): number { const a = [1, 2]; const b = [...a, "r"]; return b.length + x; }`;
    expect(rejectArm(src, "f")).toBe("expr-arraylit-mixed-primitive-family:ArrayLiteralExpression");
  });

  it("a string-carrier spread source COMPILES (demotes cleanly, does not hard-fail)", async () => {
    // Regression pin. `vec.get` on a string vec yields the stored `externref`
    // while a sibling string literal lowers as `IrType.string`; the first cut
    // threw a bare `Error` there, which IR-first reports as an unexpected
    // internal throw and FAILS the compile ("IR path failed for f") instead of
    // falling back. It must demote through the unsupported channel.
    const src = `export function f(x: number): number { const a = ["p", "q"]; const b = [...a, "r"]; return b.length + x; }`;
    const r = await compile(src, { experimentalIR: true });
    expect(r.success).toBe(true);
    const spreadOnly = `export function f(x: number): number { const a = ["p", "q"]; const b = [...a]; return b.length + x; }`;
    expect((await compile(spreadOnly, { experimentalIR: true })).success).toBe(true);
  });
});

// The string-carrier pin above found ONE instance of a general defect: adopting
// the spread makes the selector CLAIM units that then reach a bare `Error`
// inside `lowerArrayLiteral`, and under IR-first a bare throw is an unexpected
// internal error — the compile FAILS instead of demoting to the (correct)
// legacy body. Measured on this branch with the A/B file-copy against its base
// (`.tmp/probe-4487b.ts` / `-4487c.ts`, base `src/ir/{from-ast,select}.ts`
// restored): two further shapes did exactly that, both compiling fine on base
// because base rejected them at `expr-arraylit-spread` and never claimed them.
// The class — not the individual shape — is what these pin.
describe("#4487 — an adopted spread must never turn a compiling program into a compile ERROR", () => {
  /** IR-first: the lane where a bare `Error` becomes a hard compile failure. */
  async function compilesUnderIrFirst(src: string): Promise<true | string> {
    const r = await compile(src, { experimentalIR: true });
    return r.success ? true : (r.errors[0]?.message ?? "unknown error");
  }

  it("spread of an EMPTY source with no vec-typed hint demotes, not fails", async () => {
    // `[...a]` over `const a: number[] = []` expands to ZERO elements, so
    // neither an element nor an annotation supplies the vec element type.
    // Base: `expr-arraylit-spread` → legacy → compiled. First cut of this
    // branch: claimed → bare `Error` → "IR path failed for f".
    const src = `export function f(x: number): number { const a: number[] = []; const b = [...a]; return b.length + x; }`;
    expect(claims(src, "f")).toBe(true);
    expect(await compilesUnderIrFirst(src)).toBe(true);
    // …and it still computes the right answer on both backends.
    const legacy = await instantiate(src, false);
    const ir = await instantiate(src, true);
    expect((legacy.f as (n: number) => number)(0)).toBe(0);
    expect((ir.f as (n: number) => number)(0)).toBe(0);
  });

  it("an annotated empty-source spread still builds a real (claim-backed) vec", async () => {
    // The hinted twin of the case above must stay ADOPTED — the demotion
    // above is about a missing element type, not about empty sources.
    await expectAdopted(
      `export function f(x: number): number { const a: number[] = []; const b = [...a, 7]; return b.length + b[0] + x; }`,
      "f",
      [0],
      () => {
        const a: number[] = [];
        const b = [...a, 7];
        return b.length + b[0]!;
      },
      8,
    );
  });

  it("a NESTED-VEC spread source demotes, not fails", async () => {
    // `vec<vec<f64>>` elements are outside the #1804 fixed-literal scope. The
    // throw for that is pre-existing (it fires for `const a = [[1], [2]]` with
    // no spread at all — the literal-construction twin of #4486), but adopting
    // the spread newly routes claimed units into it, so it has to be typed.
    const src = `export function f(x: number): number { const a = [[1], [2]]; const b = [...a]; return b.length + b[0][0] + x; }`;
    expect(claims(src, "f")).toBe(true);
    expect(await compilesUnderIrFirst(src)).toBe(true);
    const legacy = await instantiate(src, false);
    const ir = await instantiate(src, true);
    expect((legacy.f as (n: number) => number)(0)).toBe(3);
    expect((ir.f as (n: number) => number)(0)).toBe(3);
  });

  it("an INLINE nested literal spread demotes, not fails", async () => {
    // Same class reached without any binding: `[...[[1], [2]], [3]]`.
    const src = `export function f(x: number): number { const b = [...[[1], [2]], [3]]; return b.length + x; }`;
    expect(claims(src, "f")).toBe(true);
    expect(await compilesUnderIrFirst(src)).toBe(true);
    expect(((await instantiate(src, true)).f as (n: number) => number)(0)).toBe(3);
  });
});

// Binding resolution is a name-text scan, so every shape where the name `a` at
// the spread could resolve to a DIFFERENT declaration than the one the scan
// finds is a potential miscompile (a wrong LENGTH, silently). These pin the
// resolution itself rather than the reject arm.
describe("#4487 — the spread binds to the RIGHT declaration", () => {
  it("an inner-function-scope const shadowing a module const uses the INNER length", async () => {
    // Module `a` has 4 elements, the function-local one has 2. Adoption must
    // read 2. (The mirror — spread of the MODULE const while a block-local `a`
    // exists — is the miscompile the block-scope check fixed; it is pinned as
    // a unit boundary above.)
    await expectAdopted(
      `const a = [1, 2, 3, 4];\nexport function f(x: number): number { const a = [1, 2]; const b = [...a]; return b.length + x; }`,
      "f",
      [0],
      () => 2,
      2,
    );
  });

  it("a const declared INSIDE a loop body is re-bound per iteration and still exact", async () => {
    await expectAdopted(
      `export function f(x: number): number { let s = 0; for (let i = 0; i < 3; i++) { const a = [1, 2]; const b = [...a, i]; s += b.length; } return s + x; }`,
      "f",
      [0],
      () => {
        let s = 0;
        for (let i = 0; i < 3; i++) {
          const a = [1, 2];
          const b = [...a, i];
          s += b.length;
        }
        return s;
      },
      9,
    );
  });

  it("a source iterated by a for-of elsewhere still binds and claims", async () => {
    await expectAdopted(
      `export function f(x: number): number { let s = 0; const rows = [1, 2]; for (const r of rows) { s += r; } const b = [...rows]; return s + b.length + x; }`,
      "f",
      [0],
      () => {
        let s = 0;
        const rows = [1, 2];
        for (const r of rows) s += r;
        return s + [...rows].length;
      },
      5,
    );
  });

  it("a catch-clause parameter with the source's name refuses the claim", async () => {
    // `catch (a)` is a competing binding of `a`; the name-text scan cannot tell
    // the two apart, so the analysis must refuse rather than guess.
    const src = `export function f(x: number): number { const a = [1, 2, 3]; try { if (a.length > 99) { throw 1; } } catch (a) { } const b = [...a]; return b.length + x; }`;
    expect(rejectArm(src, "f")).toBe("expr-arraylit-spread-dynamic-source:ArrayLiteralExpression");
    await expectRejectedButCorrect(src, "f", [0], 3);
  });
});
