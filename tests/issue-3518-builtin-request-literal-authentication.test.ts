// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { createVectorBaseType } from "../src/runtime/wasmgc/values/vector-grow-store.js";
import {
  declareNativeArgumentVectorResources,
  reserveNativeArgumentVectorResources,
} from "../src/backend/wasmgc/resources/native-argument-vectors.js";
import {
  nativeStringLiteralReservationInventory,
  requireNativeStringLiteral,
  reserveNativeStringLiteralResources,
  type NativeStringLiteralRequirements,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  declareNativeBuiltinFunctionRequests,
  declareNativePublicBuiltinFunctionRequests,
  requireNativeBuiltinFunctionRequestIssuer,
  NATIVE_BUILTIN_FUNCTION_LITERALS,
} from "../src/backend/wasmgc/resources/native-builtin-function-requests.js";
import {
  deriveNativeRealmRequirements,
  type NativeRealmRequirements,
} from "../src/ir/program/native-realm-requirements.js";
import { planNativeRealmLiterals } from "../src/backend/wasmgc/program/native-realm-literals.js";
import { builtinRequirements } from "./helpers/native-builtin-functions.js";
import { prepareGetterProgram } from "./helpers/native-getter-invocation-fixture.js";

type Mode = "bootstrap" | "public";
type Encoding = "wtf16" | "utf8-guaranteed";
let realm: NativeRealmRequirements;
let realmLiterals: NativeStringLiteralRequirements["literals"];
beforeAll(() => {
  const program = prepareGetterProgram(
    "export function run(): number { const value = Object.create(null); return 7; }",
  );
  const requirements = deriveNativeRealmRequirements(program, program.runtime[0]!);
  if (!requirements) throw Error("genuine Object.create(null) program did not issue realm requirements");
  realm = requirements;
  realmLiterals = planNativeRealmLiterals(realm, true).literals;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});

function vectors(tx: PhysicalModuleReservations, key: string) {
  const vectorBase = tx.reserveType(key + ":base", createVectorBaseType());
  const argumentPlan = declareNativeArgumentVectorResources({ key }, { vectorBaseKey: vectorBase.key });
  const arguments_ = reserveNativeArgumentVectorResources(tx, { key }, { vectorBase }, argumentPlan);
  return { arguments: arguments_, argumentPlan };
}
function fixture(literals: NativeStringLiteralRequirements["literals"] = realmLiterals) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const strings = reserveNativeStringLiteralResources(tx, { key: "strings", utf8Storage: true, literals });
  const dependencies = { ...vectors(tx, "arguments"), strings };
  return { module, tx, strings, dependencies, requirements: builtinRequirements() };
}
type Fixture = ReturnType<typeof fixture>;
function declare(f: Fixture, mode: Mode) {
  return mode === "bootstrap"
    ? declareNativeBuiltinFunctionRequests(f.tx, f.requirements, f.dependencies)
    : declareNativePublicBuiltinFunctionRequests(f.tx, realm, f.dependencies);
}
const population = (f: Fixture) => [
  f.module.types.length,
  f.module.functions.length,
  f.module.globals.length,
  f.module.tags.length,
  f.module.imports.length,
];

