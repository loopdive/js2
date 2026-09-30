// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import { emitBinary } from "../src/emit/binary.js";
import {
  prepareGetterProgram,
  freezeGetterInvocation,
  fillGetterInvocationDependencies,
} from "./helpers/native-getter-invocation-fixture.js";
import {
  substrateFoundation,
  substrateFixture,
  substrateRuntime,
  sourceSubstrateBase,
  sourceSubstrateFixture,
  sourceSubstrateRuntime,
  throwingGetterSubstrateRuntime,
  SUBSTRATE_SOURCE,
} from "./helpers/native-invocation-substrate.js";
import {
  reserveNativeInvocationSubstrateResources,
  requireNativeInvocationSubstrateReservations,
  fillNativeInvocationSubstrateResources,
  requireCompletedNativeInvocationSubstrate,
  nativeInvocationSubstrateReservationInventory,
  type NativeInvocationSubstrateDependencies,
  type NativeInvocationSubstrateRequirements,
} from "../src/backend/wasmgc/resources/native-invocation-substrate.js";
import {
  reserveNativeInvocationResources,
  requireNativeInvocationReservations,
  fillNativeInvocationResources,
  nativeInvocationFunctions,
} from "../src/backend/wasmgc/resources/native-invocation.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import { reserveNativeVectorTypes } from "../src/backend/wasmgc/resources/native-vectors.js";
import * as vectorResources from "../src/backend/wasmgc/resources/native-argument-vectors.js";
import {
  buildArgumentVectorNewBody,
  buildArgumentVectorPushBody,
  buildArgumentVectorPushLocals,
} from "../src/runtime/wasmgc/values/argument-vector-bodies.js";
import { fillNativeErrorResources } from "../src/backend/wasmgc/resources/native-errors.js";

let scalar: PreparedIrProgram, source: PreparedIrProgram;
beforeAll(() => {
  vi.stubEnv("JS2WASM_IR_GVN", "0");
  scalar = prepareGetterProgram();
  source = prepareGetterProgram(SUBSTRATE_SOURCE);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});
afterAll(() => vi.unstubAllEnvs());

function reserve(f: ReturnType<typeof substrateFoundation>) {
  return reserveNativeInvocationSubstrateResources(f.tx, f.requirements, f.dependencies, f.plan);
}
function unchanged(module: unknown, run: () => void) {
  const before = structuredClone(module);
  run();
  expect(module).toStrictEqual(before);
}
function complete(f: ReturnType<typeof substrateFixture>) {
  f.tx.freezeReservations();
  fillNativeStringLiteralResources(f.tx, f.strings);
  fillNativeInvocationSubstrateResources(f.tx, f.pack);
  expect(requireCompletedNativeInvocationSubstrate(f.tx, f.pack)).toBe(f.pack);
}

