// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { objectRealmBodyRuntime, type RealmBodyName } from "./helpers/ir-object-realm-body-controls.js";
import { buildObjectPrototypeMethodDefinition } from "../src/runtime/wasmgc/values/object-prototype-method-bodies.js";
import { buildObjectPrototypeAccessorDefinition } from "../src/runtime/wasmgc/values/object-prototype-accessor-bodies.js";
import { buildObjectConstructorDefinition } from "../src/runtime/wasmgc/values/object-constructor-body.js";

const protoDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__")!;
function native(name: RealmBodyName, receiver: unknown, ...args: unknown[]): unknown {
  if (name === "Object")
    return args[0] === undefined
      ? Object(receiver)
      : Reflect.construct(Object, [receiver], args[0] as new () => object);
  const fn =
    name === "get __proto__"
      ? protoDescriptor.get
      : name === "set __proto__"
        ? protoDescriptor.set
        : Reflect.get(Object.prototype, name);
  return Reflect.apply(fn!, receiver, args);
}
const primitives = [true, false, 0, -0, NaN, Infinity, 7n, "abc", "", Symbol("s")] as const;
const nullish = [null, undefined] as const;
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected abrupt completion");
}

for (const displaced of [false, true])
  describe(`Object realm Wasm algorithms, displaced=${displaced}`, () => {
    let fixture: ReturnType<typeof objectRealmBodyRuntime>;
    beforeAll(() => {
      fixture = objectRealmBodyRuntime(displaced);
    });
    const api = (trace?: string[], overrides?: Parameters<typeof fixture.instantiate>[1]) =>
      fixture.instantiate(trace, overrides);
    const prototypeCheck = (receiver: unknown, value: unknown, trace?: string[]) => {
      const { isPrototypeOf: run } = api(trace);
      return run(receiver, value);
    };

    for (const value of primitives) {
      const label = Object.is(value, -0) ? "-0" : String(value);
      it(`valueOf creates a real primitive wrapper for ${label}:${typeof value}`, () => {
        const result = api().valueOf(value) as object;
        const expected = native("valueOf", value) as object;
        expect(typeof result).toBe("object");
        expect(Object.getPrototypeOf(result)).toBe(Object.getPrototypeOf(expected));
        expect(Reflect.apply(Reflect.get(result, "valueOf"), result, [])).toBe(value);
        expect(Reflect.ownKeys(result)).toEqual(Reflect.ownKeys(expected));
      });
      it(`Object call/construct boxes ${label}:${typeof value}`, () => {
        for (const target of [undefined, Object]) {
          const result = api().Object(value, target) as object;
          const expected = native("Object", value, target) as object;
          expect(Object.getPrototypeOf(result)).toBe(Object.getPrototypeOf(expected));
          expect(Reflect.apply(Reflect.get(result, "valueOf"), result, [])).toBe(value);
        }
      });
      it(`primitive isPrototypeOf argument short-circuits nullish this for ${label}:${typeof value}`, () => {
        for (const receiver of nullish) {
          const trace: string[] = [];
          expect(prototypeCheck(receiver, value, trace)).toBe(native("isPrototypeOf", receiver, value));
          expect(trace).toEqual(["isObject", "booleanValue"]);
        }
      });
      it(`__proto__ primitive receiver is ignored for ${label}:${typeof value}`, () => {
        const trace: string[] = [];
        expect(api(trace)["set __proto__"](value, {})).toBe(native("set __proto__", value, {}));
        expect(trace).not.toContain("toObject");
        expect(trace).not.toContain("setPrototypeOf");
        expect(api()["get __proto__"](value)).toBe(native("get __proto__", value));
      });
    }
    for (const receiver of nullish) {
      for (const name of [
        "valueOf",
        "toLocaleString",
        "get __proto__",
        "set __proto__",
        "__defineGetter__",
        "__lookupGetter__",
      ] as const)
        it(`${name} rejects nullish receiver ${String(receiver)}`, () => {
          expect(() => api()[name](receiver, "x", () => 1)).toThrow(TypeError);
          expect(() => native(name, receiver, "x", () => 1)).toThrow(TypeError);
        });
      it(`Object creates distinct extensible ordinary instances for ${String(receiver)}`, () => {
        const f = api().Object,
          first = f(receiver, undefined) as object,
          second = f(receiver, Object) as object;
        expect(first).not.toBe(second);
        for (const object of [first, second]) {
          expect(Object.getPrototypeOf(object)).toBe(Object.prototype);
          expect(Object.isExtensible(object)).toBe(true);
          expect(Reflect.ownKeys(object)).toEqual([]);
        }
      });
    }
    for (const method of ["hasOwnProperty", "propertyIsEnumerable"] as const) {
      it(`${method} reads own descriptors without invoking getters or inherited entries`, () => {
        const symbol = Symbol("key"),
          proto = { inherited: 1 },
          object = Object.create(proto);
        Object.defineProperties(object, {
          hidden: { value: 3 },
          getter: {
            get() {
              throw 91;
            },
            enumerable: true,
          },
        });
        object[symbol] = 4;
        for (const key of ["hidden", "getter", "inherited", "missing", symbol])
          expect(api()[method](object, key)).toBe(native(method, object, key));
      });
      it(`${method} converts key before ToObject, even for nullish this`, () => {
        const events: string[] = [],
          marker = {};
        const key = {
          [Symbol.toPrimitive](hint: string) {
            events.push(hint);
            throw marker;
          },
        };
        const trace: string[] = [];
        expect(thrown(() => api(trace)[method](null, key))).toBe(marker);
        expect(trace).toEqual(["toPropertyKey"]);
        expect(events).toEqual(["string"]);
        expect(thrown(() => native(method, null, key))).toBe(marker);
      });
      it(`${method} propagates proxy descriptor failures unchanged`, () => {
        const marker = {},
          object = new Proxy(
            {},
            {
              getOwnPropertyDescriptor() {
                throw marker;
              },
            },
          );
        expect(thrown(() => api()[method](object, "x"))).toBe(marker);
        expect(thrown(() => native(method, object, "x"))).toBe(marker);
      });
      it(`${method} handles primitive String index and length descriptors`, () => {
        for (const key of [0, "0", "length", "1", "2", Symbol.iterator])
          expect(api()[method]("ab", key)).toBe(native(method, "ab", key));
      });
    }
    it("valueOf and Object preserve object identity without coercion or prototype reads", () => {
      const object = new Proxy(
        {},
        {
          get() {
            throw 91;
          },
          getPrototypeOf() {
            throw 92;
          },
        },
      );
      expect(api().valueOf(object)).toBe(object);
      expect(api().Object(object, undefined)).toBe(object);
      expect(api().Object(object, Object)).toBe(object);
    });
    it("isPrototypeOf traverses actual links and does not compare the value itself", () => {
      const root = Object.create(null),
        middle = Object.create(root),
        child = Object.create(middle);
      for (const [receiver, value] of [
        [root, child],
        [middle, child],
        [child, child],
        [{}, child],
        [root, root],
      ])
        expect(prototypeCheck(receiver, value)).toBe(native("isPrototypeOf", receiver, value));
    });
    it("isPrototypeOf rejects nullish this before traversing an object argument", () => {
      const marker = {},
        object = new Proxy(
          {},
          {
            getPrototypeOf() {
              throw marker;
            },
          },
        );
      for (const receiver of nullish) {
        const trace: string[] = [];
        expect(() => prototypeCheck(receiver, object, trace)).toThrow(TypeError);
        expect(trace).toEqual(["isObject", "toObject"]);
        expect(() => native("isPrototypeOf", receiver, object)).toThrow(TypeError);
      }
    });
    it("isPrototypeOf handles callable object links and preserves proxy abrupt identity", () => {
      function fn() {}
      expect(prototypeCheck(Function.prototype, fn)).toBe(true);
      const marker = {},
        object = new Proxy(
          {},
          {
            getPrototypeOf() {
              throw marker;
            },
          },
        );
      expect(thrown(() => prototypeCheck({}, object))).toBe(marker);
      expect(thrown(() => native("isPrototypeOf", {}, object))).toBe(marker);
    });
    it("toLocaleString calls the current toString with original receiver and zero arguments", () => {
      const trace: unknown[] = [],
        result = {},
        object = {
          get toString() {
            trace.push("get");
            return function (this: unknown, ...args: unknown[]) {
              trace.push(this, args);
              return result;
            };
          },
        };
      expect(api().toLocaleString(object)).toBe(result);
      expect(trace).toEqual(["get", object, []]);
      trace.length = 0;
      expect(native("toLocaleString", object, "ignored", "ignored")).toBe(result);
      expect(trace).toEqual(["get", object, []]);
    });
    it("toLocaleString preserves strict primitive this through boxing during GetV", () => {
      const trace: string[] = [],
        calls: unknown[] = [];
      const f = api(trace, {
        get: ((object: unknown, key: unknown, receiver: unknown) => {
          expect(typeof object).toBe("object");
          expect(key).toBe("toString");
          expect(receiver).toBe(7);
          return function (this: unknown) {
            calls.push(this);
            return 81;
          };
        }) as never,
      });
      expect(f.toLocaleString(7)).toBe(81);
      expect(calls).toEqual([7]);
      expect(trace).toEqual(["toObject", "toStringKey", "get", "isCallable", "call0"]);
    });
    for (const kind of ["get", "call"] as const)
      it(`toLocaleString propagates ${kind} abrupt completion unchanged`, () => {
        const marker = {},
          object = {
            get toString() {
              if (kind === "get") throw marker;
              return () => {
                throw marker;
              };
            },
          };
        expect(thrown(() => api().toLocaleString(object))).toBe(marker);
        expect(thrown(() => native("toLocaleString", object))).toBe(marker);
      });
    for (const value of [undefined, null, 9, {}, class C {}])
      it(`toLocaleString rejects uncallable/call-refusing method ${String(value)}`, () => {
        const object = { toString: value };
        expect(() => api().toLocaleString(object)).toThrow(TypeError);
        expect(() => native("toLocaleString", object)).toThrow(TypeError);
      });

    for (const setter of [false, true]) {
      const define = setter ? "__defineSetter__" : "__defineGetter__",
        lookup = setter ? "__lookupSetter__" : "__lookupGetter__";
      const slot = setter ? "set" : "get";
      it(`${define} uses a partial descriptor and retains the opposite accessor`, () => {
        const other = () => {},
          fn = () => 31,
          key = Symbol("key"),
          objects = [{}, {}];
        for (const object of objects)
          Object.defineProperty(object, key, { [setter ? "get" : "set"]: other, configurable: true });
        expect(api()[define](objects[0], key, fn)).toBe(native(define, objects[1], key, fn));
        expect(Object.getOwnPropertyDescriptor(objects[0], key)).toEqual(
          Object.getOwnPropertyDescriptor(objects[1], key),
        );
        expect(Object.getOwnPropertyDescriptor(objects[0], key)).toMatchObject({
          [slot]: fn,
          enumerable: true,
          configurable: true,
        });
      });
      it(`${define} refuses noncallable before coercing key`, () => {
        const marker = {},
          key = {
            [Symbol.toPrimitive]() {
              throw marker;
            },
          },
          trace: string[] = [];
        expect(() => api(trace)[define]({}, key, {})).toThrow(TypeError);
        expect(trace).toEqual(["toObject", "isCallable", "throwTypeError"]);
        expect(() => native(define, {}, key, {})).toThrow(TypeError);
      });
      it(`${define} constructs descriptor before key and propagates coercion failure`, () => {
        const marker = {},
          key = {
            [Symbol.toPrimitive]() {
              throw marker;
            },
          },
          trace: string[] = [];
        expect(thrown(() => api(trace)[define]({}, key, () => {}))).toBe(marker);
        expect(trace).toEqual(["toObject", "isCallable", "makeAccessorDescriptor", "toPropertyKey"]);
      });
      it(`${define} treats classes and revoked callable proxies as callable without invoking them`, () => {
        const revoked = Proxy.revocable(() => 1, {});
        revoked.revoke();
        for (const fn of [class C {}, revoked.proxy]) {
          const object = {};
          expect(api()[define](object, "x", fn)).toBeUndefined();
          expect(Object.getOwnPropertyDescriptor(object, "x")?.[slot]).toBe(fn);
        }
      });
      it(`${define} handles internal false and abrupt define completion`, () => {
        const marker = {},
          object = new Proxy(
            {},
            {
              defineProperty() {
                throw marker;
              },
            },
          );
        expect(thrown(() => api()[define](object, "x", () => {}))).toBe(marker);
        expect(thrown(() => native(define, object, "x", () => {}))).toBe(marker);
        for (const receiver of [Object.preventExtensions({}), new Proxy({}, { defineProperty: () => false })]) {
          expect(() => api()[define](receiver, "x", () => {})).toThrow(TypeError);
          expect(() => native(define, receiver, "x", () => {})).toThrow(TypeError);
        }
      });
      it(`${lookup} finds inherited accessor without invoking it and stops at data shadow`, () => {
        const fn = () => {
            throw 91;
          },
          parent = Object.create(null),
          object = Object.create(parent);
        Object.defineProperty(parent, "x", { [slot]: fn, configurable: true });
        expect(api()[lookup](object, "x")).toBe(native(lookup, object, "x"));
        Object.defineProperty(object, "x", { value: 0 });
        expect(api()[lookup](object, "x")).toBeUndefined();
        expect(api()[lookup](object, "missing")).toBeUndefined();
      });
      it(`${lookup} returns absent accessor half without consulting the prototype`, () => {
        const object = new Proxy(Object.defineProperty({}, "x", { [setter ? "get" : "set"]: () => {} }), {
          getPrototypeOf() {
            throw 99;
          },
        });
        expect(api()[lookup](object, "x")).toBe(native(lookup, object, "x"));
      });
      it(`${lookup} performs ToObject before key conversion`, () => {
        const marker = {},
          key = {
            [Symbol.toPrimitive]() {
              throw marker;
            },
          },
          trace: string[] = [];
        expect(() => api(trace)[lookup](null, key)).toThrow(TypeError);
        expect(trace).toEqual(["toObject"]);
        expect(() => native(lookup, null, key)).toThrow(TypeError);
      });
      it(`${lookup} converts a valid receiver's key exactly once before walking`, () => {
        const fn = () => 41,
          parent = Object.defineProperty({}, "x", { [slot]: fn });
        const object = Object.create(parent),
          hints: string[] = [];
        const key = {
          [Symbol.toPrimitive](hint: string) {
            hints.push(hint);
            return "x";
          },
        };
        expect(api()[lookup](object, key)).toBe(fn);
        expect(hints).toEqual(["string"]);
        hints.length = 0;
        expect(native(lookup, object, key)).toBe(fn);
        expect(hints).toEqual(["string"]);
      });
      it(`${lookup} propagates key failure before descriptor or prototype reads`, () => {
        const marker = {},
          trace: string[] = [];
        const object = new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw 91;
            },
            getPrototypeOf() {
              throw 92;
            },
          },
        );
        const key = {
          [Symbol.toPrimitive]() {
            throw marker;
          },
        };
        expect(thrown(() => api(trace)[lookup](object, key))).toBe(marker);
        expect(trace).toEqual(["toObject", "toPropertyKey"]);
        expect(thrown(() => native(lookup, object, key))).toBe(marker);
      });
      for (const trap of ["getOwnPropertyDescriptor", "getPrototypeOf"] as const)
        it(`${lookup} propagates proxy ${trap} abrupt completion`, () => {
          const marker = {},
            object = new Proxy(
              {},
              {
                [trap]() {
                  throw marker;
                },
              },
            );
          expect(thrown(() => api()[lookup](object, "x"))).toBe(marker);
          expect(thrown(() => native(lookup, object, "x"))).toBe(marker);
        });
    }
    it("__proto__ setter validates nullish receiver before ignoring primitive proto", () => {
      const trace: string[] = [];
      expect(() => api(trace)["set __proto__"](null, 7)).toThrow(TypeError);
      expect(trace).toEqual(["requireObjectCoercible"]);
      const object = {},
        proto = Object.getPrototypeOf(object);
      expect(api()["set __proto__"](object, 7)).toBeUndefined();
      expect(Object.getPrototypeOf(object)).toBe(proto);
    });
    it("__proto__ sets actual prototype including null and rejects immutable/cyclic changes", () => {
      const object = {},
        proto = {};
      expect(api()["set __proto__"](object, proto)).toBeUndefined();
      expect(Object.getPrototypeOf(object)).toBe(proto);
      expect(api()["set __proto__"](object, null)).toBeUndefined();
      expect(Object.getPrototypeOf(object)).toBeNull();
      for (const [receiver, target] of [
        [Object.prototype, {}],
        [Object.preventExtensions({}), {}],
        [object, object],
      ]) {
        expect(() => api()["set __proto__"](receiver, target)).toThrow(TypeError);
        expect(() => native("set __proto__", receiver, target)).toThrow(TypeError);
      }
      expect(api()["set __proto__"](Object.prototype, null)).toBeUndefined();
    });
    it("__proto__ propagates get/set proxy abrupt completion and false status", () => {
      const marker = {},
        object = new Proxy(
          {},
          {
            getPrototypeOf() {
              throw marker;
            },
            setPrototypeOf() {
              throw marker;
            },
          },
        );
      expect(thrown(() => api()["get __proto__"](object))).toBe(marker);
      expect(thrown(() => api()["set __proto__"](object, {}))).toBe(marker);
      expect(() => api()["set __proto__"](new Proxy({}, { setPrototypeOf: () => false }), null)).toThrow(TypeError);
    });
    it("Object alternate NewTarget ignores value and uses actual subclass prototype", () => {
      class Sub extends Object {}
      const value = new Proxy(
          {},
          {
            get() {
              throw 91;
            },
          },
        ),
        trace: string[] = [];
      const result = api(trace).Object(value, Sub) as object;
      expect(Object.is(result, value)).toBe(false);
      expect(Object.getPrototypeOf(result)).toBe(Sub.prototype);
      expect(Reflect.ownKeys(result)).toEqual([]);
      expect(Object.isExtensible(result)).toBe(true);
      expect(trace).toEqual(["isUndefined", "activeFunction", "sameValue", "createFromConstructor"]);
    });
    it("Object compares NewTarget with the actual active function singleton", () => {
      function Active() {}
      const object = {},
        trace: string[] = [];
      const f = api(trace, { activeFunction: (() => Active) as never });
      expect(f.Object(object, Active)).toBe(object);
      expect(trace).toEqual(["isUndefined", "activeFunction", "sameValue", "isUndefined", "isNull", "toObject"]);
      expect(trace).not.toContain("createFromConstructor");
    });
    it("Object subclass creation preserves prototype getter failure", () => {
      const marker = {},
        target = new Proxy(function Target() {}, {
          get(_object, key) {
            if (key === "prototype") throw marker;
            return undefined;
          },
        });
      expect(thrown(() => api().Object(7, target))).toBe(marker);
      expect(thrown(() => native("Object", 7, target))).toBe(marker);
    });
    it("Object subclass fallback uses NewTarget's realm", () => {
      const target = runInNewContext("(function Target(){})") as { prototype: unknown };
      target.prototype = null;
      const expected = native("Object", 9, target) as object,
        actual = api().Object(9, target) as object;
      expect(Object.getPrototypeOf(actual)).toBe(Object.getPrototypeOf(expected));
      expect(Object.getPrototypeOf(actual)).not.toBe(Object.prototype);
    });
    it("rejects missing bindings, missing operands and unknown methods before a body exists", () => {
      const bindings = { ...fixture.handles, toStringKey: fixture.operands.toStringKey };
      expect(() => buildObjectPrototypeMethodDefinition("valueOf", { ...bindings, toObject: -1 as never })).toThrow(
        "unresolved binding",
      );
      expect(() => buildObjectPrototypeMethodDefinition("valueOf", { ...bindings, toStringKey: [] })).toThrow(
        "unresolved toString key",
      );
      expect(() => buildObjectPrototypeMethodDefinition("bogus" as never, bindings)).toThrow("unknown method");
      expect(() =>
        buildObjectPrototypeAccessorDefinition("__lookupGetter__", {
          ...fixture.handles,
          getPrototypeOf: NaN as never,
        }),
      ).toThrow("unresolved binding");
      expect(() => buildObjectPrototypeAccessorDefinition("bogus" as never, fixture.handles)).toThrow("unknown method");
      expect(() => buildObjectConstructorDefinition({ ...fixture.handles, activeFunction: [] })).toThrow(
        "unresolved active function",
      );
      expect(() =>
        buildObjectConstructorDefinition({
          ...fixture.handles,
          activeFunction: fixture.operands.activeFunction,
          createFromConstructor: undefined as never,
        }),
      ).toThrow("unresolved binding");
    });
  });
