// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile, type IrObservedOutcome } from "../src/index.js";

/**
 * #4514 — directional reverse-callers edge in the R2 prepared-owner fixed
 * point, plus the provider-planning consequence that made the naive version
 * fatal.
 *
 * The ownership fixed point withdraws a candidate when any of four edges leaves
 * the component. Three of them are lowerability/sealing constraints (callee,
 * construction #4494, module-binding storage #4508). The fourth — a CALLER that
 * stays outside — is a SIGNATURE constraint: the outside caller's `call` is
 * emitted against the callee's already-allocated Program ABI slot. When the
 * prepared projection provably equals that slot and every carrier is fixed by
 * the declaration, preparation cannot move the slot, so the withdrawal buys
 * nothing and costs the whole callee fan-out of any withdrawn caller.
 *
 * The second half of the fix: refusing outright to observe a runtime provider
 * discovered after prepared planning made PARTIAL preparation of a source file
 * fatal, because the first prepared transaction sealed the provider denominator
 * for the whole compilation. Late keys are now appended past the sealed prefix,
 * which preserves the property the seal actually protects (no already-minted
 * ordinal moves).
 */

interface Observed {
  readonly kind: string;
  readonly displayName: string;
  readonly code?: string;
  readonly irBodyEmitted?: boolean;
  readonly legacyBodyEmitted?: boolean;
}

async function outcomes(
  source: string,
  target: "gc" | "standalone",
  fileName = "test.ts",
): Promise<{ readonly success: boolean; readonly units: readonly Observed[] }> {
  const result = await compile(source, {
    fileName,
    ...(target === "standalone" ? { target: "standalone" as const } : {}),
    trackIrOutcomes: true,
  });
  return {
    success: result.success,
    units: (result.irOutcomes ?? []) as readonly IrObservedOutcome[] as readonly Observed[],
  };
}

function unit(units: readonly Observed[], displayName: string): Observed {
  const found = units.find((observed) => observed.displayName === displayName);
  expect(found, `no IR outcome recorded for ${displayName}`).toBeDefined();
  return found!;
}

