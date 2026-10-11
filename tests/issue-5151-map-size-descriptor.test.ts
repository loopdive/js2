// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5151 residual Step F — Map/Set.prototype.size reflection through the
// propertyHelper-style runtime receiver path.
//
// The two direct calls are controls for builtin-static-gopd's syntactic
// `<Ctor>.prototype` recognition. The second pair intentionally captures
// `Object.getOwnPropertyDescriptor` and routes the native prototype through an
// unannotated JavaScript parameter, matching propertyHelper.js's `__getOwnPropertyDescriptor`
// and `verifyProperty(obj, name, ...)` shape. The decimal phase codes make a
// regression actionable without treating an unrelated compile/instantiate
// failure as evidence that descriptor semantics were exercised.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const result = await compile(src, {
    allowJs: true,
    fileName: "issue-5151-map-size-descriptor.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors?.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);

  const imports = result.importObject as WebAssembly.Imports & {
    __setExports?: (exports: Record<string, unknown>) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.__setExports?.(instance.exports as Record<string, unknown>);
  return (instance.exports as { test(): number }).test();
}

const SOURCE = `
  // 1 = no descriptor; 2 = no callable getter; 3 = unexpected setter;
  // 4 = descriptor enumerable; 5 = descriptor non-configurable;
  // 6 = propertyIsEnumerable disagrees; 7 = getter returned wrong size;
  // 8 = getter threw; 9 = all descriptor assertions held; 10 = gOPD threw.
  function descriptorPhase(proto, instance, expectedSize, descriptor) {
    if (descriptor === undefined || descriptor === null) return 1;
    if (typeof descriptor.get !== "function") return 2;
    if (typeof descriptor.set !== "undefined") return 3;
    if (descriptor.enumerable !== false) return 4;
    if (descriptor.configurable !== true) return 5;
    if (Object.prototype.propertyIsEnumerable.call(proto, "size") !== false) return 6;
    try {
      return descriptor.get.call(instance) === expectedSize ? 9 : 7;
    } catch (_) {
      return 8;
    }
  }

  function directMap() {
    const map = new Map();
    map.set(1, 1);
    map.set(2, 2);
    try {
      return descriptorPhase(
        Map.prototype,
        map,
        2,
        Object.getOwnPropertyDescriptor(Map.prototype, "size"),
      );
    } catch (_) {
      return 10;
    }
  }

  function directSet() {
    const set = new Set([1, 2, 3]);
    try {
      return descriptorPhase(
        Set.prototype,
        set,
        3,
        Object.getOwnPropertyDescriptor(Set.prototype, "size"),
      );
    } catch (_) {
      return 10;
    }
  }

  // Same unannotated JS capture shape as propertyHelper.js.
  var __getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

  function capturedDescriptorPhase(proto, instance, expectedSize) {
    try {
      return descriptorPhase(proto, instance, expectedSize, __getOwnPropertyDescriptor(proto, "size"));
    } catch (_) {
      return 10;
    }
  }

  export function test() {
    // The result preserves each phase independently:
    // direct Map, direct Set, captured Map, captured Set.
    return directMap() * 1000000 + directSet() * 10000 +
      capturedDescriptorPhase(Map.prototype, new Map([[1, 1], [2, 2]]), 2) * 100 +
      capturedDescriptorPhase(Set.prototype, new Set([1, 2, 3]), 3);
  }
`;

describe("#5151 Map/Set size descriptor with direct and propertyHelper-style receivers", () => {
  it("keeps the accessor descriptor and non-enumerability through both paths", async () => {
    expect(await runStandalone(SOURCE)).toBe(9090909);
  });
});

// This is deliberately a separate source program from SOURCE above. It keeps
// the initial terminal receipt byte-identifiable while separating a dynamic
// receiver given to a *direct* gOPD call from a captured gOPD function value.
// It also proves the captured builtin against an ordinary own data property;
// that control must not be weakened into an existence-only check.
const DISCRIMINATOR_SOURCE = `
  // 1–9 are semantic descriptor phases; 10 means the gOPD call itself threw;
  // 11 means inspection of a returned descriptor unexpectedly threw.
  function sizeDescriptorPhase(proto, instance, expectedSize, descriptor) {
    try {
      if (descriptor === undefined || descriptor === null) return 1;
      if (typeof descriptor.get !== "function") return 2;
      if (typeof descriptor.set !== "undefined") return 3;
      if (descriptor.enumerable !== false) return 4;
      if (descriptor.configurable !== true) return 5;
      if (Object.prototype.propertyIsEnumerable.call(proto, "size") !== false) return 6;
      return descriptor.get.call(instance) === expectedSize ? 9 : 7;
    } catch (_) {
      return 11;
    }
  }

  function directParameterSizePhase(proto, instance, expectedSize) {
    var descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(proto, "size");
    } catch (_) {
      return 10;
    }
    return sizeDescriptorPhase(proto, instance, expectedSize, descriptor);
  }

  var __getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

  function capturedSizePhase(proto, instance, expectedSize) {
    var descriptor;
    try {
      descriptor = __getOwnPropertyDescriptor(proto, "size");
    } catch (_) {
      return 10;
    }
    return sizeDescriptorPhase(proto, instance, expectedSize, descriptor);
  }

  function capturedOrdinaryOwnDataPhase() {
    var object = { own: 17 };
    var descriptor;
    try {
      descriptor = __getOwnPropertyDescriptor(object, "own");
    } catch (_) {
      return 10;
    }
    try {
      if (descriptor === undefined || descriptor === null) return 1;
      if (descriptor.value !== 17) return 2;
      if (descriptor.writable !== true) return 3;
      if (descriptor.enumerable !== true) return 4;
      if (descriptor.configurable !== true) return 5;
      return Object.prototype.propertyIsEnumerable.call(object, "own") === true ? 9 : 6;
    } catch (_) {
      return 11;
    }
  }

  export function test() {
    var map = new Map([[1, 1], [2, 2]]);
    var set = new Set([1, 2, 3]);
    // radix 100: direct-parameter Map/Set, captured Map/Set, ordinary-object capture.
    return directParameterSizePhase(Map.prototype, map, 2) * 100000000 +
      directParameterSizePhase(Set.prototype, set, 3) * 1000000 +
      capturedSizePhase(Map.prototype, map, 2) * 10000 +
      capturedSizePhase(Set.prototype, set, 3) * 100 +
      capturedOrdinaryOwnDataPhase();
  }
`;

