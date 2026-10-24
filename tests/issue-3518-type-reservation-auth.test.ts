import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations, type TypeReservation } from "../src/wasm/physical/module-reservations.js";

function fixture() {
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  const token = tx.reserveType("base", { kind: "struct", name: "base", fields: [] });
  return { module, tx, token };
}
function rename(token: TypeReservation, name: string) {
  if (token.object.kind !== "struct") throw Error("fixture requires a struct");
  token.object.name = name;
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
    rename(token, "changed");
    expect(() => tx.assertTypeReservation(token)).toThrow(/altered/);
  });
  it("rejects use after freeze", () => {
    const { tx, token } = fixture();
    tx.assertTypeReservation(token);
    tx.freezeReservations();
    expect(() => tx.assertTypeReservation(token)).toThrow("requires reserving");
  });
});

describe("batched reservation-phase type ownership", () => {
  it("accepts every owned type without allocating, including duplicates and an empty batch", () => {
    const { module, tx, token } = fixture();
    const second = tx.reserveType("second", { kind: "struct", name: "second", fields: [] });
    const before = population(module);
    expect(tx.assertTypeReservations([second, token, second])).toBeUndefined();
    expect(tx.assertTypeReservations([])).toBeUndefined();
    expect(tx.state).toBe("reserving");
    expect(population(module)).toEqual(before);
  });
  it.each(["foreign", "copied", "non-type"] as const)("rejects a late %s token", (kind) => {
    const { tx, token } = fixture();
    const invalid =
      kind === "foreign"
        ? fixture().token
        : kind === "copied"
          ? { ...token }
          : tx.reserveFunction("fn", "fn", { params: [], results: [] });
    expect(() => tx.assertTypeReservations([token, invalid as TypeReservation])).toThrow(
      kind === "non-type" ? "expected type" : "foreign or forged",
    );
    expect(tx.state).toBe("failed");
  });
  it("does not reuse a successful audit after a descriptor changes", () => {
    const { tx, token } = fixture();
    tx.assertTypeReservations([token]);
    rename(token, "changed between calls");
    expect(() => tx.assertTypeReservations([token])).toThrow(/altered/);
  });
  it.each(["sparse", "getter"] as const)("rejects %s entries without executing accessors", (kind) => {
    const { tx, token } = fixture();
    const batch = [token, token];
    let reads = 0;
    if (kind === "sparse") Reflect.deleteProperty(batch, 1);
    else
      Object.defineProperty(batch, 1, {
        get() {
          reads++;
          return token;
        },
      });
    expect(() => tx.assertTypeReservations(batch)).toThrow("dense own-data entries");
    expect(reads).toBe(0);
  });
  it("uses captured own entries without consulting iteration or map hooks", () => {
    const { tx, token } = fixture();
    let reads = 0;
    const batch = new Proxy([token], {
      get(target, key, receiver) {
        reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    tx.assertTypeReservations(batch);
    expect(reads).toBe(0);
  });
  it.each(["layout", "phase"] as const)("rechecks %s after a Proxy descriptor trap", (kind) => {
    const { tx, token } = fixture();
    const batch = new Proxy([token], {
      getOwnPropertyDescriptor(target, key) {
        if (key === "0") {
          if (kind === "layout") rename(token, "changed during capture");
          else tx.freezeReservations();
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(() => tx.assertTypeReservations(batch)).toThrow(kind === "layout" ? /altered/ : /requires reserving/);
    expect(tx.state).toBe("failed");
  });
  it("rejects a transaction poisoned during the layout audit", () => {
    const { tx, token } = fixture();
    const foreign = fixture().tx.reserveTag(
      "foreign",
      { params: [], results: [] },
      { kind: "defined", name: "foreign" },
    );
    let poisoned = false;
    Object.defineProperty(token.object, "name", {
      enumerable: true,
      get() {
        if (!poisoned) {
          poisoned = true;
          try {
            tx.assertTagReservation(foreign, { params: [], results: [] });
          } catch {
            // The descriptor conceals the nested rejection; the caller must still fail.
          }
        }
        return "base";
      },
    });
    expect(() => tx.assertTypeReservations([token])).toThrow("type authentication changed phase");
    expect(poisoned).toBe(true);
    expect(tx.state).toBe("failed");
  });
  it("audits the ledger even for an empty batch", () => {
    const { tx, token } = fixture();
    rename(token, "changed");
    expect(() => tx.assertTypeReservations([])).toThrow(/altered/);
  });
});
