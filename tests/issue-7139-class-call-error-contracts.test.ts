// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import {
  CLASS_VALUE_ALLOCATION_PROVIDER,
  classValueAllocationProviderMismatch,
} from "../src/ir/runtime/class-value-callable.js";
import { prepareClassCallErrorProgram } from "./helpers/prepared-class-call-errors.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { selectNativeErrorConstructors, nativeErrorAbiBindings } from "../src/ir/program/native-error-setup.js";
import {
  planNativeStringValuePhysical,
  assertNativeStringValueReservationInput,
  type NativeStringValueReservationInput,
} from "../src/backend/wasmgc/program/native-string-values.js";
import { deriveNativeValueResourcePlan } from "../src/ir/program/native-value-resources.js";
import {
  TYPE_ERROR_RUNTIME_PROVIDER,
  nativeErrorConstructorProvider,
  irErrorConstructorDeclaration,
  errorConstructorProviderMismatch,
  errorConstructorPolicyMismatch,
} from "../src/ir/runtime/error-callables.js";
import { irRuntimeFuncRef, irIntrinsicFuncRef } from "../src/ir/core/callable-bindings.js";

function fixture() {
  const program = prepareClassCallErrorProgram(true),
    projection = program.runtime[0]!;
  const demands = collectNativeStringValueDemands(program, projection);
  const outcome = planNativeStringValuePhysical(demands, { representation: "native-string", utf8Storage: false });
  if (outcome.kind !== "planned") throw Error("missing actual mixed error plan");
  const input: NativeStringValueReservationInput = {
    demands,
    plan: outcome.plan,
    ...(outcome.invocationRequirements ? { invocationRequirements: outcome.invocationRequirements } : {}),
    ...(outcome.plan.mode !== "literals"
      ? { valueRequirements: deriveNativeValueResourcePlan(program, projection, "native-string") }
      : {}),
  };
  return { program, projection, demands, input };
}

it("selects a closed canonical no-host TypeError callable and refuses borrowed symbol spellings", () => {
  expect(irErrorConstructorDeclaration(irRuntimeFuncRef("__new_TypeError"))?.feature).toBe("error.type.construct");
  expect(irErrorConstructorDeclaration(irIntrinsicFuncRef("__new_TypeError"))).toBeUndefined();
  expect(irErrorConstructorDeclaration(irRuntimeFuncRef("__new_RangeError"))).toBeUndefined();
  expect(() => nativeErrorConstructorProvider("RangeError" as never)).toThrow(/unknown/);
  expect(TYPE_ERROR_RUNTIME_PROVIDER.hostCapabilities).toEqual([]);
  expect(TYPE_ERROR_RUNTIME_PROVIDER.supportedBackends).toEqual(["wasmgc"]);
  expect(TYPE_ERROR_RUNTIME_PROVIDER.supportedTargets).toEqual(["standalone", "wasi"]);
  expect(errorConstructorPolicyMismatch("error.type.construct", { backend: "linear", target: "standalone" })).toMatch(
    /no-host WasmGC/,
  );
  expect(errorConstructorPolicyMismatch("error.type.construct", { backend: "wasmgc", target: "host" })).toMatch(
    /no-host WasmGC/,
  );
  expect(
    errorConstructorProviderMismatch({
      ...TYPE_ERROR_RUNTIME_PROVIDER,
      signature: { ...TYPE_ERROR_RUNTIME_PROVIDER.signature!, params: [] },
    }),
  ).toMatch(/canonical/);
});

it("declares both actual constructors and their distinct ABI/resource roots once", () => {
  const { demands, input } = fixture();
  expect(selectNativeErrorConstructors(demands).map((row) => row.kind)).toEqual(["ReferenceError", "TypeError"]);
  expect(() => assertNativeStringValueReservationInput(input)).not.toThrow();
  const bindings = nativeErrorAbiBindings(input, 100);
  expect(bindings).toHaveLength(2);
  expect(new Set(bindings.map((row) => row.entry.id)).size).toBe(2);
  for (const binding of bindings) {
    expect(input.plan.declarations.filter((row) => row.key === binding.resourceKey)).toHaveLength(1);
    expect(
      input.plan.reservationSteps.filter((row) => row.kind === "reserve" && row.resourceKey === binding.resourceKey),
    ).toHaveLength(1);
  }
});

it("rejects missing or forged selected error providers", () => {
  const { demands, projection } = fixture();
  const changed = (providers: typeof projection.prepared.manifest.providers) => ({
    ...demands,
    projection: {
      ...projection,
      prepared: { ...projection.prepared, manifest: { ...projection.prepared.manifest, providers } },
    },
  });
  expect(() =>
    selectNativeErrorConstructors(
      changed(projection.prepared.manifest.providers.filter((row) => row.id !== TYPE_ERROR_RUNTIME_PROVIDER.id)),
    ),
  ).toThrow(/unique selected TypeError/);
  const bad = projection.prepared.manifest.providers.map((row) =>
    row.id === TYPE_ERROR_RUNTIME_PROVIDER.id ? { ...row, signature: { ...row.signature!, params: [] } } : row,
  );
  expect(() => selectNativeErrorConstructors(changed(bad))).toThrow(/noncanonical selected TypeError/);
});

for (const mutation of ["missing", "extra", "reordered", "wrong kind"])
  it(`rejects ${mutation} error population before emission`, () => {
    const { input } = fixture(),
      errors = input.plan.errors!;
    const replacement =
      mutation === "missing"
        ? errors.slice(1)
        : mutation === "extra"
          ? [...errors, errors[0]!]
          : mutation === "reordered"
            ? [...errors].reverse()
            : errors.map((row) => ({
                ...row,
                kind: row.kind === "TypeError" ? ("ReferenceError" as const) : ("TypeError" as const),
              }));
    const changed = { ...input, plan: { ...input.plan, errors: replacement } };
    expect(() => nativeErrorAbiBindings(changed, 0)).toThrow(/error selection changed/);
    expect(() => assertNativeStringValueReservationInput(changed)).toThrow(/demand\/plan mismatch/);
  });

for (const [name, canonical, mismatch] of [
  ["class", CLASS_VALUE_ALLOCATION_PROVIDER, classValueAllocationProviderMismatch],
  ["error", TYPE_ERROR_RUNTIME_PROVIDER, errorConstructorProviderMismatch],
] as const)
  it(`rejects executable and foreign ${name} provider records without evaluating them`, () => {
    expect(mismatch(structuredClone(canonical))).toBeUndefined();
    let reads = 0;
    const implementation = { ...canonical.implementation };
    Object.defineProperty(implementation, "symbol", {
      enumerable: true,
      get: () => {
        reads++;
        return "forged";
      },
    });
    expect(mismatch({ ...canonical, implementation })).toMatch(/canonical/);
    expect(reads).toBe(0);
    const foreign = Object.assign(Object.create({ forged: true }), canonical.implementation);
    expect(mismatch({ ...canonical, implementation: foreign })).toMatch(/canonical/);
    const extra = { ...canonical, [Symbol("unissued")]: true };
    expect(mismatch(extra)).toMatch(/canonical/);
  });
