// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4647) `Function(<body>).call(thisArg, …)` — what the this-binding write
// reaches, and what it still does not.
//
// The issue read "the this-binding writes are lost". They are not lost
// uniformly; the split is by the RUNTIME REPRESENTATION of the object being
// written to, and every pin below is written to make that split visible rather
// than to assert one aggregate outcome. Measured on this branch's base
// (campaign HEAD 52cb0a6a6), quickjs tier, one compiled module per probe:
//
//   | value / receiver crossing the provider seam | base | this branch |
//   | ------------------------------------------- | ---- | ----------- |
//   | new realm global assigned a PRIMITIVE        | ok   | ok          |
//   | new realm global assigned a compiled ARRAY   | LOST | ok          |
//   | new realm global assigned a compiled OBJECT  | LOST | ok          |
//   | receiver = demoted/dynamic object (get+set)  | ok   | ok          |
//   | receiver = compiled ARRAY, GET               | ok   | ok          |
//   | receiver = compiled ARRAY, SET (write-back)  | LOST | LOST        |
//   | receiver = SHAPE-TYPED object literal        | LOST | LOST        |
//   | receiver = compiled FUNCTION (closure struct)| LOST | LOST        |
//
// The fix is one predicate in `scripts/quickjs-eval-provider.mjs`:
// `qjsMirrorRealmProperty` mirrored a newly-created realm global back to the
// caller only for PRIMITIVE tags. An inward membrane wrapper is not a QuickJS
// object though — it is one of our own compiled objects wearing a QuickJS face,
// and `qjsPublish` collapses it back to the caller's ORIGINAL object (#4245
// slice 2). Refusing it did not protect the caller's value, it made the
// caller's value unreachable.
//
// The LOST rows that remain are a DIFFERENT defect and are pinned as
// `it.fails` below with the measurement that localises them: a compiled object
// whose representation is a MODULE-PRIVATE nominal struct (a shape-inferred
// object literal, or a closure struct) is opaque to the provider's dynamic
// property runtime in BOTH directions, and the canonical vec/array carrier is
// readable but not writable through it. Only the canonical `$Object`
// dictionary round-trips fully.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

/**
 * CI's changed-root lane runs `JS2WASM_EVAL_ENGINE=interpreter` with the
 * REFUSAL provider. EVERY probe here mints from a body string that mentions
 * `this`, so #2924's constant-body AOT fold declines (it bails on any `this`)
 * and all of them really do reach the provider — which is the point, and which
 * is also why they all throw under the refusal tier. See the eval-tier rule in
 * plan/method/es5-standalone-agent-brief.md (methodology 5).
 */
const REFUSAL_TIER = process.env.JS2WASM_EVAL_ENGINE === "interpreter";

