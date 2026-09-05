// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Test-only fail-closed mutations for the exact multi-source string route. */

import type { PreparedCountedStringAppendReceipt } from "../ir/ast-lowering-plans.js";
import type { IrUnitId } from "../ir/identity.js";
import type { IrIntegrationReport } from "../ir/integration-report.js";
import { IrInvariantError } from "../ir/outcomes.js";

export type MultiPreparedStringLeafTamperPhase =
  | "support"
  | "preparation-receipt"
  | "skip-report"
  | "post-direct-currentness"
  | "post-merge-receipt";

export interface MultiPreparedStringLeafTestTamper {
  readonly apply: (phase: MultiPreparedStringLeafTamperPhase, mutate: () => void) => void;
  readonly assertConsumed: () => void;
}

const PHASES = new Set<MultiPreparedStringLeafTamperPhase>([
  "support",
  "preparation-receipt",
  "skip-report",
  "post-direct-currentness",
  "post-merge-receipt",
]);

function fail(stage: "resolve" | "patch", detail: string): never {
  throw new IrInvariantError("selection-preparation-mismatch", stage, `multi-source string leaf: ${detail}`);
}

export function createMultiPreparedStringLeafTestTamper(unitId: IrUnitId): MultiPreparedStringLeafTestTamper {
  const raw = process.env.JS2WASM_TEST_TAMPER_MULTI_PREPARED_STRING_LEAF;
  if (!raw) return Object.freeze({ apply: () => {}, assertConsumed: () => {} });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("resolve", "test tamper selector is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("resolve", "test tamper selector must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "phase" ||
    keys[1] !== "unitId" ||
    typeof record.unitId !== "string" ||
    typeof record.phase !== "string" ||
    !PHASES.has(record.phase as MultiPreparedStringLeafTamperPhase)
  ) {
    fail("resolve", "test tamper selector must contain only an exact unitId and phase");
  }
  if (record.unitId !== unitId) fail("resolve", `test tamper selector did not match exact route ${unitId}`);
  const phase = record.phase as MultiPreparedStringLeafTamperPhase;
  let matches = 0;
  return Object.freeze({
    apply(currentPhase: MultiPreparedStringLeafTamperPhase, mutate: () => void): void {
      if (phase !== currentPhase) return;
      if (++matches !== 1) fail("patch", `test tamper selector for ${unitId} matched more than once`);
      mutate();
    },
    assertConsumed(): void {
      if (matches !== 1) fail("patch", `test tamper selector for ${unitId} matched ${matches} times`);
    },
  });
}

export function tamperMultiPreparedStringSkipReport(
  tamper: MultiPreparedStringLeafTestTamper,
  skippedFunctionUnitIds: ReadonlySet<IrUnitId>,
  foreignUnitId: IrUnitId,
): void {
  tamper.apply("skip-report", () => (skippedFunctionUnitIds as Set<IrUnitId>).add(foreignUnitId));
}

export function multiPreparedStringMergedReportForTest(
  tamper: MultiPreparedStringLeafTestTamper,
  report: IrIntegrationReport,
  stored: PreparedCountedStringAppendReceipt,
): IrIntegrationReport {
  let observed = report;
  tamper.apply("post-merge-receipt", () => {
    observed = { ...report, preparedCountedStringAppendReceipts: Object.freeze([stored, stored]) };
  });
  return observed;
}
