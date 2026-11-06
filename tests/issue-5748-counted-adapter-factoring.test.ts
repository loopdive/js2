// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Direct public-API unit contracts. Injected conversion services do not establish
// compiler carrier provenance, full IR equivalence or parent #5748 acceptance.
import { randomUUID, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  createBoundaryObjectAdapter,
  type BoundaryObjectAdapterContext,
  type BoundaryObjectOperation,
} from "../src/runtime/boundary-object-adapter.js";
import {
  isCompatibilitySemanticIntent,
  resolveCompatibilitySemanticImport,
  type CompatibilitySemanticAdapterContext,
} from "../src/runtime/compatibility-semantic-adapter.js";
import {
  resolvePlatformCapabilityImport,
  type PlatformCapabilityAdapterContext,
} from "../src/runtime/platform-capability-adapter.js";
import type { ImportIntent } from "../src/index.js";

function exportView(): Record<string, Function> {
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  return new WebAssembly.Instance(module).exports as Record<string, Function>;
}

function capture(body: () => unknown): { threw: boolean; value: unknown } {
  try {
    return { threw: false, value: body() };
  } catch (error) {
    return { threw: true, value: error };
  }
}

type MutableObjectTestContext = {
  -readonly [Key in keyof BoundaryObjectAdapterContext]: BoundaryObjectAdapterContext[Key];
};

function objectContext(
  subject: object,
  view: Record<string, Function> | undefined,
  events: string[],
  admitted = true,
): MutableObjectTestContext {
  return {
    getExports: () => {
      events.push("exports");
      return view;
    },
    isAdmitted: (obj, exports) => {
      events.push("admit");
      expect(exports).toBe(view);
      return admitted && obj === subject;
    },
    toPropertyKey: (value) => value as PropertyKey,
    toHostValue: (value) => value,
    fromHostValue: (value, exports) => {
      events.push("fromHost");
      expect(exports).toBe(view);
      return value;
    },
    toNativeVector: (values, exports) => {
      events.push("vector");
      expect(exports).toBe(view);
      return values;
    },
    readArguments: (value) => value as any[],
    toAccessor: (value) => value,
  };
}

const unaryCases: readonly [BoundaryObjectOperation, null | 0][] = [
  ["keys", null],
  ["getPrototypeOf", null],
  ["getOwnPropertyNames", null],
  ["getOwnPropertySymbols", null],
  ["ownKeys", null],
  ["preventExtensions", null],
  ["seal", null],
  ["freeze", null],
  ["reflectPreventExtensions", 0],
  ["isExtensible", 0],
  ["isSealed", 0],
  ["isFrozen", 0],
  ["forInKeys", null],
];