// This source isolates the narrowing boundary itself from descriptor behavior.
// It has four direct NativeProto identity lanes, four actual-instance lanes,
// and one locally shadowed Map spelling. The instance lanes are controls: the
// #5151 withdrawal must not turn every collection argument dynamic just because
// collection prototypes and instances share the checker's `$Map` carrier.
const CARRIER_SOURCE = `
  function mapPrototypeIdentity(proto) {
    return Object.is(proto, Map.prototype) ? 9 : 0;
  }

  function setPrototypeIdentity(proto) {
    return Object.is(proto, Set.prototype) ? 9 : 0;
  }

  function weakMapPrototypeIdentity(proto) {
    return Object.is(proto, WeakMap.prototype) ? 9 : 0;
  }

  function weakSetPrototypeIdentity(proto) {
    return Object.is(proto, WeakSet.prototype) ? 9 : 0;
  }

  function mapInstanceOnly(collection) {
    return collection.get(1) === 7 && collection.size === 1 ? 9 : 0;
  }

  function setInstanceOnly(collection) {
    return collection.has(2) && collection.size === 2 ? 9 : 0;
  }

  function weakMapInstanceOnly(collection, key) {
    return collection.get(key) === 7 ? 9 : 0;
  }

  function weakSetInstanceOnly(collection, key) {
    return collection.has(key) ? 9 : 0;
  }

  function localShadowedMap(Map) {
    function readPrototype(proto) {
      return proto.marker === 17 ? 9 : 0;
    }
    return readPrototype(Map.prototype);
  }

  export function test() {
    var weakMapKey = {};
    var weakSetKey = {};
    var map = new Map();
    map.set(1, 7);
    var set = new Set();
    set.add(1);
    set.add(2);
    var weakMap = new WeakMap();
    weakMap.set(weakMapKey, 7);
    var weakSet = new WeakSet();
    weakSet.add(weakSetKey);
    return mapPrototypeIdentity(Map.prototype) * 100000000 +
      setPrototypeIdentity(Set.prototype) * 10000000 +
      weakMapPrototypeIdentity(WeakMap.prototype) * 1000000 +
      weakSetPrototypeIdentity(WeakSet.prototype) * 100000 +
      mapInstanceOnly(map) * 10000 +
      setInstanceOnly(set) * 1000 +
      weakMapInstanceOnly(weakMap, weakMapKey) * 100 +
      weakSetInstanceOnly(weakSet, weakSetKey) * 10 +
      localShadowedMap({ prototype: { marker: 17 } });
  }
`;

// The two values below intentionally flow through the SAME implicit-any
// parameter. Both checker types otherwise agree on `$Map`, so this is the
// control that proves one observed NativeProto producer withdraws that shared
// physical ABI without losing a genuine Map instance's behavior.
const MIXED_MAP_CARRIER_SOURCE = `
  function mixedMapCarrier(value, instance) {
    if (Object.is(value, Map.prototype)) return 9;
    return value === instance && value.get(1) === 7 && value.size === 1 ? 9 : 0;
  }

  export function test() {
    var map = new Map();
    map.set(1, 7);
    return mixedMapCarrier(Map.prototype, map) * 10 + mixedMapCarrier(map, map);
  }
`;

// A module-level shadow must not satisfy the ambient-global proof used by the
// NativeProto predicate. Kept separate so the main carrier source can use the
// real builtins in its direct identity and instance-specialization controls.
const MODULE_SHADOW_SOURCE = `
  var Map = { prototype: { marker: 17 } };

  function readPrototype(proto) {
    return proto.marker === 17 ? 9 : 0;
  }

  export function test() {
    return readPrototype(Map.prototype);
  }
`;

describe("#5151 dynamic descriptor-call discriminator", () => {
  it("keeps direct-parameter native-prototype and captured ordinary-object paths distinct", async () => {
    expect(await runStandalone(DISCRIMINATOR_SOURCE)).toBe(909090909);
  });
});

describe("#5151 NativeProto parameter carrier narrowing", () => {
  it("preserves direct prototype identity while retaining Map/Set instance behavior", async () => {
    expect(await runStandalone(CARRIER_SOURCE)).toBe(999999999);
  });

  it("withdraws a shared Map ABI when one parameter receives both its prototype and an instance", async () => {
    expect(await runStandalone(MIXED_MAP_CARRIER_SOURCE)).toBe(99);
  });

  it("does not infer a NativeProto producer from a module-shadowed Map", async () => {
    expect(await runStandalone(MODULE_SHADOW_SOURCE)).toBe(9);
  });
});
