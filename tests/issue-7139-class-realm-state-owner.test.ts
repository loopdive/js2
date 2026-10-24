// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeRealmObjectState,
  requireNativeRealmObjectState,
  requireNativeRealmObjectLayouts,
  bindNativeRealmObjectBootstrap,
  requireNativeRealmObjectBootstrap,
  nativeRealmObjectStateReservationInventory,
  type NativeRealmObjectLayoutReservations,
} from "../src/backend/wasmgc/resources/native-realm-object-layouts.js";
function fixture() {
  const tx = new PhysicalModuleReservations(createEmptyModule());
  const state = reserveNativeRealmObjectState(tx, "class-state");
  return { tx, state };
}
it("state-only issuance does not certify ordinary-object layouts", () => {
  const { tx, state } = fixture();
  expect(Object.keys(state.types)).toEqual(["identity", "state"]);
  expect(nativeRealmObjectStateReservationInventory(tx, state).types).toHaveLength(2);
  // Deliberate untyped caller: state authority cannot masquerade as the larger owner.
  expect(() => requireNativeRealmObjectLayouts(tx, state as NativeRealmObjectLayoutReservations)).toThrow(/state-only/);
  expect(() => requireNativeRealmObjectState(tx, { ...state })).toThrow(/foreign or copied/);
  expect(() => requireNativeRealmObjectState(fixture().tx, state)).toThrow(/foreign or copied/);
});
it("authenticates one actual bootstrap reservation before freeze", () => {
  const { tx, state } = fixture();
  const bootstrap = tx.reserveFunction("bootstrap", "bootstrap", { params: [], results: [] });
  const other = tx.reserveFunction("other", "other", { params: [], results: [] });
  bindNativeRealmObjectBootstrap(tx, state, bootstrap);
  expect(() => requireNativeRealmObjectBootstrap(tx, state, bootstrap)).not.toThrow();
  expect(() => requireNativeRealmObjectBootstrap(tx, state, other)).toThrow(/foreign realm bootstrap/);
  expect(() => bindNativeRealmObjectBootstrap(tx, state, other)).toThrow(/duplicate bootstrap binding/);
});
it("rejects a wrong bootstrap ABI", () => {
  const { tx, state } = fixture();
  const wrong = tx.reserveFunction("wrong", "wrong", { params: [{ kind: "f64" }], results: [] });
  expect(() => bindNativeRealmObjectBootstrap(tx, state, wrong)).toThrow(/bootstrap requires/);
});

for (const copied of [false, true])
  it(`rejects ${copied ? "copied" : "foreign"} bootstrap authority`, () => {
    const { tx, state } = fixture();
    const issuer = copied ? tx : fixture().tx;
    const real = issuer.reserveFunction("bootstrap", "bootstrap", { params: [], results: [] });
    expect(() => bindNativeRealmObjectBootstrap(tx, state, copied ? { ...real } : real)).toThrow(
      /foreign|copied|unowned/i,
    );
    expect(tx.state).toBe("failed");
  });

it("realm bootstrap completion rejects a changed class allocator after genuine canonical fill", async () => {
  const { prepareClassAllocationProgram } = await import("./helpers/prepared-class-values.js");
  const { realmFoundation } = await import("./helpers/native-realm-source-integration.js");
  const { beginNativeSourceClosureEmission } = await import("../src/ir/program-native-invocation.js");
  const {
    reserveNativeRealmKernel,
    nativeRealmReservationInventory,
    fillNativeRealmResources,
    requireCompletedNativeRealmBootstrap,
  } = await import("../src/backend/wasmgc/program/native-realm.js");
  const { fillNativeStringValueResources } = await import("../src/backend/wasmgc/program/native-string-values.js");
  const f = realmFoundation(prepareClassAllocationProgram());
  const source = beginNativeSourceClosureEmission(
    f.tx,
    f.requirements.source!,
    {
      vectors: f.foundation.vectorTypes,
      vectorPlan: f.vectorPlan,
      realmState: f.realm.classRealm!.state,
      strings: {
        types: f.foundation.stringTypes!,
        key: f.foundation.stringTypes!.key,
        utf8Storage: f.foundation.stringTypes!.utf8Storage,
      },
    },
    f.realm.requests,
  );
  reserveNativeRealmKernel(f.tx, f.realm, source.types);
  const inventory = nativeRealmReservationInventory(f.tx, f.realm);
  const allocators = inventory.functions.filter((row) => row.object.name === "__class_value_new");
  expect(allocators).toHaveLength(1);
  f.tx.freezeReservations();
  fillNativeStringValueResources(f.tx, f.strings);
  fillNativeRealmResources(f.tx, f.realm);
  // Bootstrap completion is narrower than completed source body / full realm authority.
  expect(requireCompletedNativeRealmBootstrap(f.tx, f.realm)).toBe(f.realm);
  allocators[0]!.object.body.push({ op: "nop" });
  expect(() => requireCompletedNativeRealmBootstrap(f.tx, f.realm)).toThrow(
    /altered completed function.*class-values:allocate/,
  );
});