describe("#5748 unary adapter admission preserves actual effects", () => {
  it.each(unaryCases)("%s retains unary arity and admitted operation effects", (operation) => {
    const symbol = Symbol("own");
    const prototype = { inherited: 4 };
    const target = Object.create(prototype);
    Object.defineProperties(target, {
      visible: { value: 7, enumerable: true, writable: true, configurable: true },
      hidden: { value: 9, enumerable: false, writable: true, configurable: true },
    });
    target[symbol] = 11;
    const events: string[] = [];
    const subject = new Proxy(target, {
      ownKeys: (obj) => {
        events.push("ownKeys");
        return Reflect.ownKeys(obj);
      },
      getOwnPropertyDescriptor: (obj, key) => {
        events.push("descriptor");
        return Reflect.getOwnPropertyDescriptor(obj, key);
      },
      getPrototypeOf: (obj) => {
        events.push("prototype");
        return Reflect.getPrototypeOf(obj);
      },
      preventExtensions: (obj) => {
        events.push("prevent");
        return Reflect.preventExtensions(obj);
      },
      isExtensible: (obj) => {
        events.push("extensible");
        return Reflect.isExtensible(obj);
      },
    });
    const context = objectContext(subject, exportView(), events);
    const call = createBoundaryObjectAdapter(operation, context);
    expect(call.length).toBe(1);
    const value = call(subject);
    expect(events.slice(0, 2)).toEqual(["exports", "admit"]);
    expect(events.filter((event) => event === "exports")).toHaveLength(1);
    expect(events.filter((event) => event === "admit")).toHaveLength(1);
    switch (operation) {
      case "keys":
        expect(value).toEqual(["visible"]);
        expect(events.at(-1)).toBe("vector");
        break;
      case "getPrototypeOf":
        expect(value).toBe(prototype);
        expect(events).toEqual(["exports", "admit", "prototype", "fromHost"]);
        break;
      case "getOwnPropertyNames":
        expect(value).toEqual(["visible", "hidden"]);
        expect(events).toEqual(["exports", "admit", "ownKeys", "vector"]);
        break;
      case "getOwnPropertySymbols":
        expect(value).toEqual([symbol]);
        expect(events).toEqual(["exports", "admit", "ownKeys", "vector"]);
        break;
      case "ownKeys":
        expect(value).toEqual(["visible", "hidden", symbol]);
        expect(events).toEqual(["exports", "admit", "ownKeys", "vector"]);
        break;
      case "forInKeys":
        expect(value).toEqual(["visible", "inherited"]);
        expect(events.at(-1)).toBe("vector");
        break;
      case "preventExtensions":
      case "seal":
      case "freeze":
        expect(value).toBe(subject);
        expect(Object.isExtensible(target)).toBe(false);
        if (operation === "seal") expect(Object.isSealed(target)).toBe(true);
        if (operation === "freeze") expect(Object.isFrozen(target)).toBe(true);
        break;
      case "reflectPreventExtensions":
        expect(value).toBe(2);
        expect(Object.isExtensible(target)).toBe(false);
        expect(events).toEqual(["exports", "admit", "prevent"]);
        break;
      case "isExtensible":
        expect(value).toBe(2);
        expect(events).toEqual(["exports", "admit", "extensible"]);
        break;
      case "isSealed":
      case "isFrozen":
        expect(value).toBe(1);
        expect(events).toEqual(["exports", "admit", "extensible"]);
        break;
      default:
        throw new Error("unexpected unary case");
    }
  });

  for (const state of ["missing", "rejected"] as const) {
    it.each(unaryCases)(`%s in ${state} state does not probe the subject`, (operation, fallback) => {
      const events: string[] = [];
      const touched = () => {
        throw new Error("inadmissible subject was probed");
      };
      const subject = new Proxy(
        {},
        {
          ownKeys: touched,
          getPrototypeOf: touched,
          getOwnPropertyDescriptor: touched,
          preventExtensions: touched,
          isExtensible: touched,
        },
      );
      const context = objectContext(subject, state === "missing" ? undefined : exportView(), events, false);
      const call = createBoundaryObjectAdapter(operation, context);
      expect(call.length).toBe(1);
      expect(call(subject)).toBe(fallback);
      expect(events).toEqual(state === "missing" ? ["exports"] : ["exports", "admit"]);
    });
  }

  it.each(["exports", "admit", "ownKeys", "vector", "prevent"] as const)(
    "propagates the exact %s abrupt completion without later effects",
    (stage) => {
      const sentinel = new Error(stage);
      const events: string[] = [];
      const subject = new Proxy(
        {},
        {
          ownKeys: () => {
            events.push("ownKeys");
            if (stage === "ownKeys") throw sentinel;
            return [];
          },
          preventExtensions: () => {
            events.push("prevent");
            throw sentinel;
          },
        },
      );
      const context = objectContext(subject, exportView(), events);
      if (stage === "exports")
        context.getExports = () => {
          events.push("exports");
          throw sentinel;
        };
      if (stage === "admit")
        context.isAdmitted = () => {
          events.push("admit");
          throw sentinel;
        };
      if (stage === "vector")
        context.toNativeVector = () => {
          events.push("vector");
          throw sentinel;
        };
      const call = createBoundaryObjectAdapter(stage === "prevent" ? "reflectPreventExtensions" : "keys", context);
      const outcome = capture(() => call(subject));
      expect(outcome.threw).toBe(true);
      expect(outcome.value).toBe(sentinel);
      const expected =
        stage === "exports"
          ? ["exports"]
          : stage === "admit"
            ? ["exports", "admit"]
            : [
                "exports",
                "admit",
                stage === "prevent" ? "prevent" : "ownKeys",
                ...(stage === "vector" ? ["vector"] : []),
              ];
      expect(events).toEqual(expected);
    },
  );

  it("captures the admitted view across a reentrant trap and reads a fresh view next call", () => {
    const first = exportView();
    const second = exportView();
    let current = first;
    const converted: Record<string, Function>[] = [];
    const subject = new Proxy(
      { key: 1 },
      {
        ownKeys: () => {
          current = second;
          return ["key"];
        },
      },
    );
    const context = objectContext(subject, first, []);
    context.getExports = () => current;
    context.isAdmitted = (obj) => obj === subject;
    context.toNativeVector = (values, view) => {
      converted.push(view);
      return values;
    };
    const call = createBoundaryObjectAdapter("ownKeys", context);
    expect(call(subject)).toEqual(["key"]);
    expect(call(subject)).toEqual(["key"]);
    expect(converted).toEqual([first, second]);
  });
});

