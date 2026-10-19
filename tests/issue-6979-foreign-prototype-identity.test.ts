// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

describe("#6979 ordinary membership over JS-owned prototype identities", () => {
  let result: CompileResult;
  let identity: (left: unknown, right: unknown) => number;
  let probe: (value: unknown) => number;
  let native: unknown;
  let ex: {
    check: (value: unknown, ctor: unknown) => number;
    echo: (value: unknown) => unknown;
    proto: (value: unknown) => unknown;
  };
  beforeAll(async () => {
    result = await compile(
      `
      export function check(value: any, ctor: any): number { return value instanceof ctor ? 1 : 0; }
      export function echo(value: any): any { return value; }
      export function proto(value: any): any { return Object.getPrototypeOf(value); }
      export function native(): any { return { marker: 42 }; }
    `,
      { trackIrOutcomes: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(result.irOutcomes?.find((row) => row.displayName === "check")).toMatchObject({
      kind: "emitted",
      directBodyEmissions: 0,
      irBodyEmissions: 1,
      legacyBodyEmitted: false,
    });
    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    ex = wrapCompiledExports(result, instance) as typeof ex;
    identity = imports.env.__boundary_object_same_identity as typeof identity;
    probe = instance.exports.__dynamic_boundary_is_gc as typeof probe;
    native = (instance.exports.native as () => unknown)();
  });

  it.each([null, undefined])("walks ordinary foreign prototypes with an own %s handler", (handler) => {
    class Foreign {}
    Object.defineProperty(Foreign, Symbol.hasInstance, { value: handler });
    const direct = new Foreign();
    expect(ex.echo(direct)).toBe(direct);
    expect(ex.echo(Foreign)).toBe(Foreign);
    expect(ex.check(direct, Foreign)).toBe(1);
    expect(ex.check(Object.create(direct), Foreign)).toBe(1);
    expect(ex.check({}, Foreign)).toBe(0);
    expect(ex.check(Foreign.prototype, Foreign)).toBe(0);
    expect(ex.check(2, Foreign)).toBe(0);
  });

  it("reads the constructor prototype directly without a descriptor probe", () => {
    class Foreign {}
    Object.defineProperty(Foreign, Symbol.hasInstance, { value: null });
    const events: PropertyKey[] = [];
    const ctor = new Proxy(Foreign, {
      get(target, key, receiver) {
        events.push(key);
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor() {
        throw Error("unexpected descriptor probe");
      },
    });
    expect(ex.check(new Foreign(), ctor)).toBe(1);
    expect(events).toEqual([Symbol.hasInstance, "prototype"]);
  });

  it("observes live constructor prototype replacement without copying either side", () => {
    // biome-ignore lint/complexity/useArrowFunction: ordinary constructor with a writable prototype is required.
    function Foreign() {}
    Object.defineProperty(Foreign, Symbol.hasInstance, { value: undefined });
    const first = Foreign.prototype;
    const original = Object.create(first);
    expect(ex.check(original, Foreign)).toBe(1);
    const second = {};
    Foreign.prototype = second;
    expect(ex.check(original, Foreign)).toBe(0);
    expect(ex.check(Object.create(second), Foreign)).toBe(1);
    expect(ex.echo(first)).toBe(first);
    expect(ex.echo(second)).toBe(second);
  });

  it("preserves Proxy prototype-trap order and does not compare the candidate itself", () => {
    class Foreign {}
    Object.defineProperty(Foreign, Symbol.hasInstance, { value: null });
    const events: string[] = [];
    const middle = new Proxy(
      {},
      {
        getPrototypeOf() {
          events.push("middle");
          return Foreign.prototype;
        },
      },
    );
    const value = new Proxy(
      {},
      {
        getPrototypeOf() {
          events.push("value");
          return middle;
        },
      },
    );
    expect(ex.check(value, Foreign)).toBe(1);
    expect(events).toEqual(["value", "middle"]);
    events.length = 0;
    expect(ex.check(Foreign.prototype, Foreign)).toBe(0);
    expect(events).toEqual([]);
  });

  it("keeps the null chain terminal null and reads it only once", () => {
    class Foreign {}
    Object.defineProperty(Foreign, Symbol.hasInstance, { value: null });
    let calls = 0;
    const value = new Proxy(
      {},
      {
        getPrototypeOf() {
          calls++;
          return null;
        },
      },
    );
    expect(ex.check(value, Foreign)).toBe(0);
    expect(calls).toBe(1);
    expect(ex.proto(value)).toBe(null);
    expect(calls).toBe(2);
  });

  it("propagates original prototype-get exceptions", () => {
    class Foreign {}
    Object.defineProperty(Foreign, Symbol.hasInstance, { value: undefined });
    const failure = {};
    const value = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw failure;
        },
      },
    );
    let received: unknown;
    try {
      ex.check(value, Foreign);
    } catch (error) {
      received = error;
    }
    expect(received).toBe(failure);
  });

  it("does not silently truncate a finite chain beyond the old hop limit", () => {
    class Foreign {}
    Object.defineProperty(Foreign, Symbol.hasInstance, { value: null });
    let value = Foreign.prototype;
    for (let i = 0; i < 10005; i++) value = Object.create(value);
    expect(ex.check(value, Foreign)).toBe(1);
  });

  it("uses a classified object-identity adapter, not a host semantic operator", () => {
    expect(result.hostImportInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "__boundary_object_same_identity",
          classification: "value-adapter",
          family: "boundary-object",
        }),
      ]),
    );
    expect(
      result.hostImportInventory?.filter(
        (row) => row.classification === "legacy-semantic" || row.classification === "unknown",
      ),
    ).toEqual([]);
    expect(result.imports.some((row) => /__host_eq|__instanceof_check/.test(row.name))).toBe(false);
  });

  it("keeps identity admission instance-scoped and never admits native GC values", async () => {
    const value = {};
    expect(identity(value, value)).toBe(0);
    expect(ex.echo(value)).toBe(value);
    expect(identity(value, value)).toBe(1);
    expect(identity(value, {})).toBe(0);
    expect(probe(native)).toBe(1);
    expect(identity(native, native)).toBe(0);
    const view = ex.echo(native);
    expect(view).toMatchObject({ marker: 42 });
    expect(ex.echo(view)).toBe(view);
    expect(identity(native, native)).toBe(0);
    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    const otherIdentity = imports.env.__boundary_object_same_identity as typeof identity;
    expect(otherIdentity(value, value)).toBe(0);
    const other = wrapCompiledExports(result, instance) as typeof ex;
    expect(other.echo(value)).toBe(value);
    expect(otherIdentity(value, value)).toBe(1);
  });

  it("classifies and echoes adversarial/revoked JS Proxies without inspecting them", () => {
    const failure = {};
    const value = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw failure;
        },
        get() {
          throw failure;
        },
        isExtensible() {
          throw failure;
        },
        set() {
          throw failure;
        },
        deleteProperty() {
          throw failure;
        },
      },
    );
    expect(probe(value)).toBe(0);
    expect(ex.echo(value)).toBe(value);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(probe(revoked.proxy)).toBe(0);
    expect(ex.echo(revoked.proxy)).toBe(revoked.proxy);
    const frozen = Object.freeze(Object.create(null));
    expect(ex.echo(frozen)).toBe(frozen);
  });

  it.each([null, undefined, Symbol("prototype"), 7, false, "prototype", 7n])(
    "throws for non-object foreign prototype %s",
    (prototype) => {
      // biome-ignore lint/complexity/useArrowFunction: a writable constructor prototype is required.
      function Foreign() {}
      Foreign.prototype = prototype;
      Object.defineProperty(Foreign, Symbol.hasInstance, { value: null });
      expect(() => ex.check({}, Foreign)).toThrow(TypeError);
    },
  );

  it("returns false for a primitive LHS before reading a throwing prototype", () => {
    // biome-ignore lint/complexity/useArrowFunction: a constructible callable is required.
    function Foreign() {}
    Object.defineProperty(Foreign, Symbol.hasInstance, { value: null });
    const events: PropertyKey[] = [];
    const ctor = new Proxy(Foreign, {
      get(target, key, receiver) {
        events.push(key);
        if (key === "prototype") throw Error("prototype should not be read");
        return Reflect.get(target, key, receiver);
      },
    });
    expect(ex.check(7, ctor)).toBe(0);
    expect(events).toEqual([Symbol.hasInstance]);
  });
});
