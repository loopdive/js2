// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1984 — Index-space freeze-point discipline (child of #2043 Option 3).
 *
 * #2043's emit-time validation names the *symptom* (which function held a
 * poisoned index). This freeze-point makes the *producer* self-identify: once
 * `ctx.indexSpaceFrozen` is set (right before `stackBalance` in
 * generateModule/generateMultiModule, after every legitimate late import
 * mutation), any further `addImport`/`ensureLateImport` throws at the mutating
 * call site with its own stack instead of silently shifting already-emitted
 * indices.
 *
 * These unit tests drive the two mutation entry points directly with a frozen
 * context and assert the named producer-site error, plus the non-firing cases:
 * a pre-freeze add succeeds, and a frozen *lookup* of an already-registered
 * import is still allowed (it shifts nothing).
 */
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { createCodegenContext } from "../src/codegen/index.js";
import { addImport } from "../src/codegen/registry/imports.js";
import { ensureLateImport } from "../src/codegen/expressions/late-imports.js";
import ts from "typescript";

function makeCtx() {
  return createCodegenContext(createEmptyModule(), {} as unknown as ts.TypeChecker);
}

describe("#1984 — index-space freeze-point discipline", () => {
  it("defaults to not frozen", () => {
    expect(makeCtx().indexSpaceFrozen).toBe(false);
  });

  it("addImport works before the freeze and registers the import", () => {
    const ctx = makeCtx();
    addImport(ctx, "env", "before_freeze", { kind: "func", typeIdx: 0 });
    expect(ctx.mod.imports.some((i) => i.name === "before_freeze")).toBe(true);
    expect(ctx.funcMap.get("before_freeze")).toBe(0);
  });

  it("addImport throws the named producer-site error once frozen", () => {
    const ctx = makeCtx();
    ctx.indexSpaceFrozen = true;
    expect(() => addImport(ctx, "env", "too_late", { kind: "func", typeIdx: 0 })).toThrow(
      /import space frozen \(#1984\).*'env\.too_late' added after finalize/,
    );
    // The import must NOT have been registered (the throw is before the push).
    expect(ctx.mod.imports.some((i) => i.name === "too_late")).toBe(false);
  });

  it("ensureLateImport throws the named producer-site error once frozen (new import)", () => {
    const ctx = makeCtx();
    ctx.indexSpaceFrozen = true;
    expect(() => ensureLateImport(ctx, "late_helper", [], [])).toThrow(
      /import space frozen \(#1984\): late import 'late_helper' requested after finalize/,
    );
  });

  it("a frozen lookup of an ALREADY-registered import is still allowed (no shift)", () => {
    const ctx = makeCtx();
    // Register before freezing, then freeze and look it up — pure lookup, safe.
    const idx = ensureLateImport(ctx, "preexisting", [], []);
    expect(typeof idx).toBe("number");
    ctx.indexSpaceFrozen = true;
    expect(ensureLateImport(ctx, "preexisting", [], [])).toBe(idx);
  });
});
