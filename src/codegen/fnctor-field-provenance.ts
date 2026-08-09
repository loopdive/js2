// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4155) Why does a fnctor field end up `externref`?
 *
 * `deriveFnctorFields` picks each `__fnctor_<F>` slot type from the FIRST
 * `this.<field> = …` write in the constructor. When the result is `externref`
 * there are two very different reasons, and the emitted binary cannot tell them
 * apart:
 *
 *  - **unknown** — the checker had nothing (`any`), so a box is the only honest
 *    representation. Fixing this needs inference (#743 parameter flow).
 *  - **discarded** — the checker KNEW (acorn's `this.type = types$1.eof` is a
 *    `TokenType`) and #1712 lowered the fnctor instance type to `externref`
 *    anyway, because the ctor-derived struct and the checker's instance shape
 *    have no subtype relation. Fixing this needs the two shape models
 *    reconciled, not more inference.
 *
 * The second bucket is the one #4155 is about, and it was invisible: the WAT
 * shows a slot, never the type that was available when the slot was chosen.
 * On acorn 8.16.0, of 96 field slots: 49 typed, 43 `unknown`, and only 4
 * `discarded` — but those 4 include `Parser.type`, the tokenizer's hottest
 * field at 141 reads. So `unknown` dominates by COUNT (that is #743 parameter
 * inference) while `discarded` matters by READ FREQUENCY. Reporting both is the
 * point; conflating them is how "infer harder" gets scoped, and that measured
 * out at 2 rescuable fields across the whole bundle.
 *
 * `JS2WASM_FNCTOR_FIELD_PROVENANCE=1` prints the census at process exit. Off by
 * default and free when off — the recorder returns before touching anything.
 *
 * House style follows `alloc-census.ts` / `proven-receiver-stats.ts`: env-gated,
 * no behaviour change. The caller passes `ts.Type`s it had ALREADY computed for
 * its own lowering decision; the two `typeToString` calls live here rather than
 * in `deriveFnctorFields` so the god-file does not grow (LOC-budget gate) and
 * the whole census is one module. They are the reason #4155 carries an
 * `oracle-ratchet-allow`: reporting that the checker said `TokenType` needs the
 * type's NAME, which `ctx.oracle`'s registry-free `TypeFact` is designed not to
 * carry.
 */
import type { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";

/** One `this.<field> = …` slot decision. */
export interface FnctorFieldRecord {
  owner: string;
  field: string;
  /** Slot actually emitted. */
  slot: string;
  /** `checker.typeToString` of the LHS (`this.<field>`) at decision time. */
  lhsType: string;
  /** …and of the value being assigned. */
  rhsType: string;
}

export type FieldVerdict = "typed" | "discarded" | "unknown";

/**
 * `typed` — the slot carries a machine type.
 * `discarded` — boxed, but the checker named a real type for the value.
 * `unknown` — boxed and the checker had nothing to offer.
 *
 * Exported for the test: the classification is the whole point of the census,
 * so it is a pure function rather than being inlined into the reporter.
 */
export function classifyFieldSlot(slot: string, lhsType: string, rhsType: string): FieldVerdict {
  if (slot !== "externref") return "typed";
  // `null` / `undefined` are opaque HERE even though they are perfectly good
  // types, because the question this census asks is "was a usable field
  // representation available and dropped?" — and a field seeded `this.value =
  // null` tells you nothing about what it will hold. Counting them as
  // `discarded` overstated the actionable bucket 10 → 4 on acorn (6 of the 10
  // were bare `null` seeds), which is a 2.5x error in exactly the number the
  // issue is meant to prioritise by.
  const opaque = (t: string): boolean =>
    t === "any" || t === "unknown" || t === "error" || t === "" || t === "null" || t === "undefined";
  return opaque(lhsType) && opaque(rhsType) ? "unknown" : "discarded";
}

const records: FnctorFieldRecord[] = [];
let hooked = false;

export function fnctorFieldProvenanceEnabled(): boolean {
  return process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE === "1";
}

/**
 * Record one slot decision. No-op unless the census is enabled.
 *
 * Takes the `ts.Type`s rather than strings so the whole census — including the
 * two `typeToString` calls — lives here instead of in the `deriveFnctorFields`
 * god-file, per the LOC-budget gate's "add code to the subsystem module" rule.
 * Both types were already computed by the caller for its own lowering decision.
 */
export function recordFnctorFieldProvenance(
  ctx: { checker: { typeToString: (t: ts.Type) => string } },
  owner: string,
  field: string,
  slot: ValType,
  lhs: ts.Type,
  rhs: ts.Type,
): void {
  if (!fnctorFieldProvenanceEnabled()) return;
  const lhsType = ctx.checker.typeToString(lhs);
  const rhsType = ctx.checker.typeToString(rhs);
  records.push({ owner, field, slot: slot.kind, lhsType, rhsType });
  if (!hooked) {
    hooked = true;
    process.on("exit", () => process.stderr.write(formatFnctorFieldProvenance()));
  }
}

/** Test seam — the process-exit hook is not observable from a test. */
export function resetFnctorFieldProvenance(): void {
  records.length = 0;
}

/** Test seam — read the raw records. */
export function fnctorFieldProvenanceRecords(): readonly FnctorFieldRecord[] {
  return records;
}

export function formatFnctorFieldProvenance(): string {
  if (records.length === 0) return "";
  const tally = new Map<FieldVerdict, number>();
  const discarded: FnctorFieldRecord[] = [];
  for (const r of records) {
    const v = classifyFieldSlot(r.slot, r.lhsType, r.rhsType);
    tally.set(v, (tally.get(v) ?? 0) + 1);
    if (v === "discarded") discarded.push(r);
  }
  const lines = ["", `[fnctor-field-provenance] ${records.length} field slot(s)`];
  for (const v of ["typed", "discarded", "unknown"] as const) {
    const n = tally.get(v) ?? 0;
    lines.push(`  ${String(n).padStart(5)}  ${((100 * n) / records.length).toFixed(1).padStart(5)}%  ${v}`);
  }
  if (discarded.length > 0) {
    // Only the discarded bucket is listed: it is the actionable one, and it is
    // the bucket a reader would otherwise have to reconstruct by hand from WAT.
    lines.push("  boxed despite a known type (#4155):");
    for (const r of discarded.slice(0, 40)) {
      lines.push(`    ${r.owner}.${r.field} — checker said ${r.rhsType || r.lhsType}, emitted externref`);
    }
    if (discarded.length > 40) lines.push(`    … and ${discarded.length - 40} more`);
  }
  return lines.join("\n") + "\n";
}
