// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";
import {
  objectExtensibilityFixture,
  objectExtensibilityRuntimeAsync,
  fillObjectExtensibilityDependencies,
} from "./helpers/native-object-extensibility.js";
import {
  reserveNativePrimitivePrototypeIdentities,
  requireNativePrimitivePrototypeIdentities,
  fillNativePrimitivePrototypeIdentities,
  requireCompletedNativePrimitivePrototypeIdentities,
} from "../src/backend/wasmgc/resources/native-primitive-prototype-identities.js";
import { requireCompletedNativeObjectRealm } from "../src/backend/wasmgc/resources/native-object-realm.js";
import { NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES } from "../src/runtime/contracts/native-primitive-prototype-identities.js";
import { alternativeMixedStringOwner } from "./helpers/native-mixed-object-access.js";
import {
  declareNativePrimitiveWrapperStorageResources,
  reserveNativePrimitiveWrapperStorageResources,
} from "../src/backend/wasmgc/resources/native-primitive-wrapper-storage.js";
import { requireNativeStringLiteral } from "../src/backend/wasmgc/resources/native-string-literals.js";
import { planNativeStringLiteral } from "../src/runtime/wasmgc/values/string-literal-bodies.js";

afterEach(async () => await setImmediate());
for (const [displaced, decoded, mode] of [
  [false, false, "interned"],
  [true, true, "allocating"],
] as const)
  describe(`actual primitive prototype bootstrap displaced=${displaced} decoded=${decoded} boxes=${mode}`, () => {
    let r: Awaited<ReturnType<typeof objectExtensibilityRuntimeAsync>>;
    beforeAll(async () => {
      r = await objectExtensibilityRuntimeAsync(displaced, decoded, mode, true, false, true);
      console.info(
        "primitive prototype component",
        JSON.stringify({
          displaced,
          decoded,
          mode,
          bytes: r.bytes.length,
          sha256: createHash("sha256").update(r.bytes).digest("hex"),
          imports: WebAssembly.Module.imports(r.wasm),
          reachable: r.liveNames.length,
          deadSnapshotBodies: r.stubbed,
          wholeRealmCompleted: r.wholeRealmCompleted,
        }),
      );
    }, 120000);
    beforeEach(() => r.api.initialize());
    const identities = () => NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.map((row) => r.api["prototype_" + row.kind]());
    const prototypeOf = (object: unknown) => {
      const [status, value] = r.api.getPrototypeOf(object);
      expect(status).toBe(1);
      return value;
    };

    it("executes genuine slots with zero imports, without certifying complete population", () => {
      expect(WebAssembly.Module.imports(r.wasm)).toEqual([]);
      expect(r.r.tx.state).toBe("filling");
      expect(r.wholeRealmCompleted).toBe(false);
      expect(r.r.primitivePrototypes!.completionScope).toBe("primitive-prototype-identities-only");
      expect(
        requireCompletedNativePrimitivePrototypeIdentities(
          r.r.tx,
          r.r.primitivePrototypes!,
          r.r.primitivePrototypeDependencies,
        ),
      ).toBe(r.r.primitivePrototypes);
      expect(() => requireCompletedNativeObjectRealm(r.r.tx, r.r.realm.declarations)).toThrow(/incomplete/);
      expect(r.liveNames.filter((name) => name.startsWith("__primitive_prototypes_"))).toHaveLength(7);
    });

    it("refuses reads before initialization and creates five distinct stable real prototype identities", () => {
      for (const row of NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES)
        expect(() => r.api["prototype_" + row.kind]()).toThrow(WebAssembly.RuntimeError);
      r.api.initializePrimitivePrototypes();
      const first = identities();
      expect(new Set(first).size).toBe(5);
      for (const object of first) expect(prototypeOf(object)).toBe(r.api.objectPrototype.value);
      r.api.initializePrimitivePrototypes();
      identities().forEach((object, index) => expect(object).toBe(first[index]));
    });

    it("has false, positive zero and a genuine empty String with the exact own length descriptor", () => {
      r.api.initializePrimitivePrototypes();
      expect(r.api.payload_Boolean(r.api.prototype_Boolean())).toBe(0);
      expect(r.api.payload_Number(r.api.prototype_Number())).toBe(0);
      expect(Object.is(r.api.payload_Number(r.api.prototype_Number()), -0)).toBe(false);
      const string = r.api.prototype_String();
      expect(r.api.prototypeStringLength(string)).toBe(0);
      expect(r.api.prototypeLengthValue(string)).toBe(0);
      expect(r.api.prototypeLengthFlags(string)).toBe(0);
      expect(r.api.prototypeHasIndexZero(string)).toBe(0);
      expect(r.api.prototypeHasIndexZero(r.api.newString(null, r.api.text()))).toBe(1);
      expect(r.api.payload_String(string)).toBe(r.api.payload_String(string));
    });

    it("uses ordinary Symbol and BigInt prototypes with no private primitive-data slots", () => {
      r.api.initializePrimitivePrototypes();
      for (const object of [r.api.prototype_Symbol(), r.api.prototype_BigInt()]) {
        expect(prototypeOf(object)).toBe(r.api.objectPrototype.value);
        for (const row of NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES)
          expect(() => r.api["payload_" + row.kind](object)).toThrow(WebAssembly.RuntimeError);
      }
    });

    it("does not replace identities or undo user prototype/flag mutations on repeat initialization", () => {
      r.api.initializePrimitivePrototypes();
      const first = identities();
      for (const object of first) {
        expect(r.api.internalSetPrototypeOf(object, null)).toBe(1);
        r.api.setFlags(object, 0x5a5a5a80);
      }
      r.api.initializePrimitivePrototypes();
      identities().forEach((object, index) => {
        expect(object).toBe(first[index]);
        expect(prototypeOf(object)).toBe(null);
        expect(r.api.flags(object)).toBe(0x5a5a5a80);
      });
    });

    it.each(["renewRealm", "renewObjectPrototype"])(
      "refuses stale reads and refreshes all five identities after %s",
      (change) => {
        r.api.initializePrimitivePrototypes();
        const previous = identities();
        r.api[change]();
        for (const row of NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES)
          expect(() => r.api["prototype_" + row.kind]()).toThrow(WebAssembly.RuntimeError);
        r.api.initializePrimitivePrototypes();
        identities().forEach((object, index) => {
          expect(Object.is(object, previous[index])).toBe(false);
          expect(prototypeOf(object)).toBe(r.api.objectPrototype.value);
        });
        const next = identities();
        r.api.initializePrimitivePrototypes();
        identities().forEach((object, index) => expect(object).toBe(next[index]));
      },
    );

    it.each(["clearRealm", "clearObjectPrototype"])("refuses reads and initialization with %s", (clear) => {
      r.api.initializePrimitivePrototypes();
      r.api[clear]();
      for (const row of NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES)
        expect(() => r.api["prototype_" + row.kind]()).toThrow(WebAssembly.RuntimeError);
      expect(() => r.api.initializePrimitivePrototypes()).toThrow(WebAssembly.RuntimeError);
      r.api.initialize();
      r.api.initializePrimitivePrototypes();
      expect(new Set(identities()).size).toBe(5);
    });
  });

