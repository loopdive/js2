// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4155 — a fnctor field slot that is `externref` has two very different
// causes, and the emitted binary cannot distinguish them:
//
//   unknown   — the checker had nothing, so a box is the honest lowering;
//   discarded — the checker named a real type and #1712 boxed the instance
//               anyway, because the ctor-derived struct and the checker's
//               instance shape have no subtype relation.
//
// Only the second is actionable, and telling them apart is what redirected
// #4155 away from "infer harder" (measured: 2 rescuable fields across all of
// acorn) toward reconciling the two shape models. The classifier is therefore
// the load-bearing part and is tested directly; the census wiring is tested
// through a real compile.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import {
  classifyFieldSlot,
  fnctorFieldProvenanceRecords,
  formatFnctorFieldProvenance,
  resetFnctorFieldProvenance,
} from "../src/codegen/fnctor-field-provenance.js";

describe("#4155 fnctor field slot classification", () => {
  it("calls a machine-typed slot `typed` regardless of what the checker said", () => {
    expect(classifyFieldSlot("f64", "number", "number")).toBe("typed");
    // A typed slot is typed even when the checker was useless — the syntactic
    // seed rule recovered it (acorn's `this.pos = 0`).
    expect(classifyFieldSlot("f64", "any", "any")).toBe("typed");
  });

  it("calls a boxed slot with no checker information `unknown`", () => {
    expect(classifyFieldSlot("externref", "any", "any")).toBe("unknown");
    expect(classifyFieldSlot("externref", "any", "")).toBe("unknown");
  });

  it("calls a boxed slot with a KNOWN type `discarded` — the #4155 bucket", () => {
    // acorn's `this.type = types$1.eof`, the tokenizer's hottest field.
    expect(classifyFieldSlot("externref", "any", "TokenType")).toBe("discarded");
    // `this.options = getOptions(options)` — an object shape, also discarded.
    expect(classifyFieldSlot("externref", "any", "{ ecmaVersion: number; }")).toBe("discarded");
  });
});

const FNCTOR_SRC = `
function Box(seed) {
  this.count = 0;          // literal seed -> machine slot
  this.label = String(seed); // known builtin -> string slot
  this.payload = seed;     // untyped param  -> boxed, checker has nothing
}
Box.prototype.bump = function () { this.count = this.count + 1; return this.count; };
export function main() { var b = new Box("x"); return b.bump(); }
`;

describe("#4155 provenance census", () => {
  it("is silent and records nothing when the env gate is off", async () => {
    resetFnctorFieldProvenance();
    const saved = process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE;
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
    delete process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE;
    try {
      const r = await compile(FNCTOR_SRC, { fileName: "t.js", allowJs: true, skipSemanticDiagnostics: true });
      expect(r.success, r.errors.map((e) => e.message).join("; ")).toBe(true);
      expect(fnctorFieldProvenanceRecords().length).toBe(0);
      expect(formatFnctorFieldProvenance()).toBe("");
    } finally {
      if (saved !== undefined) process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE = saved;
    }
  });

  it("records one row per ctor `this.<field>` slot when enabled", async () => {
    resetFnctorFieldProvenance();
    const saved = process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE;
    process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE = "1";
    try {
      const r = await compile(FNCTOR_SRC, { fileName: "t.js", allowJs: true, skipSemanticDiagnostics: true });
      expect(r.success, r.errors.map((e) => e.message).join("; ")).toBe(true);

      const rows = fnctorFieldProvenanceRecords().filter((x) => x.owner === "Box");
      const byField = new Map(rows.map((x) => [x.field, x]));
      // Floor the count rather than asserting an exact set: a silent-empty
      // census would otherwise pass every assertion below by vacuity.
      expect(rows.length).toBeGreaterThanOrEqual(3);

      // All three buckets, on real compiler output rather than synthetic input.
      //
      // `count` — literal seed, so the syntactic rule recovers f64 even though
      // the checker says `any` for the LHS. Lane-invariant.
      const count = byField.get("count")!;
      expect(count.slot).toBe("f64");
      expect(classifyFieldSlot(count.slot, count.lhsType, count.rhsType)).toBe("typed");

      // `payload` — an untyped ctor parameter. The checker genuinely has
      // nothing, so a box is the honest lowering. NOT a #4155 case.
      const payload = byField.get("payload")!;
      expect(payload.rhsType).toBe("any");
      expect(classifyFieldSlot(payload.slot, payload.lhsType, payload.rhsType)).toBe("unknown");

      // `label` — the discrimination that matters. The checker says `string`
      // here exactly as it does in the standalone lane; only the JS-host lane
      // cannot use it, because host strings are `externref`. Same knowledge,
      // different representation — which is what "discarded" means, and why
      // more inference would not have helped this field.
      const label = byField.get("label")!;
      expect(label.rhsType).toBe("string");
      expect(label.slot).toBe("externref");
      expect(classifyFieldSlot(label.slot, label.lhsType, label.rhsType)).toBe("discarded");

      const report = formatFnctorFieldProvenance();
      expect(report).toContain("[fnctor-field-provenance]");
      expect(report).toContain("Box.label — checker said string, emitted externref");
    } finally {
      resetFnctorFieldProvenance();
      // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
      if (saved === undefined) delete process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE;
      else process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE = saved;
    }
  });

  it("leaves the emitted binary byte-identical — census only", async () => {
    const opts = { fileName: "t.js", allowJs: true, skipSemanticDiagnostics: true } as const;
    const saved = process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE;
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
    delete process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE;
    const off = await compile(FNCTOR_SRC, opts);
    process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE = "1";
    const on = await compile(FNCTOR_SRC, opts);
    resetFnctorFieldProvenance();
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
    if (saved === undefined) delete process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE;
    else process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE = saved;

    expect(off.success && on.success).toBe(true);
    expect((on.binary as Uint8Array).length).toBe((off.binary as Uint8Array).length);
  });
});

describe("#4155 a null seed is not a discarded type", () => {
  // `this.value = null` names a real type, but it says nothing about what the
  // field will hold — so it belongs in `unknown`, not in the actionable bucket.
  // Counting it as `discarded` overstated acorn's actionable bucket 10 -> 4.
  it("classifies a bare null/undefined seed as unknown", () => {
    expect(classifyFieldSlot("externref", "any", "null")).toBe("unknown");
    expect(classifyFieldSlot("externref", "any", "undefined")).toBe("unknown");
  });

  it("still calls a genuine named type discarded", () => {
    expect(classifyFieldSlot("externref", "any", "SourceLocation")).toBe("discarded");
  });
});