describe("#4514 outside-caller ABI certification", () => {
  it("keeps a certified callee prepared when its only caller is withdrawn", async () => {
    // `main` reads the module binding, so #4508's storage edge withdraws it on
    // standalone. Before #4514 that dragged `twice` out with it through the
    // reverse `callers` edge and `twice` compiled twice. `twice`'s signature is
    // `(number) => number`, whose prepared projection equals its allocated
    // slot, so the outside caller is not a signature hazard.
    // The second declarator intentionally keeps the module-init outside the
    // exact one-binding #4566 transaction; this test owns caller direction,
    // not module-init eligibility.
    const { success, units } = await outcomes(
      `let counter = 0, sentinel = 1;
       function twice(n: number): number { return n * 2; }
       export function main(): number { return twice(counter) + 1; }`,
      "standalone",
    );
    expect(success).toBe(true);
    const twice = unit(units, "twice");
    expect(twice.kind, twice.code ?? "").toBe("emitted");
    expect(twice.irBodyEmitted).toBe(true);
    expect(twice.legacyBodyEmitted, "certified callee lost compile-once to an outside caller").toBe(false);
    // The withdrawn caller itself is NOT pulled back in — the exemption moves
    // the callee's membership, never the caller's.
    expect(unit(units, "main").legacyBodyEmitted, "the exemption leaked to the outside caller").toBe(true);
    expect(units.filter((observed) => observed.kind === "invariant")).toEqual([]);
  });

  it("still withdraws on the storage direction, certified signature or not", async () => {
    // The negative arm — the exemption is caller-direction ONLY. `reader`'s own
    // signature is certified, but it reads the module binding, so #4508's
    // storage edge withdraws it anyway. Widening any direction other than the
    // caller one would flip this to compile-once and break the sealing
    // constraint that edge exists for.
    // Keep the storage owner deliberately non-preparable so this remains a
    // negative storage-edge test after #4566's standalone lexical widening.
    const { success, units } = await outcomes(
      `let counter = 0, sentinel = 1;
       function reader(n: number): number { return n + counter; }
       export function caller(): number { return reader(1); }`,
      "standalone",
    );
    expect(success).toBe(true);
    const reader = unit(units, "reader");
    expect(reader.kind, reader.code ?? "").toBe("emitted");
    expect(reader.legacyBodyEmitted, "the storage direction was exempted").toBe(true);
  });

  it("does not exempt a callee whose carrier the component could re-plan", async () => {
    // The exemption is narrower than R2 admission, not equal to it. Both
    // functions below have a withdrawn caller; `tag` returns `number[]`, a
    // declaration-fixed vector carrier, and keeps compile-once, while `shape`
    // returns an object contract whose carrier the prepared component could
    // still re-plan and stays compile-twice.
    const { success, units } = await outcomes(
      `let counter = 0;
       function tag(n: number): number[] { return [n, n]; }
       function shape(n: number): { v: number } { return { v: n }; }
       export function main(): number { return tag(counter)[0]! + shape(counter).v; }`,
      "standalone",
    );
    expect(success).toBe(true);
    expect(unit(units, "tag").legacyBodyEmitted, "a declaration-fixed vector carrier is certified").toBe(false);
    expect(unit(units, "shape").legacyBodyEmitted, "a re-plannable carrier must not inherit the exemption").toBe(true);
  });

  it("does not exempt a name an annexB block-scoped function also declares", async () => {
    // Caught only by the merge_group re-validation of PR #4627: eight
    // `annexB/language/global-code/*-global-existing-fn-no-init.js` files went
    // pass → compile_error with `ABI draft … function-value-trampoline … would
    // mutate sealed prepared scope`. B.3.3.2 `CanDeclareGlobalFunction` hoisting
    // drafts a support binding on the top-level unit AFTER its component seals,
    // and the signature proof says nothing about support bindings. Isolated:
    // only this shape breaks — an ordinary function-value reference from a
    // withdrawn caller is fine, and so is a nested declaration with a unique
    // name (both covered above / below).
    const { success } = await outcomes(
      `f();
       {
         function f() { return 1; }
       }
       function f() { return 2; }`,
      "gc",
    );
    expect(success).toBe(true);
  });

  it("host lane is unchanged — nothing withdraws there to begin with", async () => {
    const { success, units } = await outcomes(
      `let counter = 0;
       function twice(n: number): number { return n * 2; }
       export function main(): number { return twice(counter) + 1; }`,
      "gc",
    );
    expect(success).toBe(true);
    for (const name of ["twice", "main"]) {
      const observed = unit(units, name);
      expect(observed.kind, `${name}: ${observed.code ?? ""}`).toBe("emitted");
      expect(observed.legacyBodyEmitted).toBe(false);
    }
  });
});

describe("#4514 provider discovery after prepared planning", () => {
  it("compiles a partially prepared source whose late units need a new runtime provider", async () => {
    // The measured failure mode of the naive refinement, as a regression pin:
    // preparing the four certified `algorithms.ts` owners sealed the provider
    // denominator, and `__extern_is_undefined` — first observed while lowering
    // `fibMemo` / `main` / the module-init on the late route — then threw
    // `callable provider … was discovered after prepared provider planning`,
    // taking the whole entry to `success: false` with three invariants.
    const entry = "website/playground/examples/js/algorithms.ts";
    const { success, units } = await outcomes(readFileSync(entry, "utf-8"), "standalone", entry);
    expect(success).toBe(true);
    expect(units.filter((observed) => observed.kind === "invariant")).toEqual([]);
    for (const name of ["fibIter", "binarySearch", "quicksort", "joinNums"]) {
      expect(unit(units, name).legacyBodyEmitted, `${name} is not compile-once`).toBe(false);
    }
    // The units that stay on the late route still emit an IR body — the point
    // is co-existence of the two routes in ONE compilation, not moving these.
    for (const name of ["fibMemo", "main", "<module-init>"]) {
      const observed = unit(units, name);
      expect(observed.kind, `${name}: ${observed.code ?? ""}`).toBe("emitted");
      expect(observed.irBodyEmitted).toBe(true);
    }
  });
});
