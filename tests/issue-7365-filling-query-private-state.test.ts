// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7365 B′ — an index query during filling does not audit the layout, so it must answer from the ledger's private
// state alone: nothing public, altered and restored around the query or altered by a stateful getter, may move the
// index it returns. A layout left altered is still refused at seal (RV7365B review round 1).
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { expectUnemittable, sealed } from "./helpers/reservation-audit-points.js";

const voidSignature = { params: [], results: [] };

function ledger() {
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  const imported = tx.reserveFunctionImport("import:f", "env", "f", voidSignature);
  const first = tx.reserveFunction("first", "first", voidSignature);
  const second = tx.reserveFunction("second", "second", voidSignature);
  tx.freezeReservations();
  const fill = () => {
    tx.fillFunction(first, { locals: [], body: [] });
    tx.fillFunction(second, { locals: [], body: [] });
  };
  return { module, tx, tokens: [imported, first, second], fill };
}

describe("#7365 B′ an index query during filling answers from private state", () => {
  it("is not moved by a stateful getter on an import record's descriptor, and seal refuses the layout", () => {
    const { module, tx, tokens, fill } = ledger();
    const record = module.imports[0]!;
    const desc = record.desc;
    let reads = 0;
    // Every other read names a global import: a count over the public records would move `first` from 1 to 0.
    Object.defineProperty(record, "desc", {
      enumerable: true,
      configurable: true,
      get: () => (reads++ % 2 === 0 ? desc : { kind: "global", type: { kind: "i32" }, mutable: false }),
    });
    for (let repeat = 0; repeat < 4; repeat++) expect(tx.physicalIndices(tokens)).toEqual([0, 1, 2]);
    expect(tx.physicalIndex(tokens[1]!)).toBe(1);
    fill();
    // The seal audit reads the record once and may see the genuine descriptor; the validation read after it then
    // sees the other one and still refuses through the ledger.
    expect(() => sealed(tx)).toThrow(/^physical module reservations: /);
    expectUnemittable(tx);
  });

  it("is not moved by a layout altered and restored around the query", () => {
    const { module, tx, tokens, fill } = ledger();
    const alter = () => {
      module.funcOrdinalToPosition.reverse();
      module.imports.push({ module: "phantom", name: "g", desc: { kind: "func", typeIdx: 0 } });
    };
    const restore = () => {
      module.imports.length -= 1;
      module.funcOrdinalToPosition.reverse();
    };
    alter();
    const indices = tx.physicalIndices(tokens);
    const single = tx.physicalIndex(tokens[2]!);
    restore();
    expect(indices).toEqual([0, 1, 2]);
    expect(single).toBe(2);
    fill();
    // Restored, the layout is genuine again: seal accepts it, and the answers given while it was altered were true.
    expect(sealed(tx)).toBeUndefined();
    expect(tx.physicalIndices(tokens)).toEqual([0, 1, 2]);
  });

  it("refuses at seal a layout altered during filling and left altered", () => {
    const { module, tx, tokens, fill } = ledger();
    module.funcOrdinalToPosition.reverse();
    expect(tx.physicalIndices(tokens)).toEqual([0, 1, 2]);
    fill();
    expect(() => sealed(tx)).toThrow(/physical module reservations: .*funcOrdinalToPosition/);
    expectUnemittable(tx);
  });
});