const numericOperations = [
  [0, "+", 9],
  [1, "-", 3],
  [2, "*", 18],
  [3, "/", 2],
  [4, "%", 0],
  [5, "**", 216],
  [6, "&", 2],
  [7, "|", 7],
  [8, "^", 5],
  [9, "<<", 48],
  [10, ">>", 0],
  [11, ">>>", 0],
] as const;
const primitiveContext: CompatibilitySemanticAdapterContext = {
  strictEqual: (left, right) => left === right,
  isWasmStruct: () => false,
  toPrimitive: () => {
    throw new Error("primitive operands must not convert");
  },
  createProxy: (target, handler) => new Proxy(target as object, handler as ProxyHandler<object>),
};
function bigintCall(context = primitiveContext): (...args: any[]) => any {
  const call = resolveCompatibilitySemanticImport({ type: "host_bigint_binop" }, context);
  expect(typeof call).toBe("function");
  return call as (...args: any[]) => any;
}

describe("#5748 compatibility operator dispatch", () => {
  it.each(numericOperations)("number opcode %s retains actual JS %s", (opcode, operator, expected) => {
    const oracle = runInNewContext(`left ${operator} right`, { left: 6, right: 3 });
    expect(oracle).toBe(expected);
    expect(bigintCall()(opcode, 6, 3)).toBe(oracle);
  });
  it.each(numericOperations)("BigInt opcode %s retains actual JS %s or TypeError", (opcode, operator) => {
    const call = bigintCall();
    if (opcode === 11) {
      const oracle = capture(() => runInNewContext(`left ${operator} right`, { left: 6n, right: 3n }));
      expect(oracle.threw).toBe(true);
      expect((oracle.value as Error).name).toBe("TypeError");
      const actual = capture(() => call(opcode, 6n, 3n));
      expect(actual.threw).toBe(true);
      expect(actual.value).toBeInstanceOf(TypeError);
    } else {
      const oracle = runInNewContext(`left ${operator} right`, { left: 6n, right: 3n });
      expect(typeof oracle).toBe("bigint");
      expect(call(opcode, 6n, 3n)).toBe(oracle);
    }
  });
  it.each(numericOperations)("mixed operands retain native TypeError for opcode %s", (opcode, operator) => {
    const call = bigintCall();
    const oracle = capture(() => runInNewContext(`left ${operator} right`, { left: 6n, right: 3 }));
    expect(oracle.threw).toBe(true);
    expect((oracle.value as Error).name).toBe("TypeError");
    const actual = capture(() => call(opcode, 6n, 3));
    expect(actual.threw).toBe(true);
    expect(actual.value).toBeInstanceOf(TypeError);
  });

  const coercionSentinel = new Error("opcode must not coerce");
  const invalidOpcodes = [
    -1,
    12,
    NaN,
    Infinity,
    -Infinity,
    0.5,
    "0",
    {
      valueOf: () => {
        throw coercionSentinel;
      },
    },
    Symbol("opcode"),
    0n,
  ];
  it.each(invalidOpcodes.map((opcode, index) => [index, opcode] as const))(
    "invalid opcode case %s converts both operands before the original default diagnostic",
    (_index, opcode) => {
      const left = {};
      const right = {};
      const events: string[] = [];
      const context: CompatibilitySemanticAdapterContext = {
        ...primitiveContext,
        // Trusted service injection tests callback ordering, not Wasm ownership.
        isWasmStruct: (value) => value === left || value === right,
        toPrimitive: (value, hint) => {
          events.push(`${value === left ? "L" : "R"}:${hint}`);
          return value === left ? 6 : 3;
        },
      };
      const call = bigintCall(context);
      const actual = capture(() => call(opcode, left, right));
      expect(actual.threw).toBe(true);
      expect(actual.value).toBeInstanceOf(TypeError);
      expect((actual.value as Error).message).toBe("Cannot mix BigInt and other types, use explicit conversions");
      expect(events).toEqual(["L:number", "R:number"]);
    },
  );
  it("negative zero retains addition and the default hint", () => {
    const left = {};
    const right = {};
    const hints: string[] = [];
    const call = bigintCall({
      ...primitiveContext,
      isWasmStruct: () => true,
      toPrimitive: (value, hint) => {
        hints.push(hint);
        return value === left ? 6 : 3;
      },
    });
    expect(call(-0, left, right)).toBe(9);
    expect(hints).toEqual(["default", "default"]);
  });
  it.each(["left", "right"] as const)("retains %s conversion failure before invalid-opcode handling", (side) => {
    const left = {};
    const right = {};
    const sentinel = new Error(side);
    const events: string[] = [];
    const call = bigintCall({
      ...primitiveContext,
      isWasmStruct: () => true,
      toPrimitive: (value) => {
        const name = value === left ? "left" : "right";
        events.push(name);
        if (name === side) throw sentinel;
        return 6;
      },
    });
    const actual = capture(() => call(12, left, right));
    expect(actual.threw).toBe(true);
    expect(actual.value).toBe(sentinel);
    expect(events).toEqual(side === "left" ? ["left"] : ["left", "right"]);
  });
  it("prototype-added invalid numeric slots are never admitted", () => {
    const originalMinus = Object.getOwnPropertyDescriptor(Array.prototype, "-1");
    const originalTwelve = Object.getOwnPropertyDescriptor(Array.prototype, "12");
    const poison = new Error("invalid table slot was read");
    const call = bigintCall();
    let minus: ReturnType<typeof capture>;
    let twelve: ReturnType<typeof capture>;
    let valid: unknown;
    try {
      Object.defineProperty(Array.prototype, "-1", {
        configurable: true,
        get: () => {
          throw poison;
        },
      });
      Object.defineProperty(Array.prototype, "12", {
        configurable: true,
        get: () => {
          throw poison;
        },
      });
      minus = capture(() => call(-1, 6, 3));
      twelve = capture(() => call(12, 6, 3));
      valid = call(0, 6, 3);
    } finally {
      if (originalMinus) Object.defineProperty(Array.prototype, "-1", originalMinus);
      else Reflect.deleteProperty(Array.prototype, "-1");
      if (originalTwelve) Object.defineProperty(Array.prototype, "12", originalTwelve);
      else Reflect.deleteProperty(Array.prototype, "12");
    }
    expect(valid).toBe(9);
    for (const outcome of [minus!, twelve!]) {
      expect(outcome.threw).toBe(true);
      expect(outcome.value).toBeInstanceOf(TypeError);
      expect((outcome.value as Error).message).toBe("Cannot mix BigInt and other types, use explicit conversions");
    }
  });
});