describe("authenticated primitive prototype identity owner", () => {
  const fixture = () => objectExtensibilityFixture(false, false, "interned", false, false, true);
  let prepared: ReturnType<typeof fixture>;
  beforeEach(() => {
    prepared = fixture();
  }, 120000);
  it("coexists with real owners but refuses duplicate, copied, foreign and substituted dependency identities", () => {
    const r = prepared,
      pack = r.primitivePrototypes!,
      d = r.primitivePrototypeDependencies;
    expect(requireNativePrimitivePrototypeIdentities(r.tx, pack, d)).toBe(pack);
    const count = r.f.module.functions.length;
    expect(() => reserveNativePrimitivePrototypeIdentities(r.tx, d)).toThrow(/already owns/);
    expect(r.f.module.functions.length).toBe(count);
    expect(() => requireNativePrimitivePrototypeIdentities(r.tx, { ...pack }, d)).toThrow(/copied/);
    expect(() => requireNativePrimitivePrototypeIdentities(r.tx, pack, { ...d })).toThrow(/different expected/);
    const other = fixture();
    expect(() => requireNativePrimitivePrototypeIdentities(other.tx, pack, d)).toThrow(/foreign/);
  });

  it("refuses completion and filling before genuine dependencies are complete", () => {
    const r = prepared,
      pack = r.primitivePrototypes!,
      d = r.primitivePrototypeDependencies;
    expect(() => requireCompletedNativePrimitivePrototypeIdentities(r.tx, pack, d)).toThrow(/missing canonical/);
    r.tx.freezeReservations();
    expect(() => fillNativePrimitivePrototypeIdentities(r.tx, pack)).toThrow(/canonical|incomplete/);
  });

  it("refuses copied declaration plans and non-data dependencies without evaluating getters", () => {
    const r = prepared,
      d = r.primitivePrototypeDependencies;
    const count = r.f.module.functions.length;
    expect(() =>
      reserveNativePrimitivePrototypeIdentities(r.tx, { ...d, wrapperPlan: structuredClone(d.wrapperPlan) }),
    ).toThrow(/plan|owner/);
    let reads = 0;
    const input = { ...d };
    Object.defineProperty(input, "wrappers", {
      enumerable: true,
      get() {
        reads++;
        return d.wrappers;
      },
    });
    expect(() => reserveNativePrimitivePrototypeIdentities(r.tx, input)).toThrow(/own dependency data/);
    expect(reads).toBe(0);
    expect(r.f.module.functions.length).toBe(count);
  });

  it("rejects an independently genuine wrapper family from another state owner in the same ledger", () => {
    const r = prepared,
      alternative = alternativeMixedStringOwner(r);
    const { layouts, layoutPlan, layoutDependencies } = alternative.dependencies;
    const wrapperDependencies = { layouts, layoutPlan, layoutDependencies };
    const wrapperPlan = declareNativePrimitiveWrapperStorageResources(
      "alternative:storage",
      {
        object: r.f.objects.object.key,
        propMap: r.f.objects.propMap.key,
        anyString: r.f.stringTypes.key + ":any",
        symbol: r.symbols.types.symbol.key,
      },
      8,
    );
    const wrappers = reserveNativePrimitiveWrapperStorageResources(
      r.tx,
      "alternative:storage",
      wrapperPlan,
      wrapperDependencies,
    );
    const count = r.f.module.functions.length;
    expect(() =>
      reserveNativePrimitivePrototypeIdentities(r.tx, {
        ...r.primitivePrototypeDependencies,
        wrappers,
        wrapperPlan,
        wrapperDependencies,
      }),
    ).toThrow(/different realm\/layout/);
    expect(r.f.module.functions.length).toBe(count);
  });

  it("refuses a changed issued getter signature", () => {
    const r = prepared,
      pack = r.primitivePrototypes!;
    pack.read.Number.object.typeIdx = pack.initialize.object.typeIdx;
    expect(() => requireNativePrimitivePrototypeIdentities(r.tx, pack, r.primitivePrototypeDependencies)).toThrow(
      /altered function descriptor/,
    );
  });

  it.each(["wrapper-allocation", "StringCreate"])("refuses a receipt-valid substituted %s dependency body", (role) => {
    const r = prepared,
      pack = r.primitivePrototypes!;
    const target = role === "wrapper-allocation" ? r.wrappers.allocation.Boolean : r.stringCreate.create;
    const fill = r.tx.fillFunction.bind(r.tx);
    r.tx.fillFunction = (token, definition) =>
      fill(token, token === target ? { locals: [], body: [{ op: "unreachable" }] } : definition);
    fillObjectExtensibilityDependencies(r);
    r.tx.assertCompletedReservation(target);
    expect(() => fillNativePrimitivePrototypeIdentities(r.tx, pack)).toThrow(/canonical/);
    expect(() =>
      requireCompletedNativePrimitivePrototypeIdentities(r.tx, pack, r.primitivePrototypeDependencies),
    ).toThrow(/missing canonical/);
  });

  it("refuses a different real String leaf in place of the canonical empty payload", () => {
    const r = prepared,
      pack = r.primitivePrototypes!;
    const empty = requireNativeStringLiteral(r.tx, r.f.strings, "");
    const wrong = planNativeStringLiteral(r.f.strings.layout, false, "x");
    if (empty.kind !== "global" || wrong.kind !== "global") throw Error("lost short literal control");
    const fill = r.tx.fillGlobal.bind(r.tx);
    r.tx.fillGlobal = (token, init) => fill(token, token === empty.global ? wrong.init : init);
    expect(() => fillObjectExtensibilityDependencies(r)).toThrow(/noncanonical executable empty literal/);
    r.tx.assertCompletedReservation(empty.global);
    expect(() => fillNativePrimitivePrototypeIdentities(r.tx, pack)).toThrow(/canonical|incomplete/);
    expect(() =>
      requireCompletedNativePrimitivePrototypeIdentities(r.tx, pack, r.primitivePrototypeDependencies),
    ).toThrow(/missing canonical/);
  });

  describe("canonical fill audits", () => {
    beforeEach(() => fillObjectExtensibilityDependencies(prepared), 120000);
    it("completes only the genuine bootstrap and refuses a duplicate fill", () => {
      const r = prepared,
        pack = r.primitivePrototypes!;
      fillNativePrimitivePrototypeIdentities(r.tx, pack);
      expect(requireCompletedNativePrimitivePrototypeIdentities(r.tx, pack, r.primitivePrototypeDependencies)).toBe(
        pack,
      );
      expect(() => fillNativePrimitivePrototypeIdentities(r.tx, pack)).toThrow(/duplicate/);
    });
    it.each([
      "ordinary-allocation",
      "initialize",
      ...NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.map((row) => row.kind + ":read"),
    ])("re-derives %s independently of valid allocator fill receipts", (role) => {
      const r = prepared,
        pack = r.primitivePrototypes!;
      const fill = r.tx.fillFunction.bind(r.tx);
      let replaced = 0;
      r.tx.fillFunction = (token, definition) => {
        if (token.key.endsWith(":primitive-prototypes:" + role)) {
          replaced++;
          fill(token, { locals: [], body: [{ op: "unreachable" }] });
          r.tx.assertCompletedReservation(token);
        } else fill(token, definition);
      };
      fillNativePrimitivePrototypeIdentities(r.tx, pack);
      expect(replaced).toBe(1);
      expect(() =>
        requireCompletedNativePrimitivePrototypeIdentities(r.tx, pack, r.primitivePrototypeDependencies),
      ).toThrow(/noncanonical function definition/);
    });

    it("makes an interrupted partial fill terminal", () => {
      const r = prepared,
        pack = r.primitivePrototypes!;
      const fill = r.tx.fillFunction.bind(r.tx);
      r.tx.fillFunction = (token, definition) => {
        if (token === pack.read.Number) throw Error("partial fill interruption");
        fill(token, definition);
      };
      expect(() => fillNativePrimitivePrototypeIdentities(r.tx, pack)).toThrow(/partial fill/);
      r.tx.fillFunction = fill;
      expect(() => fillNativePrimitivePrototypeIdentities(r.tx, pack)).toThrow(/failed fill/);
      expect(() =>
        requireCompletedNativePrimitivePrototypeIdentities(r.tx, pack, r.primitivePrototypeDependencies),
      ).toThrow(/missing canonical/);
    });

    it("re-derives the private capsule initializer despite a valid global fill receipt", () => {
      const r = prepared,
        pack = r.primitivePrototypes!;
      const fill = r.tx.fillGlobal.bind(r.tx);
      let replaced = 0;
      r.tx.fillGlobal = (token, init) => {
        if (token.key.endsWith(":primitive-prototypes:state")) {
          replaced++;
          fill(token, [{ op: "ref.null.extern" }]);
          r.tx.assertCompletedReservation(token);
        } else fill(token, init);
      };
      fillNativePrimitivePrototypeIdentities(r.tx, pack);
      expect(replaced).toBe(1);
      expect(() =>
        requireCompletedNativePrimitivePrototypeIdentities(r.tx, pack, r.primitivePrototypeDependencies),
      ).toThrow(/noncanonical global initializer/);
    });
  });
});
