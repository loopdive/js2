// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Direct public-API unit contracts. Injected conversion services do not establish
// compiler carrier provenance, full IR equivalence or parent #5748 acceptance.
import { randomUUID, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createBoundaryObjectAdapter,
  type BoundaryObjectAdapterContext,
  type BoundaryObjectOperation,
} from "../src/runtime/boundary-object-adapter.js";
import {
  resolvePlatformCapabilityImport,
  type PlatformCapabilityAdapterContext,
} from "../src/runtime/platform-capability-adapter.js";

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

// (#6979 S7-b) The "compatibility operator dispatch" and "semantic intent
// classification" contracts covered the host_* / string_literal / await /
// proxy_create compatibility providers, deleted with the host-semantic lane.
// `resolveCompatibilitySemanticImport` now binds only the `date` accelerator.

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
