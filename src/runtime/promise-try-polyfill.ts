// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * #6440 — `Promise.try` polyfill for hosts below the engine that ships it.
 *
 * The JS-host codegen lane lowers a compiled `Promise.try(fn)` call straight
 * onto the host's `Promise.try` (see `resolveImport`'s generic
 * `__extern_method_call` arm in `src/runtime.ts`). `Promise.try` landed in
 * V8 13.x / Node 23; `package.json` declares `engines: { node: ">=20" }`, so
 * on Node 20/22 the lowered call throws `TypeError: Promise.try is not a
 * function` at runtime with no compile-time signal (#6440, residual of
 * #6419 arm 7).
 *
 * Decision (of the three options the issue lays out): **polyfill it**, not
 * raise the floor or refuse at compile time. Raising `engines` to `>=23`
 * would drop two still-supported Node LTS lines for the sake of one method;
 * refusing at compile time can't know what host the emitted module will
 * eventually run on (the same binary may run on Node 22 today and Node 24
 * tomorrow). A polyfill installed only when the intrinsic is missing keeps
 * both the declared floor and the emitted `Promise.try` call working, with
 * zero effect on hosts (CI's Node 24/25 included) that already have it. This
 * mirrors the existing `_installIteratorHelperPolyfills` (#1464) precedent of
 * ambiently patching a global constructor from the host-lane runtime.
 */

/**
 * The distinct Promise constructor(s) `Promise.try` should be checked/
 * installed on for a given `node:vm` sandbox realm (or none, for the plain
 * host-realm case): the real global `Promise`, plus the sandbox's own
 * `Promise` when it differs (they are distinct constructors under a `vm`
 * context — the real global is otherwise never mutated for a sandboxed run).
 */
export function _promiseTryTargets(globalSandbox: Record<string, any> | undefined): unknown[] {
  return [Promise, globalSandbox?.Promise].filter((C, i, arr) => C != null && arr.indexOf(C) === i);
}

/**
 * Install `Promise.try` (per spec §27.2.4.8, "PerformPromiseTry") on `C` if
 * it is missing. No-op when `C` is not a constructor, or already has `try`
 * (idempotent, and never overwrites a host- or test-supplied implementation).
 */
export function _installPromiseTryPolyfill(C: unknown): void {
  if (typeof C !== "function") return;
  if (typeof (C as { try?: unknown }).try === "function") return;

  function promiseTryPolyfill(this: unknown, callbackfn: (...args: unknown[]) => unknown, ...args: unknown[]) {
    if (this == null || (typeof this !== "object" && typeof this !== "function")) {
      throw new TypeError("Promise.try called on incompatible receiver");
    }
    // NewPromiseCapability(C) — `this` may be a subclass (`Promise.try.call(SubPromise, …)`),
    // so the subclass constructor body runs exactly once via `super(executor)`
    // (mirrors #2637 B2's run-on-host-`this` ctor wiring for the other combinators).
    let resolve!: (value?: unknown) => void;
    let reject!: (reason?: unknown) => void;
    const promise = Reflect.construct(this as new (executor: unknown) => unknown, [
      (res: (value?: unknown) => void, rej: (reason?: unknown) => void) => {
        resolve = res;
        reject = rej;
      },
    ]);
    try {
      resolve(callbackfn.apply(undefined, args));
    } catch (e) {
      reject(e);
    }
    return promise;
  }
  Object.defineProperty(promiseTryPolyfill, "name", { value: "try", configurable: true });
  Object.defineProperty(promiseTryPolyfill, "length", { value: 1, configurable: true });

  Object.defineProperty(C, "try", {
    value: promiseTryPolyfill,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}
