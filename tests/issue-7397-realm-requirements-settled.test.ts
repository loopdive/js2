// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7397 — `assertNativeRealmRequirementsCurrent` re-derived the whole realm description (`calculate`, with its
// `numberUses` scan over every owner × occurrence) at every call, and the string-literal emit chain calls it once per
// literal. It now keeps its verdict once the pack can no longer change (`checkUnlessSettled`, #7354 Perf): genuine
// prepared input is deeply frozen, so it is checked once; input that can still change is re-checked at every use, and
// a shared-prototype change sends a settled pack back to the full check.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import {
  assertNativeRealmRequirementsCurrent,
  deriveNativeRealmRequirements,
} from "../src/ir/program/native-realm-requirements.js";
import { isImmutablePreparedIrValue } from "../src/ir/program/settled-verdict.js";
import { prepareGetterProgram } from "./helpers/native-getter-invocation-fixture.js";
import { REALM_CALL_SOURCE, REALM_NO_SOURCE } from "./helpers/native-realm-source-integration.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { forEachInstrDeep, type IrInstrCall } from "../src/ir/core/nodes.js";
import * as numberConversion from "../src/ir/runtime/number-conversion-callable.js";

let encoded: string;
let frozen: ReturnType<typeof prepareGetterProgram>;
let withSource: ReturnType<typeof prepareGetterProgram>;
beforeAll(() => {
  vi.stubEnv("JS2WASM_IR_GVN", "0");
  encoded = encodePreparedIrProgram(prepareGetterProgram(REALM_CALL_SOURCE));
  frozen = prepareGetterProgram(REALM_NO_SOURCE);
  withSource = prepareGetterProgram(REALM_CALL_SOURCE);
  vi.unstubAllEnvs();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});

/** A genuine prepared program with an object use and no source closures: its realm pack is deeply frozen. */
const genuine = () => deriveNativeRealmRequirements(frozen, frozen.runtime[0]!)!;

/** The same program with its function bodies copied into mutable data, as a caller could hand over. */
function mutable() {
  const original = decodePreparedIrProgram(encoded);
  const projection = {
    ...original.runtime[0]!,
    prepared: { ...original.runtime[0]!.prepared, functions: structuredClone(original.runtime[0]!.prepared.functions) },
  };
  const program = {
    ...original,
    ir: { ...original.ir, functions: structuredClone(original.ir.functions) },
    runtime: [projection],
  };
  return deriveNativeRealmRequirements(program, projection)!;
}

function firstCall(pack: ReturnType<typeof mutable>): IrInstrCall {
  let call: IrInstrCall | undefined;
  for (const fn of pack.projection.prepared.functions)
    for (const block of fn.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (node) => {
          if (node.kind === "call") call ??= node;
        });
  if (!call) throw Error("actual call demand missing");
  return call;
}

describe("#7397 realm requirements: one currentness check per unchangeable pack", () => {
  it("settles a genuine pack: repeated checks do not re-derive the description", () => {
    const pack = genuine();
    expect(isImmutablePreparedIrValue(pack)).toBe(true);
    const derive = vi.spyOn(numberConversion, "irNumberConversionCallableDeclaration");
    for (let count = 0; count < 5; count++) assertNativeRealmRequirementsCurrent(pack);
    expect(derive).not.toHaveBeenCalled();
  });

  it("re-checks a pack whose input can still change, and refuses a mutation after repeated passes", () => {
    const pack = mutable();
    expect(isImmutablePreparedIrValue(pack)).toBe(false);
    for (let count = 0; count < 3; count++) assertNativeRealmRequirementsCurrent(pack);
    (firstCall(pack).target as { name: string }).name += "-stale";
    expect(() => assertNativeRealmRequirementsCurrent(pack)).toThrow();
  });

  it("re-checks a settled pack after a shared prototype gains a field", () => {
    const pack = genuine();
    assertNativeRealmRequirementsCurrent(pack);
    const derive = vi.spyOn(numberConversion, "irNumberConversionCallableDeclaration");
    const prototype = Object.prototype as { realmProbe7397?: unknown };
    prototype.realmProbe7397 = 1;
    try {
      assertNativeRealmRequirementsCurrent(pack);
      expect(derive).toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(prototype, "realmProbe7397");
    }
  });

  it("re-checks at every use a pack whose source-closure requirements are not deeply frozen", () => {
    // `planNativeSourceClosureRequirements` issues its arrays unfrozen; such a pack never settles (fails closed).
    const pack = deriveNativeRealmRequirements(withSource, withSource.runtime[0]!)!;
    expect(pack.source).toBeDefined();
    expect(isImmutablePreparedIrValue(pack)).toBe(false);
    assertNativeRealmRequirementsCurrent(pack);
    const derive = vi.spyOn(numberConversion, "irNumberConversionCallableDeclaration");
    assertNativeRealmRequirementsCurrent(pack);
    expect(derive).toHaveBeenCalled();
  });

  it("still refuses a copied or detached pack before any settled verdict", () => {
    const pack = genuine();
    assertNativeRealmRequirementsCurrent(pack);
    expect(() => assertNativeRealmRequirementsCurrent({ ...pack })).toThrow(/unissued, copied or detached/);
  });
});