describe.each([
  { mode: "bootstrap" as const, lists: 1, requestCount: 4 },
  { mode: "public" as const, lists: 2, requestCount: 88 },
])("$mode builtin request literal authentication", ({ mode, lists, requestCount }) => {
  it("freshly audits the String family once per list on declaration and every repeated requirement", () => {
    const f = fixture(),
      types = new Set(f.strings.types);
    // These observers call the original ledger methods; no owner or inventory is mocked.
    const reserving = vi.spyOn(f.tx, "assertTypeReservation");
    const expected = Array.from({ length: lists }, () => [...f.strings.types]).flat();
    const checkedTypes = () => reserving.mock.calls.map(([token]) => token).filter((token) => types.has(token));
    const before = population(f),
      pack = declare(f, mode);
    expect(pack.requests).toHaveLength(requestCount);
    expect(checkedTypes()).toEqual(expected);
    for (let repeat = 0; repeat < 2; repeat++) {
      reserving.mockClear();
      expect(requireNativeBuiltinFunctionRequestIssuer(f.tx, pack)).toBe(pack);
      expect(checkedTypes()).toEqual(expected);
    }
    f.tx.freezeReservations();
    const filling = vi.spyOn(f.tx, "physicalIndices");
    for (let repeat = 0; repeat < 2; repeat++) {
      filling.mockClear();
      expect(requireNativeBuiltinFunctionRequestIssuer(f.tx, pack)).toBe(pack);
      expect(filling.mock.calls).toHaveLength(lists);
      for (const [tokens] of filling.mock.calls) expect(tokens).toBe(f.strings.types);
    }
    expect(population(f)).toEqual(before);
  });

  it.each<Encoding>(["wtf16", "utf8-guaranteed"])(
    "accepts ordered duplicate texts with %s first and preserves the declared requests",
    (first) => {
      const second: Encoding = first === "wtf16" ? "utf8-guaranteed" : "wtf16";
      const texts = [...new Set(realmLiterals.map((row) => row.value))];
      const ordered = (leading: Encoding, trailing: Encoding) =>
        texts.flatMap((value) => [
          { value, encoding: leading },
          { value, encoding: trailing },
          { value, encoding: leading },
        ]);
      const f = fixture(ordered(first, second)),
        inventory = nativeStringLiteralReservationInventory(f.tx, f.strings);
      expect(Object.isFrozen(inventory.requests)).toBe(true);
      expect(inventory.requests).toHaveLength(texts.length * 3);
      for (let index = 0; index < texts.length; index++) {
        const text = texts[index]!,
          binding = requireNativeStringLiteral(f.tx, f.strings, text);
        expect(binding).toBe(inventory.requests[index * 3]!.binding);
        expect(binding).toBe(f.strings.literals[index * 3]);
        expect(binding).toBe(inventory.requests[index * 3 + 2]!.binding);
        expect(binding).not.toBe(inventory.requests[index * 3 + 1]!.binding);
        expect(binding).toBe(requireNativeStringLiteral(f.tx, f.strings, text, first));
        if (binding.kind !== "global") throw Error("short catalog literal unexpectedly became callable");
        expect(binding.global.object.type).toEqual({
          kind: "ref",
          typeIdx: first === "wtf16" ? f.strings.layout.nativeStrTypeIdx : f.strings.layout.utf8StrTypeIdx,
        });
      }
      const pack = declare(f, mode),
        reverse = declare(fixture(ordered(second, first)), mode);
      expect(pack.requests).toHaveLength(requestCount);
      expect(pack.requests).toEqual(reverse.requests);
      expect(pack.referenceTypes[0]).toBe(f.dependencies.arguments.carrier);
      expect(requireNativeBuiltinFunctionRequestIssuer(f.tx, pack)).toBe(pack);
    },
  );

  it("refuses a missing common literal with the original diagnostic and no declaration allocation", () => {
    const missing = NATIVE_BUILTIN_FUNCTION_LITERALS.at(-1)!;
    const f = fixture(realmLiterals.filter((row) => row.value !== missing)),
      before = population(f);
    expect(() => declare(f, mode)).toThrow(`native strings: missing literal ${JSON.stringify(missing)}`);
    expect(population(f)).toEqual(before);
    expect(f.tx.state).toBe("reserving");
  });

  it.each(["reserving", "filling"] as const)("rejects a warmed String descriptor mutation in %s", (phase) => {
    const f = fixture(),
      pack = declare(f, mode);
    if (phase === "filling") f.tx.freezeReservations();
    expect(requireNativeBuiltinFunctionRequestIssuer(f.tx, pack)).toBe(pack);
    const token = f.strings.types[0]!,
      array = token.object;
    if (array.kind !== "array") throw Error("String data prerequisite is not the expected genuine array");
    array.mutable = !array.mutable;
    expect(() => requireNativeBuiltinFunctionRequestIssuer(f.tx, pack)).toThrow(
      `physical module reservations: altered type descriptor ${token.key}`,
    );
    expect(f.tx.state).toBe("failed");
  });

  it("refuses cloned or foreign String owners after a genuine positive declaration", () => {
    const f = fixture(),
      foreign = fixture(),
      before = population(f);
    expect(requireNativeBuiltinFunctionRequestIssuer(f.tx, declare(f, mode)).requests).toHaveLength(requestCount);
    for (const strings of [{ ...f.strings }, foreign.strings]) {
      f.dependencies.strings = strings;
      expect(() => declare(f, mode)).toThrow("native strings: foreign or forged resource owner");
    }
    expect(population(f)).toEqual(before);
  });

  it("rejects a warmed issuer's replacement by a genuine same-ledger String owner", () => {
    const f = fixture(),
      alternate = reserveNativeStringLiteralResources(f.tx, {
        key: "alternate-strings",
        utf8Storage: true,
        literals: realmLiterals,
      }),
      pack = declare(f, mode);
    expect(requireNativeBuiltinFunctionRequestIssuer(f.tx, pack)).toBe(pack);
    expect(nativeStringLiteralReservationInventory(f.tx, alternate).requests.length).toBeGreaterThan(0);
    f.dependencies.strings = alternate;
    expect(() => requireNativeBuiltinFunctionRequestIssuer(f.tx, pack)).toThrow(
      /changed (public )?dependency identities/,
    );
  });

  it("keeps exact argument-vector roles after warming a valid issuer", () => {
    const f = fixture(),
      alternate = vectors(f.tx, "alternate-arguments"),
      pack = declare(f, mode);
    expect(requireNativeBuiltinFunctionRequestIssuer(f.tx, pack)).toBe(pack);
    Object.assign(f.dependencies, alternate);
    expect(() => requireNativeBuiltinFunctionRequestIssuer(f.tx, pack)).toThrow(
      /changed (public )?dependency identities/,
    );
  });

  it("rejects dependency accessors before reading them on declaration and warmed currentness", () => {
    const f = fixture(),
      pack = declare(f, mode),
      getter = vi.fn(() => f.strings);
    expect(requireNativeBuiltinFunctionRequestIssuer(f.tx, pack)).toBe(pack);
    Object.defineProperty(f.dependencies, "strings", { enumerable: true, get: getter });
    expect(() => declare(f, mode)).toThrow("non-data input record");
    expect(() => requireNativeBuiltinFunctionRequestIssuer(f.tx, pack)).toThrow("non-data input record");
    expect(getter).not.toHaveBeenCalled();
  });

  it("never accepts a copied issuer or the original issuer in a foreign ledger", () => {
    const f = fixture(),
      pack = declare(f, mode),
      foreign = fixture();
    expect(requireNativeBuiltinFunctionRequestIssuer(f.tx, pack)).toBe(pack);
    expect(() => requireNativeBuiltinFunctionRequestIssuer(f.tx, { ...pack })).toThrow(
      "foreign or copied request issuer family",
    );
    expect(() => requireNativeBuiltinFunctionRequestIssuer(foreign.tx, pack)).toThrow(
      /foreign or copied (public )?request issuer/,
    );
  });
});

it("rejects a missing public catalog name after all common literal prerequisites pass", () => {
  const missing = "assign";
  expect(realm.description.catalog.intrinsics.some((row) => row.callable?.initialName === missing)).toBe(true);
  expect(NATIVE_BUILTIN_FUNCTION_LITERALS).not.toContain(missing);
  const f = fixture(realmLiterals.filter((row) => row.value !== missing)),
    before = population(f);
  expect(requireNativeBuiltinFunctionRequestIssuer(f.tx, declare(f, "bootstrap")).requests).toHaveLength(4);
  expect(() => declare(f, "public")).toThrow(`native strings: missing literal ${JSON.stringify(missing)}`);
  expect(population(f)).toEqual(before);
});

it("retains original requirement currentness after repeated successful literal authentication", () => {
  const f = fixture(),
    pack = declare(f, "bootstrap");
  expect(requireNativeBuiltinFunctionRequestIssuer(f.tx, pack)).toBe(pack);
  Object.defineProperty(f.requirements, "key", { value: "changed-bootstrap-key" });
  expect(() => requireNativeBuiltinFunctionRequestIssuer(f.tx, pack)).toThrow("stale builtin requirements");
});