const semanticTypes = [
  "string_literal",
  "await",
  "host_eq",
  "host_loose_eq",
  "host_add",
  "host_bigint_binop",
  "host_compare",
  "same_value_zero",
  "date_new",
  "date_method",
  "proxy_create",
] as const;
describe("#5748 semantic intent classification", () => {
  it.each(semanticTypes)("retains %s membership", (type) => {
    expect(isCompatibilitySemanticIntent({ type } as ImportIntent)).toBe(true);
  });
  it("reads the type getter exactly once", () => {
    let reads = 0;
    const intent = Object.defineProperty({}, "type", {
      get: () => {
        reads++;
        return "await";
      },
    });
    expect(isCompatibilitySemanticIntent(intent as ImportIntent)).toBe(true);
    expect(reads).toBe(1);
  });
  const foreignTypes = [
    undefined,
    null,
    1,
    {
      toString: () => {
        throw new Error("must not coerce");
      },
    },
    Symbol("type"),
  ];
  it.each(foreignTypes.map((type, index) => [index, type] as const))(
    "rejects foreign runtime type case %s without coercion",
    (_index, type) => expect(isCompatibilitySemanticIntent({ type } as unknown as ImportIntent)).toBe(false),
  );
});

function platformContext(deps?: Record<string, any>): PlatformCapabilityAdapterContext {
  return { deps, getNodeRequire: () => undefined, wrapWasmClosure: () => null, wrapUnknownCallable: (value) => value };
}
function withCrypto<T>(crypto: object, body: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: crypto });
    return body();
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
}
describe("#5748 factored host builtin constructor plumbing", () => {
  it("preserves dependency getter reads, receiver and argument wrapping", () => {
    const events: string[] = [];
    const dependency = {
      marker: "deps",
      get randomUUID() {
        events.push("get");
        return function (this: { marker: string }, a: unknown, b: unknown) {
          events.push(this.marker);
          return `${a}:${b}`;
        };
      },
    };
    const context = platformContext({ crypto: dependency });
    context.wrapUnknownCallable = (value) => {
      events.push(`wrap:${value}`);
      return `wrapped:${value}`;
    };
    const call = resolvePlatformCapabilityImport(
      { type: "node_builtin_fn", moduleName: "crypto", name: "randomUUID" },
      context,
    );
    expect(typeof call).toBe("function");
    expect(call!("a", "b")).toBe("wrapped:a:wrapped:b");
    expect(events).toEqual(["get", "get", "wrap:a", "wrap:b", "deps"]);
  });
  it("captures Node module method once with its actual receiver", () => {
    const events: string[] = [];
    const module = {
      marker: "node",
      get randomUUID() {
        events.push("get");
        return function (this: { marker: string }, value: unknown) {
          events.push(this.marker);
          return `${this.marker}:${value}`;
        };
      },
    };
    const context = platformContext();
    context.getNodeRequire = () => (name) => {
      events.push(`require:${name}`);
      return module;
    };
    context.wrapUnknownCallable = (value) => {
      events.push("wrap");
      return String(value).toUpperCase();
    };
    const call = resolvePlatformCapabilityImport(
      { type: "node_builtin_fn", moduleName: "crypto", name: "randomUUID" },
      context,
    );
    expect(typeof call).toBe("function");
    expect(call!("arg")).toBe("node:ARG");
    expect(events).toEqual(["require:crypto", "get", "wrap", "node"]);
  });
  it("retains browser UUID receiver and passes the genuine native result", () => {
    const events: string[] = [];
    let nativeResult = "";
    const crypto = {
      randomUUID() {
        expect(this).toBe(crypto);
        events.push("uuid");
        nativeResult = randomUUID();
        return nativeResult;
      },
    };
    const context = platformContext();
    context.wrapUnknownCallable = (value) => {
      events.push("wrap");
      return value;
    };
    withCrypto(crypto, () => {
      const call = resolvePlatformCapabilityImport(
        { type: "node_builtin_fn", moduleName: "crypto", name: "randomUUID" },
        context,
      );
      expect(typeof call).toBe("function");
      const actual = call!("arg");
      expect(actual).toBe(nativeResult);
      expect(nativeResult).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
    expect(events).toEqual(["wrap", "uuid"]);
  });
  it("retains browser byte-buffer receiver and genuine native buffer identity", () => {
    const events: string[] = [];
    let nativeResult: Uint8Array | undefined;
    const crypto = {
      getRandomValues(value: Uint8Array) {
        expect(this).toBe(crypto);
        events.push("bytes");
        nativeResult = webcrypto.getRandomValues(value);
        return nativeResult;
      },
    };
    const context = platformContext();
    context.wrapUnknownCallable = () => {
      throw new Error("randomBytes length must not wrap a callable");
    };
    withCrypto(crypto, () => {
      const call = resolvePlatformCapabilityImport(
        { type: "node_builtin_fn", moduleName: "crypto", name: "randomBytes" },
        context,
      );
      expect(typeof call).toBe("function");
      const actual = call!(4);
      expect(actual).toBe(nativeResult);
      expect(actual).toBeInstanceOf(Uint8Array);
      expect(actual).toHaveLength(4);
    });
    expect(events).toEqual(["bytes"]);
  });
});
