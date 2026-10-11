import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations, type TypeReservation } from "../src/wasm/physical/module-reservations.js";

function fixture() {
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  const token = tx.reserveType("base", { kind: "struct", name: "base", fields: [] });
  return { module, tx, token };
}
function population(module: ReturnType<typeof createEmptyModule>) {
  return {
    types: [...module.types],
    functions: [...module.functions],
    globals: [...module.globals],
    ordinals: [...module.funcOrdinalToPosition],
  };
}

describe("reservation-phase type ownership", () => {
  it("authenticates without allocating or exposing a final index", () => {
    const { module, tx, token } = fixture();
    const before = population(module);
    expect(tx.assertTypeReservation(token)).toBeUndefined();
    expect(tx.state).toBe("reserving");
    expect(population(module)).toEqual(before);
    tx.reserveType("next", { kind: "struct", name: "next", fields: [] });
    expect(module.types).toHaveLength(2);
  });
  it.each(["foreign", "copied"] as const)("rejects %s matching-index tokens without population changes", (kind) => {
    const { module, tx, token } = fixture();
    tx.assertTypeReservation(token);
    const invalid = kind === "foreign" ? fixture().token : { ...token };
    expect(invalid.typeIndex).toBe(token.typeIndex);
    expect(invalid).not.toBe(token);
    const before = population(module);
    expect(() => tx.assertTypeReservation(invalid)).toThrow("foreign or forged");
    expect(population(module)).toEqual(before);
    expect(tx.state).toBe("failed");
  });
  it("rejects an owned non-type token", () => {
    const { module, tx, token } = fixture();
    tx.assertTypeReservation(token);
    const fn = tx.reserveFunction("fn", "fn", { params: [], results: [] });
    const before = population(module);
    expect(() => tx.assertTypeReservation(fn as unknown as TypeReservation)).toThrow("expected type");
    expect(population(module)).toEqual(before);
  });
  it("rejects stale descriptors using existing ledger validation", () => {
    const { tx, token } = fixture();
    tx.assertTypeReservation(token);
    token.object.name = "changed";
    expect(() => tx.assertTypeReservation(token)).toThrow(/altered/);
  });
  it("rejects use after freeze", () => {
    const { tx, token } = fixture();
    tx.assertTypeReservation(token);
    tx.freezeReservations();
    expect(() => tx.assertTypeReservation(token)).toThrow("requires reserving");
  });
});
