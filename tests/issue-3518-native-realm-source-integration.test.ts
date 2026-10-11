// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import {
  REALM_CALL_SOURCE,
  REALM_THROW_SOURCE,
  realmFoundation,
  realmSource,
  realmFixture,
  realmRuntime,
  fillRealmFixture,
  prepareBackendRealmProgram,
} from "./helpers/native-realm-source-integration.js";
import { prepareGetterProgram, GETTER_SOURCE } from "./helpers/native-getter-invocation-fixture.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptedPhysicalSetupPlan, acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
import { replayOptions, replayProgram } from "./helpers/ir-whole-program-replay.js";
import { nativeInvocationFunctions } from "../src/backend/wasmgc/resources/native-invocation.js";
import { nativeInvocationSubstrateReservationInventory } from "../src/backend/wasmgc/resources/native-invocation-substrate.js";
import {
  reserveNativeRealmKernel,
  nativeRealmReservationInventory,
  requireCompletedNativeRealmBootstrap,
  fillNativeRealmResources,
} from "../src/backend/wasmgc/program/native-realm.js";
import { beginNativeSourceClosureEmission } from "../src/ir/program-native-invocation.js";
import { requireNativeSourceClosureTypes } from "../src/backend/wasmgc/resources/native-source-closures.js";
import { declareNativeBuiltinFunctionRequests } from "../src/backend/wasmgc/resources/native-builtin-function-requests.js";
import {
  reserveNativeStringLiteralTypes,
  requireNativeStringLiteral,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import { reserveNativeVectorTypes } from "../src/backend/wasmgc/resources/native-vectors.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { realmInput } from "./helpers/native-realm-source-integration.js";
import { fillNativeStringValueResources } from "../src/backend/wasmgc/program/native-string-values.js";
import { nativeBuiltinFunctionReservationInventory } from "../src/backend/wasmgc/resources/native-builtin-functions.js";

let callProgram: string, noSourceProgram: string, getterProgram: string, throwProgram: string;
beforeAll(() => {
  vi.stubEnv("JS2WASM_IR_GVN", "0");
  callProgram = encodePreparedIrProgram(prepareGetterProgram(REALM_CALL_SOURCE));
  vi.unstubAllEnvs();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await setImmediate();
});
const source = () => decodePreparedIrProgram(callProgram);
const noSource = () =>
  decodePreparedIrProgram((noSourceProgram ??= encodePreparedIrProgram(prepareBackendRealmProgram())));
const population = (f: { module: ReturnType<typeof createEmptyModule> }) => [
  f.module.types.length,
  f.module.functions.length,
  f.module.globals.length,
  f.module.tags.length,
];
function shared(f: ReturnType<typeof realmFoundation>) {
  const types = f.foundation.stringTypes!;
  return {
    vectors: f.foundation.vectorTypes,
    vectorPlan: f.vectorPlan,
    strings: { types, key: types.key, utf8Storage: types.utf8Storage },
  };
}

describe("production consumer with one genuine source/builtin closure population", () => {
  for (const decoded of [false, true])
    for (const utf8Storage of [false, true])
      it(`executes actual captured call/apply through public emission, decoded=${decoded}, utf8=${utf8Storage}`, async () => {
        vi.stubEnv("JS2WASM_IR_GVN", "0");
        const program = decoded ? source() : prepareGetterProgram(REALM_CALL_SOURCE);
        const outcome = await replayProgram(program, { ...replayOptions("wasmgc", "standalone"), utf8Storage });
        if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
        const plan = acceptedPhysicalSetupPlan(outcome.run.accepted),
          module = outcome.run.emitted.module;
        expect(plan.nativeRealm?.completionScope).toBe("native-realm-bootstrap");
        expect(plan.nativeRealm!.sourceUnits).toHaveLength(1);
        expect(plan.sourceClosures!.shapes.some((row) => row.captures.length === 1)).toBe(true);
        expect(module.imports).toEqual([]);
        expect(module.functions.filter((row) => row.name === "__objvec_new")).toHaveLength(1);
        expect(module.functions.filter((row) => row.name === "__objvec_push")).toHaveLength(1);
        expect(module.functions.filter((row) => row.name === "__new_TypeError")).toHaveLength(1);
        expect(module.functions.some((row) => row.name === "__call_fn_method_2")).toBe(true);
        expect((outcome.run.exports.run as () => number)()).toBe(94);
        expect((outcome.run.exports.run as () => number)()).toBe(94);
        expect(plan.nativeRealm!.unavailable.some((row) => row.role === "public Number(value) provider")).toBe(true);
      }, 120000);
  it("decodes and executes in a fresh process with zero loaded TypeScript/frontend modules", () => {
    mkdirSync(resolve(".tmp/realm-source/children"), { recursive: true });
    const directory = mkdtempSync(resolve(".tmp/realm-source/children/run-"));
    const encoded = join(directory, "program.json"),
      expected = join(directory, "oracle.json");
    writeFileSync(encoded, callProgram);
    writeFileSync(
      expected,
      JSON.stringify({
        targets: [{ backend: "wasmgc", target: "standalone" }],
        calls: [{ export: "run", args: [], expected: 94 }],
      }),
    );
    const args = [
      "--max-old-space-size=4096",
      "--import",
      "tsx",
      "scripts/ir-whole-program-replay.mjs",
      encoded,
      expected,
    ];
    const child = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(
      join(directory, "replay.json"),
      JSON.stringify({ args, status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr }),
    );
    if (child.error) throw child.error;
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr + child.stdout).toBe(0);
    const report = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
    expect(report.ok).toBe(true);
    expect(report.reencodedIdentical).toBe(true);
    expect(report.loadedModuleCount).toBeGreaterThan(0);
    expect(report.typescriptModules).toEqual([]);
    expect(report.frontendModules).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.targets["wasmgc:standalone"].rows).toHaveLength(1);
    expect(report.targets["wasmgc:standalone"].rows[0].match).toBe(true);
  }, 120000);
  it("keeps the constructed typed-IR ordinary-object provider physically refused despite selected bootstrap", () => {
    const accepted = acceptPreparedIrProgram(noSource(), replayOptions("wasmgc", "standalone"));
    expect(accepted.kind).not.toBe("accepted");
    expect(JSON.stringify(accepted)).toMatch(/js\.object\.create-null/);
  });
});

