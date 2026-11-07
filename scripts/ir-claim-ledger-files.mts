// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7249 — per-file rows for `scripts/ir-claim-ledger.mts --wrapped`.
 *
 * The conformance report's `ir_only_pass` counts a standalone pass whose
 * compile has `ir_legacy_units === 0` (scripts/build-test262-report.mjs). A
 * file only moves that number once EVERY unit, harness included, ships an IR
 * body, so the aggregate tallies cannot say which files are close. A row names
 * each file's remaining legacy units; the histogram counts files by how many
 * remain.
 *
 * "Legacy" uses the worker's definition (`summarizeIrRoute`,
 * scripts/test262-worker.mjs): a unit with no IR body is legacy; a unit whose
 * IR body was emitted counts as IR even when the direct dispatcher also ran
 * (`bothUnits`); `non-executable` rows are not units.
 */
import type { IrObservedOutcome } from "../src/index.js";

export type UnitOrigin = "harness" | "test";

interface LegacyUnit {
  readonly name: string;
  readonly origin: UnitOrigin;
  readonly kind: IrObservedOutcome["unitKind"];
  /** `JS2WASM_IR_SHAPE_DIAG=1` only: the compiler's first refusal for this unit. */
  readonly firstRefusal?: string;
}

export interface FileRow {
  readonly file: string;
  readonly compileOk: boolean;
  readonly units: number;
  readonly legacyUnits: LegacyUnit[];
  readonly irUnits: number;
  readonly bothUnits: number;
}

export function fileRow(
  file: string,
  compileOk: boolean,
  outcomes: readonly IrObservedOutcome[],
  originOf: (outcome: IrObservedOutcome) => UnitOrigin,
): FileRow {
  const legacyUnits: LegacyUnit[] = [];
  let units = 0;
  let irUnits = 0;
  let bothUnits = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === "non-executable") continue;
    units += 1;
    if (outcome.irBodyEmitted) {
      if (outcome.legacyBodyEmitted) bothUnits += 1;
      else irUnits += 1;
      continue;
    }
    const firstRefusal = outcome.kind === "unsupported" ? outcome.detail : undefined;
    legacyUnits.push({
      name: outcome.displayName,
      origin: originOf(outcome),
      kind: outcome.unitKind,
      ...(firstRefusal ? { firstRefusal } : {}),
    });
  }
  return { file, compileOk, units, legacyUnits, irUnits, bothUnits };
}

const HISTOGRAM_BUCKETS = ["0", "1", "2", "3", "4+"] as const;
type LegacyUnitHistogram = Record<(typeof HISTOGRAM_BUCKETS)[number], number>;

/** Over files that compiled: only those can become `ir_only_pass` rows. */
export function legacySummary(rows: readonly FileRow[]): {
  zeroLegacyFiles: number;
  legacyUnitHistogram: LegacyUnitHistogram;
} {
  const legacyUnitHistogram = Object.fromEntries(HISTOGRAM_BUCKETS.map((bucket) => [bucket, 0])) as LegacyUnitHistogram;
  for (const row of rows) {
    if (!row.compileOk) continue;
    legacyUnitHistogram[HISTOGRAM_BUCKETS[Math.min(row.legacyUnits.length, 4)]] += 1;
  }
  return { zeroLegacyFiles: legacyUnitHistogram["0"], legacyUnitHistogram };
}
