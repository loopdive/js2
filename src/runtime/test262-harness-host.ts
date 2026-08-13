// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4394) Host-side support for a compiled module that DECLARES its own
 * `function Test262Error` — which the literal upstream harness always does
 * (`sta.js`), i.e. every assembled test262 module.
 *
 * The constructed value has to stay a real host `Error` subclass: the exception
 * bridge, the failure renderer and every `String(err)` / `.stack` path depend
 * on it. But that means its prototype chain can never reach the module's own
 * compiled WasmGC closure, so both identity questions the harness actually asks
 * — `err.constructor === Test262Error` and `err instanceof Test262Error` —
 * answered `false` for an error that plainly is one.
 *
 * Both are closed here by recording the module's carrier, and nothing wider: an
 * unrelated compiled closure is not in the carrier set, and a value that is not
 * a host Test262Error is still decided by the ordinary prototype walk.
 *
 * Lives outside `src/runtime.ts` on purpose — see #4395's host-import migration
 * ratchet, which holds that file and the eight owned adapters at a fixed size.
 * If this module should be counted by that ratchet, add it to `ownedAdapterPaths`
 * in `scripts/check-host-import-policy.ts`.
 */

/**
 * The single host-side `Test262Error` class behind every `new Test262Error(msg)`
 * lowering. It is hoisted to module scope so that the `__new_Test262Error_ctor`
 * builtin and the generic `extern_class` arm mint instances of the SAME class —
 * previously a fresh class was minted per resolver call, so `err.constructor`
 * identity depended on which import a given module happened to bind.
 */
export class HostTest262Error extends Error {
  constructor(msg?: string) {
    super(msg);
    this.name = "Test262Error";
  }
}

/** Every module-declared carrier that has constructed through the builtin. */
const moduleCarriers = new WeakSet<object>();

/** True for a value minted by this module's class. */
export function isHostTest262Error(value: unknown): boolean {
  return value instanceof HostTest262Error;
}

/**
 * `__new_Test262Error_ctor(msg, ctor)`. §10.2.2 says the constructed object's
 * `constructor` is the function that was invoked, so the module's own closure
 * is stamped on as a non-enumerable own property — exactly what `assert.throws`
 * and the harness self-tests compare against.
 */
export function makeTest262ErrorWithModuleCtor(msg: unknown, ctor: unknown): Error {
  const err = new HostTest262Error(msg == null ? undefined : String(msg));
  if (ctor == null) return err;
  if (typeof ctor === "object" || typeof ctor === "function") {
    try {
      moduleCarriers.add(ctor as object);
    } catch {
      /* a non-weakly-holdable carrier simply keeps the old answer */
    }
  }
  try {
    Object.defineProperty(err, "constructor", {
      value: ctor,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    /* a frozen Error prototype chain is not worth failing construction over */
  }
  return err;
}

/**
 * `value instanceof rawTarget` where `rawTarget` is the module's own carrier.
 * Both halves are required, so an unrelated compiled constructor never starts
 * matching.
 */
export function isModuleTest262ErrorInstance(value: unknown, rawTarget: unknown): boolean {
  if (!(value instanceof HostTest262Error) || rawTarget === null) return false;
  if (typeof rawTarget !== "object" && typeof rawTarget !== "function") return false;
  return moduleCarriers.has(rawTarget as object);
}