describe("actual no-source bootstrap and shared source controls", () => {
  for (const utf8 of [false, true])
    for (const displaced of [false, true])
      it(`executes backend-only typed-IR no-source bootstrap, utf8=${utf8}, displaced/decoded=${displaced}`, () => {
        const f = realmFixture(displaced ? noSource() : prepareBackendRealmProgram(), utf8, displaced),
          { runtime: r, compiled, inventory } = realmRuntime(f);
        expect(WebAssembly.Module.imports(compiled)).toEqual([]);
        expect(f.requirements.source).toBeUndefined();
        expect(f.input.plan.mode).toBe("realm-bootstrap");
        expect(inventory.sourceTypes).toBeUndefined();
        expect(inventory.closurePlan.requirements.requests).toEqual(f.realm.requests.requests);
        expect(inventory.closures.root.object.kind).toBe("struct");
        if (inventory.closures.root.object.kind !== "struct") throw Error("root missing");
        expect(inventory.closures.root.object.fields).toHaveLength(3);
        expect(f.realm.substrate.arguments.carrier.typeIndex).toBeLessThan(inventory.closures.root.typeIndex);
        const fp = r.functionPrototype(),
          thrower = r.throwTypeError();
        expect(r.state.value).toBe(2);
        expect(r.realmReady.value).toBe(0);
        expect(Object.is(r.functionPrototype(), fp)).toBe(true);
        expect(Object.is(r.getPrototypeOf(fp), r.objectPrototype())).toBe(true);
        expect(Object.is(r.getPrototypeOf(thrower), fp)).toBe(true);
        expect(r.match(fp)).toBe(1);
        expect(r.match(thrower)).toBe(2);
        expect(Object.is(r.method0(fp, null), r.undefinedValue())).toBe(true);
        expect(Object.is(r.method3(fp, 17, null, 1, 2), r.undefinedValue())).toBe(true);
        expect(r.isUtf8(r.key())).toBe(Number(utf8));
        const binding = requireNativeStringLiteral(f.tx, f.strings.strings, "name");
        expect(binding.kind).toBe("global");
        if (binding.kind !== "global") throw Error("actual short key lost literal global");
        expect(binding.global.object.type).toEqual({
          kind: "ref",
          typeIdx: utf8 ? f.strings.strings.layout.utf8StrTypeIdx : f.strings.strings.layout.nativeStrTypeIdx,
        });
        expect(inventory.functions.length).toBeGreaterThan(50);
        expect(new Set(inventory.functions).size).toBe(inventory.functions.length);
        expect(requireCompletedNativeRealmBootstrap(f.tx, f.realm)).toBe(f.realm);
        const other = new WebAssembly.Instance(compiled).exports as unknown as typeof r;
        expect(Object.is(other.functionPrototype(), fp)).toBe(false);
        expect(other.realmReady.value).toBe(0);
      });
  for (const utf8 of [false, true])
    it(`joins actual captured getter and restores shared invocation state, utf8=${utf8}`, () => {
      const f = realmFixture(
        decodePreparedIrProgram((getterProgram ??= encodePreparedIrProgram(prepareGetterProgram(GETTER_SOURCE)))),
        utf8,
        true,
      );
      const inventory = nativeRealmReservationInventory(f.tx, f.realm),
        substrate = nativeInvocationSubstrateReservationInventory(f.tx, f.realm.substrate);
      expect(inventory.closures).toBe(f.source!.types.closures);
      expect(
        inventory.closurePlan.requirements.requests
          .slice(0, f.requirements.source!.signatures.length)
          .map((row) => row.id),
      ).toEqual(f.requirements.source!.signatures.map((row) => row.id));
      expect(f.invocation!.arguments).toBe(f.realm.substrate.arguments);
      expect(f.invocation!.errors).toBe(f.realm.substrate.errors);
      const owned = nativeInvocationFunctions(f.tx, f.invocation!);
      expect(substrate.functions).toHaveLength(3);
      for (const token of substrate.functions) {
        expect(owned.includes(token)).toBe(false);
        expect(inventory.functions.filter((row) => row === token)).toHaveLength(1);
      }
      expect(f.requirements.access.getters).toHaveLength(1);
      const { runtime: r } = realmRuntime(f, "number"),
        captured = r.make(31),
        receiver = { actual: "receiver" },
        prior = { saved: "this" },
        extras = r.newVector();
      r.currentThis.value = prior;
      r.argc.value = 81;
      r.extras.value = extras;
      expect(r.get(receiver, captured)).toBe(35);
      expect(r.get(null, r.make(100))).toBe(104);
      expect(r.match(captured)).toBe(0);
      expect(r.currentThis.value).toBe(prior);
      expect(r.argc.value).toBe(81);
      expect(Object.is(r.extras.value, extras)).toBe(true);
      expect(r.realmReady.value).toBe(0);
    });
  it("restores source invocation state while rethrowing the actual captured source payload/tag", () => {
    const f = realmFixture(
        decodePreparedIrProgram((throwProgram ??= encodePreparedIrProgram(prepareGetterProgram(REALM_THROW_SOURCE)))),
      ),
      { runtime: r } = realmRuntime(f, "throw");
    const message = r.key(),
      getter = r.make(message),
      prior = { old: "this" },
      extras = r.newVector();
    r.currentThis.value = prior;
    r.argc.value = 42;
    r.extras.value = extras;
    let caught: unknown;
    try {
      r.get({ receiver: true }, getter);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WebAssembly.Exception);
    expect((caught as WebAssembly.Exception).is(r.exception)).toBe(true);
    expect(Object.is((caught as WebAssembly.Exception).getArg(r.exception, 0), message)).toBe(true);
    expect(r.currentThis.value).toBe(prior);
    expect(r.argc.value).toBe(42);
    expect(Object.is(r.extras.value, extras)).toBe(true);
  });
});

