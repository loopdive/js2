// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile, type IrObservedOutcome } from "../src/index.js";

/**
 * #4508 — the second edge kind #4494's `## Follow-up` named.
 *
 * `recordGlobalReference` fails a source-global read closed with
 * `source-global-outside-component` whenever the global's storage terminal is
 * outside the sealed transaction. For a top-level `var`/`let`/`const` that
 * terminal is the module-init, and `preparedExactLexicalModuleInit` refuses to
 * prepare a module-init at all on the standalone / WASI / fast lanes — so on
 * those lanes EVERY module-binding reader that claims is guaranteed to degrade
 * after the claim. `selectR2PreparedOwnerComponents` now withdraws the reader
 * before it can claim, and it emits through the post-direct overlay instead.
 *
 * What these tests pin:
 *   1. the co-preparation shape itself — a module-binding reader plus its
 *      caller now compile on standalone, where the base hard-failed;
 *   2. ONE-DIRECTIONALITY — the module-init does not need its readers, so a
 *      host-lane component that legitimately co-prepares all three owners is
 *      untouched;
 *   3. shadowing — a local that shadows a module binding is not a reader;
 *   4. the four `algorithms.ts` units that lost COMPILE-ONCE as collateral, so
 *      the call-closure refinement that restores them flips a test rather than
 *      going unnoticed.
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

/** #4461's exact control shape — a module-binding reader behind one caller. */
const MODULE_BINDING_READER = `let counter = 0;
function read(): number { return counter; }
export function run(): number { return read() + 1; }`;

describe("#4508 module-binding reader co-preparation", () => {
  it("compiles the reader shape on standalone, where the base failed outright", async () => {
    // Base (#4461's documented residual, re-measured on this branch's merge
    // base): `success: false` — `read` demoted to
    // `resolve/late-preparation-unsupported` AFTER its claim, and `run` then
    // hit a hard `invariant/patch/unpatched-slot` because its legacy body had
    // already been skipped. Withdrawing `read` BEFORE the claim removes both.
    const { success, units } = await outcomes(MODULE_BINDING_READER, "standalone");
    expect(success).toBe(true);
    for (const name of ["read", "run", "<module-init>"]) {
      const observed = unit(units, name);
      expect(observed.kind, `${name}: ${observed.code ?? ""}`).toBe("emitted");
      expect(observed.irBodyEmitted, `${name} emitted no IR body`).toBe(true);
    }
    expect(units.filter((observed) => observed.kind === "invariant")).toEqual([]);
  });

  it("is ONE-DIRECTIONAL — the host lane still co-prepares reader and storage together", async () => {
    // The negative arm. On the host lane `preparedExactLexicalModuleInit`
    // admits the module-init, so the storage terminal IS in the transaction and
    // the new edge is inert: nothing withdraws. If the edge were consumed
    // bidirectionally (module-init needing its readers, or resolved against the
    // free/class `candidates` set the module-init is never a member of), this
    // component would withdraw and these three would lose compile-once.
    const { success, units } = await outcomes(MODULE_BINDING_READER, "gc");
    expect(success).toBe(true);
    for (const name of ["read", "run", "<module-init>"]) {
      const observed = unit(units, name);
      expect(observed.kind, `${name}: ${observed.code ?? ""}`).toBe("emitted");
      expect(observed.irBodyEmitted).toBe(true);
    }
    expect(unit(units, "read").legacyBodyEmitted).toBe(false);
    expect(unit(units, "run").legacyBodyEmitted).toBe(false);
  });

  it("does not treat a shadowed name as a module-binding read", async () => {
    // Shadow safety, and the direction of the approximation: a name declared
    // inside the owner is NOT a module-binding read, so nothing withdraws and
    // the owner keeps compile-once on the host lane.
    const { success, units } = await outcomes(
      `let counter = 0;
       export function run(): number { const counter = 41; return counter + 1; }`,
      "gc",
    );
    expect(success).toBe(true);
    const run = unit(units, "run");
    expect(run.kind).toBe("emitted");
    expect(run.legacyBodyEmitted).toBe(false);
  });

  it("keeps a reader-free owner prepared beside a module binding on standalone", async () => {
    // The withdrawal is per-READER, not per-source: a top-level binding does
    // not by itself demote an owner that never touches it.
    const { success, units } = await outcomes(
      `let counter = 0;
       export function pure(n: number): number { return n * 2; }`,
      "standalone",
    );
    expect(success).toBe(true);
    const pure = unit(units, "pure");
    expect(pure.kind, pure.code ?? "").toBe("emitted");
    expect(pure.irBodyEmitted).toBe(true);
  });
});

describe("#4508 reference corpus, standalone lane", () => {
  async function standaloneCorpus(entry: string): Promise<readonly Observed[]> {
    const { success, units } = await outcomes(readFileSync(entry, "utf-8"), "standalone", entry);
    expect(success).toBe(true);
    return units;
  }

  it("recovers algorithms.ts::fibMemo and ::main", async () => {
    // The #4462 tripwire this issue was built to flip. `fibMemo` reads the
    // module-level `const fibCache`; `main` cascaded off it via
    // `foreign-source-unit`. Both were `resolve/late-preparation-unsupported`.
    const units = await standaloneCorpus("website/playground/examples/js/algorithms.ts");
    for (const name of ["fibMemo", "main"]) {
      const observed = unit(units, name);
      expect(observed.kind, `${name}: ${observed.code ?? ""}`).toBe("emitted");
      expect(observed.irBodyEmitted).toBe(true);
    }
    expect(units.filter((observed) => observed.kind === "invariant")).toEqual([]);
  });

  it("restores compile-once for the four units that lost it as collateral (#4514)", async () => {
    // This assertion was inverted until #4514: the four were pinned
    // compile-TWICE, as the tripwire for the refinement that would restore
    // them. `main` fails to seal on its OWN `unplanned-abi-binding` providers
    // (`__ir_console_sink_append`, `__ir_number_to_string_native`,
    // `__ir_string_concat`) independently of `fibMemo`, so parity withdraws it
    // — and the reverse `callers` edge then dragged its whole callee fan-out
    // out of the component. #4514 refined that edge directionally: an outside
    // caller withdraws a callee only when the callee's ABI is not certified
    // against it, and these four are (scalar/vector-of-scalar signatures whose
    // prepared projection equals their allocated Program ABI slot).
    const units = await standaloneCorpus("website/playground/examples/js/algorithms.ts");
    for (const name of ["fibIter", "binarySearch", "quicksort", "joinNums"]) {
      const observed = unit(units, name);
      expect(observed.kind, `${name}: ${observed.code ?? ""}`).toBe("emitted");
      expect(observed.irBodyEmitted, `${name} lost its IR body`).toBe(true);
      expect(observed.legacyBodyEmitted, `${name} lost compile-once again`).toBe(false);
    }
  });
});
