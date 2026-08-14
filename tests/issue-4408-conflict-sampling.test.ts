// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4408 — conflicts must be sampleable independently of weakenings.
//
// `DivergenceLedger.samples` is one FIFO over every divergence. On a real
// corpus `weakened` outnumbers `conflicting` roughly 54:1, so the shared cap
// fills with weakened entries before a single conflict is recorded: the
// 2,137-input differential run had 908 conflicts and surfaced 25, none of them
// from `signatureOf` — the query with the highest conflict count. A worklist
// whose top item is invisible is not a worklist.
//
// These tests pin the separate, per-query-quota'd conflict list.
import { describe, expect, it } from "vitest";
import { DivergenceLedger } from "../src/checker/oracle-backend.ts";

describe("#4408 DivergenceLedger conflict sampling", () => {
  it("records conflicts even when weakenings have exhausted the shared sample cap", () => {
    const ledger = new DivergenceLedger(4);
    for (let i = 0; i < 20; i++) ledger.record("typeFactOf", "number", "unresolvable", `weak${i}`);
    ledger.record("signatureOf", "(number)->number#1", "(string)->string#1", "conflict");

    // The shared FIFO is full of weakenings and never saw the conflict...
    expect(ledger.samples).toHaveLength(4);
    expect(ledger.samples.every((s) => s.inhouse === "unresolvable")).toBe(true);
    // ...but the conflict list did.
    expect(ledger.conflictSamples).toHaveLength(1);
    expect(ledger.conflictSamples[0]).toMatchObject({ query: "signatureOf", node: "conflict" });
  });

  it("quotas conflicts per query so one noisy query cannot starve the others", () => {
    const ledger = new DivergenceLedger(200, 2);
    for (let i = 0; i < 10; i++) ledger.record("signatureOf", "a", "b", `sig${i}`);
    ledger.record("declaredNameOf", "undefined", "ArrayConstructor", "named");

    const queries = ledger.conflictSamples.map((s) => s.query);
    expect(queries.filter((q) => q === "signatureOf")).toHaveLength(2);
    expect(queries).toContain("declaredNameOf");
  });

  it("counts every conflict even when only some are sampled", () => {
    const ledger = new DivergenceLedger(200, 2);
    for (let i = 0; i < 10; i++) ledger.record("signatureOf", "a", "b", `sig${i}`);

    expect(ledger.summary().conflicting).toBe(10);
    expect(ledger.byQuery.get("signatureOf")).toMatchObject({ conflicting: 10 });
    expect(ledger.conflictSamples).toHaveLength(2);
  });

  it("reset() clears the conflict list and its per-query quota", () => {
    const ledger = new DivergenceLedger(200, 1);
    ledger.record("signatureOf", "a", "b", "first");
    ledger.record("signatureOf", "a", "c", "second"); // over quota, dropped
    expect(ledger.conflictSamples).toHaveLength(1);

    ledger.reset();
    expect(ledger.conflictSamples).toHaveLength(0);
    // Quota must reset too, or the next corpus file records nothing.
    ledger.record("signatureOf", "a", "d", "after-reset");
    expect(ledger.conflictSamples).toHaveLength(1);
    expect(ledger.conflictSamples[0].node).toBe("after-reset");
  });
});