describe("realm join ownership and phase completion", () => {
  it("rejects copied and foreign realm owners", () => {
    const f = realmFixture(noSource());
    expect(() => nativeRealmReservationInventory(f.tx, { ...f.realm })).toThrow(/foreign or copied/);
    expect(() => nativeRealmReservationInventory(new PhysicalModuleReservations(createEmptyModule()), f.realm)).toThrow(
      /foreign or copied/,
    );
    expect(() => requireCompletedNativeRealmBootstrap(f.tx, f.realm)).toThrow(/incomplete/);
  });
  it("requires the exact retained builtin issuer, not an equal request declaration", () => {
    const f = realmFoundation(source()),
      d = {
        arguments: f.realm.substrate.arguments,
        argumentPlan: f.realm.substrate.argumentPlan,
        strings: f.strings.strings,
      };
    const alternate = declareNativeBuiltinFunctionRequests(f.tx, f.realm.requests.requirements, d);
    expect(alternate.requests).toEqual(f.realm.requests.requests);
    const emitted = beginNativeSourceClosureEmission(f.tx, f.requirements.source!, shared(f), alternate),
      before = population(f);
    expect(() => reserveNativeRealmKernel(f.tx, f.realm, emitted.types)).toThrow(
      /builtin.*issuer|builtin.*identity|builtin.*foreign|builtin.*substitut/,
    );
    expect(population(f)).toEqual(before);
  });
  it.each(["strings", "vectors"] as const)(
    "refuses a genuine alternate same-ledger %s carrier at the source join",
    (role) => {
      const f = realmFoundation(source()),
        carriers = shared(f);
      if (role === "strings") {
        const types = reserveNativeStringLiteralTypes(f.tx, "alternate:strings", false);
        carriers.strings = { types, key: types.key, utf8Storage: types.utf8Storage };
      } else {
        const alternate = realmInput(prepareGetterProgram(REALM_CALL_SOURCE, false, "./alternate.ts"));
        carriers.vectors = reserveNativeVectorTypes(f.tx, alternate.vectorPlan);
        carriers.vectorPlan = alternate.vectorPlan;
      }
      const emitted = beginNativeSourceClosureEmission(f.tx, f.requirements.source!, carriers, f.realm.requests),
        before = population(f);
      expect(() => reserveNativeRealmKernel(f.tx, f.realm, emitted.types)).toThrow(/shared|carrier/);
      expect(population(f)).toEqual(before);
    },
  );
  it.each(["accessor", "hidden", "extra"] as const)(
    "refuses %s expected-carrier records without running getters",
    (kind) => {
      const f = realmSource(realmFoundation(source())),
        expected = shared(f);
      let calls = 0;
      if (kind === "accessor")
        Object.defineProperty(expected, "vectors", {
          enumerable: true,
          get: () => {
            calls++;
            return f.foundation.vectorTypes;
          },
        });
      if (kind === "hidden")
        Object.defineProperty(expected, "vectors", { value: f.foundation.vectorTypes, enumerable: false });
      if (kind === "extra") Object.assign(expected, { surplus: true });
      expect(() =>
        requireNativeSourceClosureTypes(f.tx, f.source!.types, f.requirements.source!, f.realm.requests, expected),
      ).toThrow(/data|role|field/);
      expect(calls).toBe(0);
    },
  );
  it("permits one canonical fill and rejects duplicate reservation, fill and post-fill mutation", () => {
    const f = realmFixture(noSource());
    expect(() => reserveNativeRealmKernel(f.tx, f.realm)).toThrow(/duplicate/);
    fillRealmFixture(f);
    expect(() => fillNativeRealmResources(f.tx, f.realm)).toThrow(/duplicate/);
    f.realm.substrate.arguments.push.object.body.push({ op: "nop" });
    expect(() => requireCompletedNativeRealmBootstrap(f.tx, f.realm)).toThrow(/altered|canonical/);
  });
  it("retains earlier owners but cannot complete after a later owner key collision", () => {
    const f = realmFoundation(noSource()),
      beforeFoundation = population(f);
    f.tx.reserveFunction(f.requirements.description.key + ":equality:equals", "collision", { params: [], results: [] });
    const beforeAttempt = population(f);
    expect(() => reserveNativeRealmKernel(f.tx, f.realm)).toThrow(/reserved|duplicate|collision/);
    expect(population(f)).toEqual(beforeAttempt);
    expect(beforeFoundation[0]).toBeGreaterThan(0);
    expect(() => nativeRealmReservationInventory(f.tx, f.realm)).toThrow(/failed composition/);
    expect(() => requireCompletedNativeRealmBootstrap(f.tx, f.realm)).toThrow(/failed composition/);
  });
  it("rejects a caller-filled shared vector before it can certify realm completion", () => {
    const f = realmFixture(noSource());
    f.tx.freezeReservations();
    fillNativeStringValueResources(f.tx, f.strings);
    f.tx.fillFunction(f.realm.substrate.arguments.push, { locals: [], body: [] });
    expect(() => fillNativeRealmResources(f.tx, f.realm)).toThrow(/duplicate function fill/);
    expect(() => requireCompletedNativeRealmBootstrap(f.tx, f.realm)).toThrow(/failed composition/);
  });
  it("preflights every final kernel key after earlier dependency owners have reserved", () => {
    const reference = realmFixture(noSource());
    const keys = nativeBuiltinFunctionReservationInventory(reference.tx, reference.kernel).keys;
    const last = keys.at(-1)!;
    const f = realmFoundation(noSource());
    f.tx.reserveFunction(last, "late-kernel-collision", { params: [], results: [] });
    const before = population(f);
    // The real ledger becomes failed on collision. Observe actual reservation
    // calls instead of attempting another reserving-phase query afterward.
    const reservations = [
      vi.spyOn(f.tx, "reserveType"),
      vi.spyOn(f.tx, "reserveFunction"),
      vi.spyOn(f.tx, "reserveGlobal"),
      vi.spyOn(f.tx, "reserveTag"),
    ];
    let beforeKernel: ReturnType<typeof population> | undefined;
    const checkKeys = f.tx.assertReservationKeysAvailable.bind(f.tx);
    vi.spyOn(f.tx, "assertReservationKeysAvailable").mockImplementation((candidateKeys) => {
      if (candidateKeys.length === keys.length && candidateKeys.every((key, index) => key === keys[index]))
        beforeKernel = population(f);
      checkKeys(candidateKeys);
    });
    expect(() => reserveNativeRealmKernel(f.tx, f.realm)).toThrow(/duplicate planned resource key/);
    expect(f.module.functions.length).toBeGreaterThan(before[1]!);
    expect(beforeKernel).toBeDefined();
    expect(population(f)).toEqual(beforeKernel);
    expect(f.tx.state).toBe("failed");
    const attemptedKeys = reservations.flatMap((spy) => spy.mock.calls.map(([key]) => key));
    expect(attemptedKeys.length).toBeGreaterThan(0);
    expect(attemptedKeys.filter((key) => keys.includes(key))).toEqual([]);
    expect(() => requireCompletedNativeRealmBootstrap(f.tx, f.realm)).toThrow(/failed composition/);
  });
});