describe("genuine shared invocation substrate before source closure reservation", () => {
  it.each([false, true])(
    "executes nonempty native vector growth and TypeError construction, displaced=%s",
    (displaced) => {
      const f = substrateFixture(scalar, displaced);
      expect(f.vectors.base).toBeUndefined();
      const inventory = nativeInvocationSubstrateReservationInventory(f.tx, f.pack);
      expect(inventory.completionScope).toBe("invocation-substrate");
      expect(inventory.types).toHaveLength(4);
      expect(inventory.functions).toEqual([
        f.pack.arguments.newVector,
        f.pack.arguments.push,
        f.pack.errors.newTypeError,
      ]);
      expect(inventory.keys).toEqual([
        f.requirements.key + ":vector-base",
        f.requirements.key + ":arguments:array",
        f.requirements.key + ":arguments:carrier",
        f.requirements.key + ":arguments:new",
        f.requirements.key + ":arguments:push",
        f.requirements.key + ":errors:type",
        f.requirements.key + ":errors:new-TypeError",
      ]);
      if (displaced)
        expect(f.pack.arguments.array.typeIndex).toBeGreaterThan(f.module.types.indexOf(f.pack.arguments.array.object));
      const runtime = substrateRuntime(f),
        vector = runtime.newVector();
      const operands: unknown[] = [
        null,
        undefined,
        0,
        false,
        "x",
        ...Array.from({ length: 12 }, (_, index) => ({ index })),
      ];
      expect(runtime.length(vector)).toBe(0);
      expect(runtime.capacity(vector)).toBe(8);
      for (const operand of operands) runtime.push(vector, operand);
      expect(runtime.length(vector)).toBe(17);
      expect(runtime.capacity(vector)).toBe(32);
      operands.forEach((operand, index) => expect(Object.is(runtime.at(vector, index), operand)).toBe(true));
      const message = { message: "actual external identity" },
        error = runtime.newTypeError(message);
      expect(runtime.errorTag(error)).toBe(-11);
      expect(Object.is(runtime.errorMessage(error), message)).toBe(true);
      expect(Object.is(runtime.errorName(error), runtime.typeErrorName())).toBe(true);
      expect(Object.is(error, runtime.newTypeError(message))).toBe(false);
      expect(f.module.imports).toEqual([]);
      expect(f.module.functions.filter((fn) => fn.body.length > 0).length).toBeGreaterThanOrEqual(10);
    },
  );
  it("borrows an already-issued vector base without allocating another one", () => {
    const f = substrateFixture(source);
    expect(f.vectors.base).toBeDefined();
    expect(f.pack.arguments.vectorBase).toBe(f.vectors.base);
    expect(f.plan.ownedBaseKey).toBeUndefined();
    expect(nativeInvocationSubstrateReservationInventory(f.tx, f.pack).types).toHaveLength(3);
    const runtime = substrateRuntime(f),
      vector = runtime.newVector();
    runtime.push(vector, 37);
    expect(runtime.at(vector, 0)).toBe(37);
  });
  it("accepts an equal initial declaration-data copy and retains it for currentness", () => {
    const f = substrateFoundation(scalar),
      plan = structuredClone(f.plan);
    const pack = reserveNativeInvocationSubstrateResources(f.tx, f.requirements, f.dependencies, plan);
    expect(requireNativeInvocationSubstrateReservations(f.tx, pack, { ...f.dependencies })).toBe(pack);
    (plan.reservationKeys as string[]).push("not-issued");
    expect(() => requireNativeInvocationSubstrateReservations(f.tx, pack)).toThrow("changed declaration plan");
  });
  it("refuses copied capability packs and same-coordinate foreign ledgers", () => {
    const f = substrateFixture(scalar),
      other = substrateFixture(scalar);
    expect(requireNativeInvocationSubstrateReservations(f.tx, f.pack)).toBe(f.pack);
    expect(f.pack.arguments.array.typeIndex).toBe(other.pack.arguments.array.typeIndex);
    expect(() => requireNativeInvocationSubstrateReservations(f.tx, { ...f.pack })).toThrow(
      "foreign or copied substrate owner",
    );
    expect(() => requireNativeInvocationSubstrateReservations(other.tx, f.pack)).toThrow(
      "foreign or copied substrate owner",
    );
    expect(() => requireNativeInvocationSubstrateReservations(f.tx, other.pack)).toThrow(
      "foreign or copied substrate owner",
    );
  });
  it.each([null, false, 0, ""])(
    "rejects supplied malformed expected dependencies %j after a genuine positive",
    (input) => {
      const f = substrateFixture(scalar);
      expect(requireNativeInvocationSubstrateReservations(f.tx, f.pack, f.dependencies)).toBe(f.pack);
      expect(() =>
        requireNativeInvocationSubstrateReservations(
          f.tx,
          f.pack,
          input as unknown as NativeInvocationSubstrateDependencies,
        ),
      ).toThrow("plain data record required");
    },
  );
  it.each(["requirements", "vector plan", "strings", "vectors"] as const)(
    "detects retained %s substitution after a genuine positive",
    (mutation) => {
      const f = substrateFixture(scalar);
      expect(requireNativeInvocationSubstrateReservations(f.tx, f.pack)).toBe(f.pack);
      if (mutation === "requirements") f.requirements.key += ":changed";
      if (mutation === "vector plan") f.dependencies.vectorPlan = structuredClone(f.vectorPlan);
      if (mutation === "strings")
        f.dependencies.strings = reserveNativeStringLiteralResources(f.tx, {
          key: "other-strings",
          utf8Storage: false,
          literals: [{ value: "TypeError", encoding: "wtf16" }],
        });
      if (mutation === "vectors") {
        const otherPlan = structuredClone(f.vectorPlan); // no layouts: genuine distinct owner on this ledger
        f.dependencies.vectors = reserveNativeVectorTypes(f.tx, otherPlan);
        f.dependencies.vectorPlan = otherPlan;
      }
      expect(() => requireNativeInvocationSubstrateReservations(f.tx, f.pack)).toThrow(
        /stale substrate requirements|substituted vector plan|substituted dependency identity/,
      );
    },
  );
  it.each(["accessor", "hidden", "extra"] as const)(
    "rejects %s dependency fields without evaluation or allocation",
    (kind) => {
      const f = substrateFoundation(scalar),
        dependency = { ...f.dependencies },
        read = vi.fn(() => f.vectors);
      if (kind === "extra") Object.assign(dependency, { surprise: f.vectors });
      else
        Object.defineProperty(
          dependency,
          "vectors",
          kind === "accessor" ? { get: read, enumerable: true } : { value: f.vectors, enumerable: false },
        );
      unchanged(f.module, () =>
        expect(() => reserveNativeInvocationSubstrateResources(f.tx, f.requirements, dependency, f.plan)).toThrow(
          /non-data or hidden field|unknown data field/,
        ),
      );
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("rejects callable/coercing keys and accessor declarations before callbacks or allocation", () => {
    const f = substrateFoundation(scalar),
      callback = vi.fn(() => "invalid"),
      requirements = { key: { toString: callback } } as unknown as NativeInvocationSubstrateRequirements;
    unchanged(f.module, () =>
      expect(() => reserveNativeInvocationSubstrateResources(f.tx, requirements, f.dependencies, f.plan)).toThrow(
        "invalid declaration key",
      ),
    );
    const declaration = { ...f.plan };
    Object.defineProperty(declaration, "argumentPlan", { enumerable: true, get: callback });
    unchanged(f.module, () =>
      expect(() =>
        reserveNativeInvocationSubstrateResources(f.tx, f.requirements, f.dependencies, declaration),
      ).toThrow("non-data declaration field"),
    );
    expect(callback).not.toHaveBeenCalled();
  });
  it("rejects cross-owner expected roles and missing TypeError literal before allocation", () => {
    const f = substrateFixture(scalar),
      other = substrateFixture(scalar);
    expect(() => requireNativeInvocationSubstrateReservations(f.tx, f.pack, other.dependencies)).toThrow(
      "foreign expected dependencies",
    );
    const g = substrateFoundation(scalar);
    const strings = reserveNativeStringLiteralResources(g.tx, {
      key: "missing-name",
      utf8Storage: false,
      literals: [{ value: "", encoding: "wtf16" }],
    });
    unchanged(g.module, () =>
      expect(() =>
        reserveNativeInvocationSubstrateResources(g.tx, g.requirements, { ...g.dependencies, strings }, g.plan),
      ).toThrow(/unreserved|missing|not reserved/),
    );
  });
  it("preflights a last-key collision before any substrate allocation", () => {
    const f = substrateFoundation(scalar);
    f.tx.reserveGlobal(f.plan.reservationKeys.at(-1)!, "collision", { kind: "i32" }, false);
    unchanged(f.module, () => expect(() => reserve(f)).toThrow(/duplicate|already reserved/));
  });
});

describe("canonical substrate completion", () => {
  it("requires the canonical owner fill and completed literal producer before vector writes", () => {
    const f = substrateFixture(scalar);
    expect(() => fillNativeInvocationSubstrateResources(f.tx, f.pack)).toThrow("invalid phase");
    expect(() => requireCompletedNativeInvocationSubstrate(f.tx, f.pack)).toThrow("incomplete substrate");
    f.tx.freezeReservations();
    unchanged(f.module, () =>
      expect(() => fillNativeInvocationSubstrateResources(f.tx, f.pack)).toThrow(/incomplete|unfilled/),
    );
    fillNativeStringLiteralResources(f.tx, f.strings);
    fillNativeInvocationSubstrateResources(f.tx, f.pack);
    expect(requireCompletedNativeInvocationSubstrate(f.tx, f.pack)).toBe(f.pack);
    expect(() => fillNativeInvocationSubstrateResources(f.tx, f.pack)).toThrow("duplicate canonical fill");
  });
  it("does not certify externally filled handles, even when their bytes are canonical", () => {
    const f = substrateFixture(scalar);
    f.tx.freezeReservations();
    fillNativeStringLiteralResources(f.tx, f.strings);
    vectorResources.fillNativeArgumentVectorResources(f.tx, f.pack.arguments);
    fillNativeErrorResources(f.tx, f.pack.errors);
    expect(() => requireCompletedNativeInvocationSubstrate(f.tx, f.pack)).toThrow("missing canonical fill");
    expect(() => fillNativeInvocationSubstrateResources(f.tx, f.pack)).toThrow(/duplicate/);
  });
  it.each(["new body", "new locals", "push body", "push locals"] as const)(
    "refuses valid-Wasm noncanonical %s at the lower fill boundary",
    (mutation) => {
      const f = substrateFixture(scalar),
        v = f.pack.arguments;
      f.tx.freezeReservations();
      fillNativeStringLiteralResources(f.tx, f.strings);
      vi.spyOn(vectorResources, "fillNativeArgumentVectorResources").mockImplementation((tx, actual) => {
        expect(actual).toBe(v);
        tx.fillFunction(v.newVector, {
          locals: mutation === "new locals" ? [{ name: "unused-control", type: { kind: "i32" } }] : [],
          body: mutation === "new body" ? [{ op: "ref.null.extern" }] : buildArgumentVectorNewBody(v.layout),
        });
        tx.fillFunction(v.push, {
          locals: [
            ...buildArgumentVectorPushLocals(v.layout),
            ...(mutation === "push locals" ? [{ name: "unused-control", type: { kind: "i32" as const } }] : []),
          ],
          body: mutation === "push body" ? [] : buildArgumentVectorPushBody(v.layout),
        });
      });
      expect(() => fillNativeInvocationSubstrateResources(f.tx, f.pack)).toThrow(
        "noncanonical argument-vector " + mutation.split(" ")[0] + " definition",
      );
      expect(() => requireCompletedNativeInvocationSubstrate(f.tx, f.pack)).toThrow("missing canonical fill");
      f.tx.seal();
      expect(WebAssembly.validate(emitBinary(f.module) as BufferSource)).toBe(true);
    },
  );
  it.each(["new body", "push locals", "error body", "carrier"] as const)(
    "detects post-completion %s mutation",
    (mutation) => {
      const f = substrateFixture(scalar);
      complete(f);
      if (mutation === "new body") f.pack.arguments.newVector.object.body = [{ op: "ref.null.extern" }];
      if (mutation === "push locals")
        f.pack.arguments.push.object.locals.push({ name: "extra", type: { kind: "i32" } });
      if (mutation === "error body") f.pack.errors.newTypeError.object.body = [{ op: "ref.null.extern" }];
      if (mutation === "carrier") Object.assign(f.pack.arguments.carrier.object, { name: "altered" });
      expect(() => requireCompletedNativeInvocationSubstrate(f.tx, f.pack)).toThrow(/altered/);
    },
  );
});

describe("source invocation owns or borrows exactly one substrate", () => {
  it("restores shared invocation state after an actual source getter throws its captured native string", () => {
    const program = prepareGetterProgram(`export function run(message: string): number {
      const object = { get value(): number { throw message; } };
      return object.value;
    }`);
    const f = sourceSubstrateFixture(program),
      runtime = throwingGetterSubstrateRuntime(f);
    const message = runtime.typeErrorName(),
      oldThis = { original: true },
      oldExtras = runtime.newVector();
    runtime.push(oldExtras, message);
    runtime.currentThis.value = oldThis;
    runtime.argc.value = 41;
    runtime.extras.value = oldExtras;
    let thrown: WebAssembly.Exception | undefined;
    try {
      runtime.run(null, runtime.make(message));
    } catch (error) {
      thrown = error as WebAssembly.Exception;
    }
    expect(thrown).toBeInstanceOf(WebAssembly.Exception);
    expect(thrown!.is(runtime.exception)).toBe(true);
    expect(Object.is(thrown!.getArg(runtime.exception, 0), message)).toBe(true);
    expect(Object.is(runtime.currentThis.value, oldThis)).toBe(true);
    expect(runtime.argc.value).toBe(41);
    expect(Object.is(runtime.extras.value, oldExtras)).toBe(true);
    expect(Object.is(runtime.at(oldExtras, 0), message)).toBe(true);
    expect(f.module.imports).toEqual([]);
  });
  it.each([false, true])(
    "executes real captured calls/apply/getter and invocation-generated TypeError restoration; displaced=%s",
    (displaced) => {
      const f = sourceSubstrateFixture(source, true, displaced),
        substrate = f.substrate!;
      expect(f.invocation.gaps).toEqual([]);
      expect(f.invocation.methodArities).toEqual([0, 3]);
      expect(f.pack.arguments).toBe(substrate.arguments);
      expect(f.pack.errors).toBe(substrate.errors);
      expect(substrate.arguments.carrier.typeIndex).toBeLessThan(f.sourceOwner.types.closures.root.typeIndex);
      const shared = nativeInvocationSubstrateReservationInventory(f.tx, substrate).functions;
      const owned = nativeInvocationFunctions(f.tx, f.pack);
      expect(shared).toHaveLength(3);
      expect(owned).toHaveLength(5);
      expect(shared.some((token) => owned.includes(token))).toBe(false);
      expect(new Set([...shared, ...owned]).size).toBe(8);
      const runtime = sourceSubstrateRuntime(f),
        savedThis = { saved: true },
        savedExtras = runtime.newVector();
      runtime.push(savedExtras, "prior extras");
      runtime.currentThis.value = savedThis;
      runtime.argc.value = 73;
      runtime.extras.value = savedExtras;
      const restored = () => {
        expect(Object.is(runtime.currentThis.value, savedThis)).toBe(true);
        expect(runtime.argc.value).toBe(73);
        expect(Object.is(runtime.extras.value, savedExtras)).toBe(true);
        expect(runtime.at(runtime.extras.value, 0)).toBe("prior extras");
      };
      const fn = runtime.makeCall(100),
        getter = runtime.makeGetter(100);
      expect(runtime.call3(null, fn, 2, 3, 400)).toBe(123);
      restored();
      expect(runtime.apply3(false, fn, 4, 5, 600)).toBe(145);
      restored();
      expect(runtime.get(17, getter)).toBe(104);
      restored();
      let exception: WebAssembly.Exception | undefined;
      try {
        runtime.callThrow(null, { invalidCallee: true });
      } catch (error) {
        exception = error as WebAssembly.Exception;
      }
      expect(exception).toBeInstanceOf(WebAssembly.Exception);
      expect(exception!.is(runtime.exception)).toBe(true);
      expect(Object.is(exception!.getArg(runtime.exception, 0), runtime.thrown.value)).toBe(true);
      expect(runtime.errorTag(runtime.thrown.value)).toBe(-11);
      expect(Object.is(runtime.errorName(runtime.thrown.value), runtime.typeErrorName())).toBe(true);
      restored();
      expect(f.module.imports).toEqual([]);
    },
  );
  it("preserves default keys, ordered function census and actual call/apply/getter behavior", () => {
    const f = sourceSubstrateFixture(source, false),
      key = f.invocation.key;
    expect(f.substrate).toBeUndefined();
    expect(nativeInvocationFunctions(f.tx, f.pack).map((token) => token.key)).toEqual([
      key + ":arguments:new",
      key + ":arguments:push",
      key + ":errors:new-TypeError",
      key + ":undefined",
      key + ":is-undefined",
      key + ":method:0",
      key + ":method:3",
      key + ":apply-vector",
    ]);
    expect(f.pack.arguments.array.key).toBe(key + ":arguments:array");
    expect(f.pack.arguments.carrier.key).toBe(key + ":arguments:carrier");
    expect(f.pack.errors.type.key).toBe(key + ":errors:type");
    const runtime = sourceSubstrateRuntime(f);
    expect(runtime.call3(null, runtime.makeCall(7), 2, 3, 4)).toBe(30);
    expect(runtime.apply3(null, runtime.makeCall(7), 4, 5, 6)).toBe(52);
    expect(runtime.get(null, runtime.makeGetter(7))).toBe(11);
  });
  it("preflights invocation-local collision before allocating its default substrate", () => {
    const f = sourceSubstrateBase(scalar, false);
    f.tx.reserveGlobal(f.invocation.key + ":is-undefined", "collision", { kind: "i32" }, false);
    unchanged(f.module, () =>
      expect(() => reserveNativeInvocationResources(f.tx, f.invocation, f.dependencies)).toThrow(
        /duplicate|already reserved/,
      ),
    );
    expect(f.module.functions.some((fn) => fn.name === "__objvec_new")).toBe(false);
  });
  it.each(["undefined", "null", "copy", "accessor", "hidden", "inherited"] as const)(
    "refuses present invalid %s substrate selection before allocation",
    (mutation) => {
      const f = sourceSubstrateBase(scalar),
        dependencies = { ...f.dependencies },
        read = vi.fn(() => f.substrate);
      if (mutation === "accessor") Object.defineProperty(dependencies, "substrate", { enumerable: true, get: read });
      else if (mutation === "hidden")
        Object.defineProperty(dependencies, "substrate", { enumerable: false, value: f.substrate });
      else if (mutation === "inherited") {
        Reflect.deleteProperty(dependencies, "substrate");
        Object.setPrototypeOf(dependencies, { substrate: f.substrate });
      } else
        Object.assign(dependencies, {
          substrate: mutation === "undefined" ? undefined : mutation === "null" ? null : { ...f.substrate },
        });
      unchanged(f.module, () =>
        expect(() => reserveNativeInvocationResources(f.tx, f.invocation, dependencies)).toThrow(/substrate|copied/),
      );
      expect(read).not.toHaveBeenCalled();
    },
  );
  it.each(["removed", "replaced", "added"] as const)(
    "detects a %s optional selection after initial authentication",
    (mutation) => {
      const f = sourceSubstrateFixture(scalar, mutation !== "added");
      expect(requireNativeInvocationReservations(f.tx, f.pack)).toBe(f.pack);
      if (mutation === "removed") Reflect.deleteProperty(f.dependencies, "substrate");
      if (mutation === "replaced") f.dependencies.substrate = { ...f.substrate! };
      if (mutation === "added")
        f.dependencies.substrate = reserveNativeInvocationSubstrateResources(
          f.tx,
          f.requirements,
          { vectors: f.vectors, vectorPlan: f.vectorPlan, strings: f.strings },
          f.plan,
        );
      expect(() => requireNativeInvocationReservations(f.tx, f.pack)).toThrow("changed substrate selection");
    },
  );
  it("rejects a genuine substrate whose literal owner differs, before invocation writes", () => {
    const f = sourceSubstrateBase(scalar, false);
    const strings = reserveNativeStringLiteralResources(f.tx, {
      key: "other-literal-owner",
      utf8Storage: false,
      literals: [{ value: "TypeError", encoding: "wtf16" }],
    });
    const dependencies: NativeInvocationSubstrateDependencies = {
      vectors: f.vectors,
      vectorPlan: f.vectorPlan,
      strings,
    };
    const substrate = reserveNativeInvocationSubstrateResources(f.tx, f.requirements, dependencies, f.plan);
    unchanged(f.module, () =>
      expect(() => reserveNativeInvocationResources(f.tx, f.invocation, { ...f.dependencies, substrate })).toThrow(
        "foreign expected dependencies",
      ),
    );
  });
  it("never auto-fills a borrowed owner or writes invocation state before its canonical completion", () => {
    const f = sourceSubstrateFixture(scalar),
      callables = freezeGetterInvocation(f);
    fillGetterInvocationDependencies(f);
    unchanged(f.module, () =>
      expect(() => fillNativeInvocationResources(f.tx, f.pack, callables, f.exception)).toThrow("incomplete substrate"),
    );
    expect(f.pack.undefinedValue.object.body).toEqual([]);
    expect(f.pack.globals.argc.object.init).toEqual([]);
    fillNativeInvocationSubstrateResources(f.tx, f.substrate!);
    fillNativeInvocationResources(f.tx, f.pack, callables, f.exception);
    expect(() => fillNativeInvocationResources(f.tx, f.pack, callables, f.exception)).toThrow("duplicate fill");
    expect(requireCompletedNativeInvocationSubstrate(f.tx, f.substrate!)).toBe(f.substrate);
  });
});
