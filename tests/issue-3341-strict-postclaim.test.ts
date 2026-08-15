// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3341 Slice C — strict POST-CLAIM codes.
//
// Slice B promoted the typed `invariant` class. This slice adds the other half:
// a typed `unsupported` code whose post-claim arm restates a predicate the
// SELECTOR already evaluated. `class-member-unsupported` at `build` is the one
// promoted code — its only post-claim site (src/ir/integration.ts, the
// `isCtorMember` arm) demotes when `collectIrClassInstanceInitializers` returns
// undefined, and the selector refuses the claim on that exact same helper
// returning undefined (`constructorFieldInitializersAreIrSafe`,
// src/ir/select.ts). One predicate, two call sites: reaching the build arm on a
// CLAIMED constructor is a selector<->builder desync, not an unlowerable
// program, so it must be loud instead of silently demoting to legacy.
//
// Exercised at the narrowest typed seam (`formatIrPathFallbackDiagnostic` +
// `isStrictIrPostClaimFailure`), mirroring tests/issue-3341-slice-b.test.ts and
// tests/issue-1850.test.ts — no need to reintroduce the underlying desync.
//
// The negative cases are the load-bearing half: this issue's Slice B shipped an
// over-promotion that had to be narrowed twice (#3565, #3784, #4035), so the
// documented demote-to-legacy contracts are pinned here explicitly.

import { describe, expect, it } from "vitest";

import { formatIrPathFallbackDiagnostic, isStrictIrPostClaimFailure } from "../src/codegen/index.js";
import type { IrPreparationFailure, IrUnsupportedCode } from "../src/ir/outcomes.js";

const CLASS_MEMBER_DETAIL = "ir/integration: C_constructor has a dynamically computed instance field name";

function buildFailure(code: IrUnsupportedCode, stage: "select" | "resolve" | "build" | "verify"): IrPreparationFailure {
  return { kind: "unsupported", code, stage, detail: CLASS_MEMBER_DETAIL };
}

describe("#3341 Slice C — strict post-claim codes", () => {
  it("hard-errors a promoted code at a post-claim stage instead of demoting", () => {
    const outcome = buildFailure("class-member-unsupported", "build");
    expect(isStrictIrPostClaimFailure(outcome)).toBe(true);

    const diag = formatIrPathFallbackDiagnostic({
      func: "C_constructor",
      message: CLASS_MEMBER_DETAIL,
      kind: "build",
      outcome,
    });
    expect(diag.severity).toBe("error");
    expect(diag.message).toMatch(/^Codegen error: IR path failed for C_constructor:/);
  });

  it("leaves the SAME code demotable at the pre-claim `select` stage", () => {
    // The selector owns this reason before the claim: 154 such rejections on a
    // 1340-file test262 stride sweep (2026-08-15) are the contract WORKING, not
    // a regression. Only the post-claim stages are strict.
    const outcome = buildFailure("class-member-unsupported", "select");
    expect(isStrictIrPostClaimFailure(outcome)).toBe(false);
  });

  it("leaves `resolve` demotable — that is where a claim is legitimately withdrawn", () => {
    // #1921: `type-resolution-unsupported` at resolve keeps a working legacy
    // body for a class-typed cross-function return the IR cannot represent.
    // Excluded structurally (by stage), not by an easily-lost per-code entry.
    const outcome = buildFailure("type-resolution-unsupported", "resolve");
    expect(isStrictIrPostClaimFailure(outcome)).toBe(false);

    const diag = formatIrPathFallbackDiagnostic({
      func: "claimed",
      message: CLASS_MEMBER_DETAIL,
      kind: "build",
      outcome,
    });
    expect(diag.severity).toBe("warning");
  });

  it("keeps the four #3565 demote-to-legacy contracts demotable", () => {
    const contracts: readonly [IrUnsupportedCode, "build" | "verify"][] = [
      ["element-store-unsupported", "build"],
      ["element-access-unsupported", "build"],
      ["return-type-legacy-coupling", "verify"],
      ["compound-assign-unsupported", "build"],
    ];
    for (const [code, stage] of contracts) {
      const outcome = buildFailure(code, stage);
      expect(isStrictIrPostClaimFailure(outcome)).toBe(false);
      expect(formatIrPathFallbackDiagnostic({ func: "claimed", message: "d", kind: stage, outcome }).severity).toBe(
        "warning",
      );
    }
  });

  it("keeps the later-found members of that same class demotable (#3784, #4035)", () => {
    for (const code of [
      "unboxed-number-local-unprovable",
      "throw-value-unsupported",
      "unknown-class-construction",
    ] as const) {
      expect(isStrictIrPostClaimFailure(buildFailure(code, "build"))).toBe(false);
    }
  });

  it("keeps the codes measured NON-zero by the Slice C sweep demotable", () => {
    // 1340-file test262 stride-40 sweep, 2026-08-15: exactly three post-claim
    // rows, none of them promoted. Promoting either of these would regress a
    // real program today, which is the whole reason corpus-zero is necessary
    // but not sufficient.
    expect(isStrictIrPostClaimFailure(buildFailure("module-init-legacy-coupling", "build"))).toBe(false);
    expect(isStrictIrPostClaimFailure(buildFailure("abi-signature-parity", "resolve"))).toBe(false);
  });

  it("does not disturb the #680 target-omitted host-import narrowing", () => {
    // A standalone generator referencing the host-only `__gen_create_buffer` is
    // an INVARIANT that Slice B deliberately re-narrowed to a warning. The
    // post-claim predicate is scoped to `unsupported`, so it cannot re-promote
    // it.
    const diag = formatIrPathFallbackDiagnostic(
      {
        func: "g",
        message: 'ir/integration: unknown function ref "__gen_create_buffer"',
        kind: "lower",
        outcome: {
          kind: "invariant",
          code: "unknown-function-ref",
          stage: "lower",
          detail: 'ir/integration: unknown function ref "__gen_create_buffer"',
        },
      },
      { standalone: true, wasi: false },
    );
    expect(diag.severity).toBe("warning");
  });
});