async function runLinked(body: string): Promise<number> {
  const result = await compile(`export function test(): number { ${body} }`, {
    allowJs: true,
    fileName: "issue-4647.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const instance = await instantiateTest262Module(result.binary, {}, { target: "standalone", providerLabel: "#4647" });
  return (instance.exports as { test(): number }).test();
}

/** Run `body`, or — under the refusal tier — assert the mint reaches the provider. */
async function expectLinked(body: string, expected: number): Promise<void> {
  if (REFUSAL_TIER) {
    let threw = false;
    try {
      await runLinked(body);
    } catch {
      threw = true;
    }
    expect(threw, "refusal tier: the dynamic-body mint must reach the provider and throw").toBe(true);
    return;
  }
  expect(await runLinked(body)).toBe(expected);
}

describe("#4647 A — a `this`-binding write that creates a REALM GLOBAL", () => {
  it("carries a compiled ARRAY back to the caller (built-ins/Function/prototype/call/S15.3.4.4_A6_T1)", async () => {
    // Verbatim the shape of the conformance row, plus the reads it makes:
    // the write MUST be performed and the value read back, not merely shaped
    // (pin-exercises-the-shape rule). Base: `globalThis["shifted"]` was
    // `undefined` and the row died on `undefined.constructor`.
    await expectLinked(
      `
      Function("a1,a2,a3", "this.shifted=a1;").call(null, [1]);
      var v = globalThis["shifted"];
      if (v === undefined || v === null) return 2;
      if (v.constructor !== Array) return 3;
      if (v.length !== 1) return 4;
      if (v[0] !== 1) return 5;
      return 1;
    `,
      1,
    );
  });

  it("carries a compiled OBJECT back, and its properties are live", async () => {
    await expectLinked(
      `
      var payload = { other: 1 };
      payload.k = 9;
      Function("a", "this.carried = a;").call(null, payload);
      var v = globalThis["carried"];
      if (v === undefined || v === null) return 2;
      if (v !== payload) return 3;
      if (v.k !== 9) return 4;
      return 1;
    `,
      1,
    );
  });

  it("still carries a PRIMITIVE back (the arm that already worked — localisation control)", async () => {
    // This is what made the defect a TAG-FILTER defect rather than a receiver
    // or global-mirror defect: the scalar form of the identical write was fine
    // on base. If a future change breaks this one too, the diagnosis above is
    // wrong and this pin says so first.
    await expectLinked(
      `
      Function("a1", "this.shifted = a1;").call(null, 9);
      return globalThis["shifted"] === 9 ? 1 : 3;
    `,
      1,
    );
  });
});

describe("#4647 A — receiver this-binding, by receiver representation", () => {
  it("writes through a DEMOTED/dynamic object receiver and reads it back", async () => {
    await expectLinked(
      `
      var o = { other: 1 };
      o.pre = 44;
      var r = Function("this.post = this.pre; return this.post;").call(o);
      if (r !== 44) return 2;
      return o.post === 44 ? 1 : 3;
    `,
      1,
    );
  });

  it("READS a compiled ARRAY receiver (index and length) through the seam", async () => {
    // Arrays cross as the canonical vec carrier, so the provider's dynamic get
    // reaches them. Its dynamic SET does not stick — see the residual block.
    await expectLinked(
      `
      var arr = [11, 22];
      var r = Function("return this[1] + this.length;").call(arr);
      return r === 24 ? 1 : 3;
    `,
      1,
    );
  });
});

describe("#4647 A — RESIDUAL: module-private struct receivers are opaque at the seam", () => {
  // Both pins below are `it.fails`: they encode a MEASURED residual, not a wish.
  // Under the refusal tier the mint throws, which would make an `it.fails`
  // pin pass for the wrong reason — so they are skipped there and the
  // positive pins above carry the tier coverage.
  it.skipIf(REFUSAL_TIER).fails("reads a SHAPE-TYPED object literal receiver's own property", async () => {
    // `{ pre: 44 }` lowers to a nominal `(struct (field f64))` private to this
    // module; the provider has no such type and its dynamic get cannot reach
    // the field. The SAME object with one dynamic add (which demotes it to the
    // canonical `$Object`) is the passing pin two blocks up.
    expect(await runLinked(`var o = { pre: 44 }; return Function("return this.pre;").call(o) === 44 ? 1 : 3;`)).toBe(1);
  });

  it.skipIf(REFUSAL_TIER).fails("writes a NEW property through a compiled ARRAY receiver", async () => {
    // Split measured on base AND on this branch: the write lands inside the
    // provider (`return this.post` in the same call answers 22) but never
    // reaches the caller's array. Reads through the same receiver DO work —
    // see the positive pin above — so this is the SET half of the seam, not
    // the receiver.
    expect(
      await runLinked(`
      var arr = [11, 22];
      Function("this.post = this[1];").call(arr);
      return arr.post === 22 ? 1 : 3;
    `),
    ).toBe(1);
  });

  it.skipIf(REFUSAL_TIER).fails("writes through a compiled FUNCTION receiver", async () => {
    // built-ins/Function/prototype/{call,apply}/S15.3.4.3_A5_T8 — `var obj =
    // Function();` is an AOT-synthesized closure struct, equally private.
    // The write does not even stick inside the provider: the same call's
    // `return this.touched` reads back `undefined`.
    expect(
      await runLinked(`
      function g() {}
      Function("this.touched = true;").call(g);
      return g.touched === true ? 1 : 3;
    `),
    ).toBe(1);
  });
});
