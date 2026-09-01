// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4376 — Deno publishes its infrastructure object through a captured
 * Object.assign primordial in one script, then extracts callback values from
 * that global object in a later script. Keep both the dynamic property carrier
 * and the destructured callable alive across the compileMulti boundary.
 */
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

describe("#4376 — Deno infra cross-source destructuring", () => {
  it("calls a callback destructured from Object.assign-published global infrastructure", async () => {
    const result = await compileMulti(
      {
        "./primordials.js": `
          ((window) => {
            const primordials = {};
            const {
              defineProperty: ReflectDefineProperty,
              getOwnPropertyDescriptor: ReflectGetOwnPropertyDescriptor,
            } = Reflect;
            const { apply, bind, call } = Function.prototype;
            const uncurryThis = bind.bind(call);
            const applyBind = bind.bind(apply);
            const varargsMethods = [];
            function getNewKey(key) {
              return typeof key === "symbol"
                ? "Symbol" + key.description[7].toUpperCase() + key.description.slice(8)
                : key[0].toUpperCase() + key.slice(1);
            }
            function copyPropsRenamed(src, dest, prefix) {
              for (const key of Reflect.ownKeys(src)) {
                const newKey = getNewKey(key);
                const descriptor = ReflectGetOwnPropertyDescriptor(src, key);
                ReflectDefineProperty(dest, prefix + newKey, descriptor);
              }
            }
            function copyPrototype(src, dest, prefix) {
              for (const key of Reflect.ownKeys(src)) {
                const newKey = getNewKey(key);
                const descriptor = ReflectGetOwnPropertyDescriptor(src, key);
                if ("get" in descriptor) continue;
                const { value } = descriptor;
                if (typeof value === "function") descriptor.value = uncurryThis(value);
                const name = prefix + newKey;
                ReflectDefineProperty(dest, name, descriptor);
                if (varargsMethods.includes(name)) {
                  ReflectDefineProperty(dest, name + "Apply", { value: applyBind(value) });
                }
              }
            }
            // Keep Object first so later primordial copies can expose any
            // finalization/index shift in the already-published ObjectAssign.
            [
              "Object",
              "AggregateError",
              "Array",
              "ArrayBuffer",
              "BigInt",
              "BigInt64Array",
              "BigUint64Array",
              "Boolean",
              "DataView",
              "Date",
              "Error",
              "EvalError",
              "FinalizationRegistry",
              "Float32Array",
              "Float64Array",
              "Function",
              "Int16Array",
              "Int32Array",
              "Int8Array",
              "Map",
              "Number",
              "RangeError",
              "ReferenceError",
              "RegExp",
              "Set",
              "String",
              "Symbol",
              "SyntaxError",
              "TypeError",
              "URIError",
              "Uint16Array",
              "Uint32Array",
              "Uint8Array",
              "Uint8ClampedArray",
              "WeakMap",
              "WeakRef",
              "WeakSet",
            ].forEach((name) => {
              const original = globalThis[name];
              primordials[name] = original;
              copyPropsRenamed(original, primordials, name);
              copyPrototype(original.prototype, primordials, name + "Prototype");
            });
            ["Proxy", "globalThis"].forEach((name) => {
              primordials[name] = globalThis[name];
            });
            primordials[isNaN.name] = isNaN;
            [decodeURI, decodeURIComponent, encodeURI, encodeURIComponent].forEach((fn) => {
              primordials[fn.name] = fn;
            });
            ["JSON", "Math", "Proxy", "Reflect"].forEach((name) => {
              copyPropsRenamed(globalThis[name], primordials, name);
            });
            const arrayIterator = {
              prototype: Reflect.getPrototypeOf(Array.prototype[Symbol.iterator]()),
            };
            primordials.ArrayIterator = arrayIterator;
            copyPrototype(arrayIterator, primordials, "ArrayIterator");
            copyPrototype(arrayIterator.prototype, primordials, "ArrayIteratorPrototype");
            const {
              ArrayPrototypeSymbolIterator,
              ArrayIteratorPrototypeNext,
              ArrayPrototypeForEach,
              FunctionPrototypeCall,
              ObjectSetPrototypeOf,
              ObjectFreeze,
              SymbolIterator,
            } = primordials;
            const createSafeIterator = (factory, next) => {
              class SafeIterator {
                constructor(iterable) {
                  this._iterator = factory(iterable);
                }
                next() {
                  return next(this._iterator);
                }
                [SymbolIterator]() {
                  return this;
                }
              }
              ObjectSetPrototypeOf(SafeIterator.prototype, null);
              ObjectFreeze(SafeIterator.prototype);
              ObjectFreeze(SafeIterator);
              return SafeIterator;
            };
            primordials.SafeArrayIterator = createSafeIterator(
              ArrayPrototypeSymbolIterator,
              ArrayIteratorPrototypeNext,
            );
            const copyProps = (src, dest) => {
              ArrayPrototypeForEach(Reflect.ownKeys(src), (key) => {
                if (!ReflectGetOwnPropertyDescriptor(dest, key)) {
                  ReflectDefineProperty(dest, key, ReflectGetOwnPropertyDescriptor(src, key));
                }
              });
            };
            const makeSafe = (unsafe, safe) => {
              if (SymbolIterator in unsafe.prototype) {
                const dummy = new unsafe();
                void dummy;
              }
              copyProps(unsafe, safe);
              ObjectSetPrototypeOf(safe.prototype, null);
              ObjectFreeze(safe.prototype);
              ObjectFreeze(safe);
              return safe;
            };
            primordials.makeSafe = makeSafe;
            primordials.indirectEval = eval;
            ObjectSetPrototypeOf(primordials, null);
            ObjectFreeze(primordials);
            const bootstrap: any = { primordials };
            const deno: any = {
              core: {
                ops: {
                  op_get_extras_binding_object() { return {}; },
                  op_timer_schedule() { return 0; },
                  op_leak_tracing_submit() { return 0; },
                },
                callConsole() { return undefined; },
              },
            };
            window.__bootstrap = bootstrap;
            window.Deno = deno;
          })(globalThis);
        `,
        "./infra.js": `
          ((window) => {
            const { ObjectAssign } = window.__bootstrap.primordials;
            function __resolvePromise() { return 1; }
            function __setLeakTracingEnabled() { return 2; }
            function __isLeakTracingEnabled() { return 42; }
            function __initializeCoreMethods() { return 4; }
            class FixedQueue { value() { return 5; } }
            const infra = {
              __resolvePromise,
              __setLeakTracingEnabled,
              __isLeakTracingEnabled,
              __initializeCoreMethods,
              FixedQueue,
            };
            const build = { target: "unknown", arch: "unknown" };
            const core = ObjectAssign(window.Deno.core, {
              build,
              __resolvePromise,
              __isLeakTracingEnabled,
            });
            const closedTarget = { a: 1 };
            const closedAssigned = ObjectAssign(closedTarget, { foo: 9, __foo: 40 });
            window.__assignProbe = closedAssigned.a * 100 + closedAssigned.foo + closedAssigned.__foo;
            // Keep the outer publication as a closed struct: an inline literal
            // passed straight to an any call is intentionally diverted to
            // the open-object carrier, which would not exercise this ABI.
            const infraPublication = { __infra: infra };
            ObjectAssign(globalThis, infraPublication);
            ObjectAssign(globalThis.__bootstrap, { core });
            ObjectAssign(globalThis.Deno, { core });
          })(globalThis);
        `,
        "./entry.js": `
          import "./primordials.js";
          import "./infra.js";
          ((window) => {
            const { __isLeakTracingEnabled } = window.__infra;
            const dynamicInfra: any = window.__infra;
            const dynamicKey = "__isLeakTracingEnabled";
            const dynamicLeakTracingEnabled = dynamicInfra[dynamicKey];
            window.__infraProbe =
              __isLeakTracingEnabled() + dynamicLeakTracingEnabled() +
              (typeof window.__bootstrap.core.__resolvePromise === "function" ? 1 : 0) +
              (window.Deno.core === window.__bootstrap.core ? 2 : 0) +
              window.__assignProbe;
          })(globalThis);
          export function probe() {
            return globalThis.__infraProbe;
          }
          export function forceRuntimeEvalBoundary() {
            return (0, eval)(globalThis.__runtimeEvalSource);
          }
        `,
      },
      "./entry.js",
      {
        allowJs: true,
        skipSemanticDiagnostics: true,
        target: "standalone",
        platform: "deno",
        deferTopLevelInit: true,
        externImportModule: "v8x:deno",
        link: ["v8x:deno"],
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module).map(({ module, name }) => `${module}::${name}`)).toContain(
      "js2wasm:runtime-eval::__runtime_indirect_eval",
    );
    const imports: Record<string, Record<string, () => null>> = {};
    for (const descriptor of WebAssembly.Module.imports(module)) {
      (imports[descriptor.module] ??= {})[descriptor.name] = () => null;
    }
    const instance = new WebAssembly.Instance(module, imports);
    (instance.exports.__module_init as () => void)();
    expect((instance.exports.probe as () => number)()).toBe(236);
  }, 120_000);

  it("keeps any-string indexing ahead of zero-length dynamic TypedArrays and rejects fractional view indexes", async () => {
    const result = await compileMulti(
      {
        "./reader.ts": `
          const value: any = "ok";
          export const first = value[0];
        `,
        "./entry.ts": `
          import { first } from "./reader.ts";
          export function probe() {
            const TA: any = Uint8Array;
            const empty = new TA();
            const one = new TA([9]);
            return empty.length * 10 + (first === "o" ? 1 : 0) + (one[0.5] === undefined ? 10 : 0);
          }
        `,
      },
      "./entry.ts",
      {
        allowJs: true,
        skipSemanticDiagnostics: true,
        target: "standalone",
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    const imports: Record<string, Record<string, () => null>> = {};
    for (const descriptor of WebAssembly.Module.imports(module)) {
      (imports[descriptor.module] ??= {})[descriptor.name] = () => null;
    }
    const instance = new WebAssembly.Instance(module, imports);
    expect((instance.exports.probe as () => number)()).toBe(11);
  }, 120_000);
});
