// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4033 — every Program ABI callable role must own a DISTINCT role ordinal.
//
// Structural order is the tuple `(source, declaration, domain, role, derived)`.
// Two roles sharing a role ordinal are indistinguishable whenever their other
// four components coincide, and `ProgramAbiSession` then rejects the second
// draft with `duplicate-draft-order`, aborting the whole compile.
//
// That is exactly what happened: `program-abi-provider-planning.ts` carried a
// bare `PROGRAM_ABI_PROVIDER_ROLE_ORDINAL = 5` literal that duplicated
// `PROGRAM_ABI_CALLABLE_ROLE.moduleInit = 5`. Nothing tied the two together, so
// nothing kept them apart. On the ESLint `linter.js` graph an
// `intrinsic-provider` callable and a `legacy-module-init-pass` support callable
// both landed on `118:0:0:5:0` and the compile died.
//
// WHY THIS IS A UNIT ASSERTION RATHER THAN A COMPILE FIXTURE: the collision
// needs a provider draft AND a legacy-module-init-pass draft on the same entry
// source with equal derived ordinals. Twelve small multi-source graphs (Math
// intrinsics, string runtime calls, 2- and 4-source chains, each under `plain`
// /`experimentalIR`/`trackIrOutcomes`/both) all compiled CLEAN — the shape only
// arose on a 146-source real-world graph. Pinning the invariant directly is
// both faster and stronger than a fixture that happens to trip it, and it
// catches the NEXT duplicated ordinal instead of only this one.

import { describe, expect, it } from "vitest";

import {
  PROGRAM_ABI_CALLABLE_ROLE,
  programAbiCallableRoleOrdinalsAreDistinct,
} from "../src/codegen/program-abi-planning.js";

describe("#4033 — Program ABI callable role ordinals", () => {
  it("are pairwise distinct", () => {
    const byOrdinal = new Map<number, string[]>();
    for (const [role, ordinal] of Object.entries(PROGRAM_ABI_CALLABLE_ROLE)) {
      byOrdinal.set(ordinal, [...(byOrdinal.get(ordinal) ?? []), role]);
    }
    const duplicates = [...byOrdinal.entries()]
      .filter(([, roles]) => roles.length > 1)
      .map(([ordinal, roles]) => `${ordinal}: ${roles.join(" + ")}`);

    expect(
      duplicates,
      "two callable roles share a structural role ordinal — they will collide in ProgramAbiSession",
    ).toEqual([]);
    expect(programAbiCallableRoleOrdinalsAreDistinct()).toBe(true);
  });

  it("give callable providers an ordinal of their own, separate from module init", () => {
    // The precise regression: these were both 5.
    expect(PROGRAM_ABI_CALLABLE_ROLE.callableProvider).not.toBe(PROGRAM_ABI_CALLABLE_ROLE.moduleInit);
  });

  it("are non-negative integers", () => {
    // A structural ordinal must satisfy the session's `validOrdinal` check;
    // a negative or fractional value would be rejected as an invalid draft
    // order rather than as a collision, which is a confusingly different error.
    for (const [role, ordinal] of Object.entries(PROGRAM_ABI_CALLABLE_ROLE)) {
      expect(Number.isInteger(ordinal), `${role} ordinal must be an integer`).toBe(true);
      expect(ordinal, `${role} ordinal must be non-negative`).toBeGreaterThanOrEqual(0);
    }
  });
});
