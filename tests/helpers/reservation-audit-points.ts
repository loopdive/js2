// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7365) Where a test observes the reservation audit. An index query during filling no longer audits the
// layout; completion checks, freeze and seal do, and every read after seal does. A pinned mutation therefore
// keeps its mutation and its expected error and is observed at one of these points instead of at a bare query:
//
// - `queryAfterAudit(tx, read)`: one completion-check audit, then the read: the order an index query used to
//   audit in (a refusal the audit leaves in the ledger state is seen by the read);
// - `completionCheck(tx, read)`: the read under `PhysicalModuleReservations.audited`, as production completion
//   checks run: the read, then one audit (what the read itself changed is seen by the audit);
// - `sealed(tx)`: the layout is sealed, the last audit before anything is emitted.
//
// `expectUnemittable(tx)` proves the other half of the contract after a refusal: the transaction is failed and
// cannot be sealed, so the altered layout never reaches emission.
import { expect } from "vitest";
import type { PhysicalModuleReservations } from "../../src/wasm/physical/module-reservations.js";

export function queryAfterAudit<T>(tx: PhysicalModuleReservations, read: () => T): T {
  tx.audited(() => undefined);
  return read();
}

export function completionCheck<T>(tx: PhysicalModuleReservations, read: () => T): T {
  return tx.audited(read);
}

export function sealed(tx: PhysicalModuleReservations): void {
  tx.seal();
}

export function expectUnemittable(tx: PhysicalModuleReservations): void {
  expect(tx.state).toBe("failed");
  expect(() => tx.seal()).toThrow(/physical module reservations: operation requires filling, observed failed/);
}
