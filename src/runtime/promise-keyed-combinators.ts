// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6492 round 5) `Promise.allKeyed` / `Promise.allSettledKeyed` — the
// await-dictionary proposal, implemented here because no engine ships them.
//
// WHY THIS IS A RUNTIME POLYFILL AND NOT A PARITY PATCH. Four of these rows
// sat in the honest-pass/linked-fail long tail, which reads like a linked-lane
// seam bug. It is not. `allKeyed` routes to the HOST `Promise` object
// (`HOST_PROMISE_SOURCE_METHOD_NAMES` in `codegen/declarations/import-collector.ts`),
// and on the container's Node it is simply `undefined` — so
// `Promise.allKeyed({…})` throws `TypeError: allKeyed is not a function`
// SYNCHRONOUSLY in both lanes. The honest lane "passed" only because its
// whole-assembly lowering wraps the test's callback in a
// try→`Promise_resolve` / catch→`Promise_reject` closure, which turns that
// unrelated TypeError into a rejection that `assert.throwsAsync(TypeError, …)`
// happily accepts. Measured over the whole family before this landed: linked
// 2/89, honest 6/89 — the honest lane's extra four are accidental passes, so
// teaching the linked lane to agree with them would have manufactured
// agreement on a wrong answer (the #1288 lesson, one proposal over).
//
// Semantics follow `PerformPromiseAllKeyed` (esid: sec-performpromiseallkeyed):
//
//   1. allKeys = ? promises.[[OwnPropertyKeys]]()   ← a non-object throws here,
//      which is what makes `Promise.allKeyed(1)` REJECT rather than throw
//   2. per key: desc = ? [[GetOwnProperty]]; skip unless desc is not undefined
//      and desc.[[Enumerable]] is true  ← the Get is NOT performed for a
//      non-enumerable key (`get-value-not-called-for-non-enumerable.js`)
//   3. value = ? Get(promises, key)
//   4. nextPromise = ? Call(promiseResolve, C, « value »)
//   5. ? Invoke(nextPromise, "then", « onFulfilled[, onRejected] »)
//
// and the result is `CreateKeyedPromiseCombinatorResultObject`: an ordinary
// object with a NULL prototype whose properties are created with
// CreateDataPropertyOrThrow (writable / enumerable / configurable), in the
// order the keys were accepted.
//
// Everything abrupt inside `PerformPromiseAllKeyed` is caught by
// IfAbruptRejectPromise and rejects the capability — that is the difference
// between `ownkeys-throws.js` (rejects) and a naive implementation (throws).

/** The `remainingElementsCount` record of the spec algorithm. */
interface RemainingCount {
  value: number;
}

type AnyFn = (...args: any[]) => any;

/** §7.3.x GetPromiseResolve(C) — `Get(C, "resolve")`, must be callable. */
function getPromiseResolve(C: any): AnyFn {
  const promiseResolve = C.resolve;
  if (typeof promiseResolve !== "function") {
    throw new TypeError("Promise resolve is not a function");
  }
  return promiseResolve as AnyFn;
}

/**
 * CreateKeyedPromiseCombinatorResultObject(keys, values) — a NULL-prototype
 * ordinary object. `Object.create(null)` plus CreateDataPropertyOrThrow
 * semantics; `result.hasOwnProperty` must be `undefined`, which is exactly what
 * the null prototype buys (`resolves-empty-object.js`).
 */
function createKeyedResultObject(keys: readonly PropertyKey[], values: readonly any[]): any {
  const result = Object.create(null);
  for (let i = 0; i < keys.length; i++) {
    Object.defineProperty(result, keys[i]!, {
      value: values[i],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}

/**
 * Pin a resolve-element function's own `length` / `name`, which test262 checks
 * directly (`resolve-element-function-properties.js`,
 * `element-function-properties.js`): length 1 and name "", both
 * non-writable / non-enumerable / configurable.
 */
function asElementFunction(fn: AnyFn): AnyFn {
  Object.defineProperty(fn, "length", {
    value: 1,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(fn, "name", {
    value: "",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  return fn;
}

/** Settle the capability once `remaining` reaches zero. */
function finishIfDone(
  remaining: RemainingCount,
  keys: readonly PropertyKey[],
  values: readonly any[],
  resolve: AnyFn,
): void {
  remaining.value -= 1;
  if (remaining.value === 0) {
    resolve(undefined, createKeyedResultObject(keys, values));
  }
}

/**
 * The shared body of both combinators. `settled` selects the
 * `allSettledKeyed` element wrapping (`{status, value}` / `{status, reason}`)
 * and, with it, whether a rejection settles an ELEMENT or the whole result.
 */
function performPromiseAllKeyed(
  settled: boolean,
  promises: any,
  C: any,
  capability: { promise: any; resolve: AnyFn; reject: AnyFn },
  promiseResolve: AnyFn,
): any {
  // Step 1 — a non-object argument throws here, and the caller turns that into
  // a rejection. `Reflect.ownKeys` is the [[OwnPropertyKeys]] spelling that
  // does NOT coerce.
  const allKeys = Reflect.ownKeys(promises);
  const keys: PropertyKey[] = [];
  const values: any[] = [];
  const remaining: RemainingCount = { value: 1 };

  for (const key of allKeys) {
    const desc = Object.getOwnPropertyDescriptor(promises, key);
    // A missing descriptor or a non-enumerable one is skipped BEFORE the Get —
    // observable, and asserted by `get-value-not-called-for-non-enumerable.js`
    // and `getownproperty-returns-undefined.js`.
    if (desc === undefined || desc.enumerable !== true) continue;
    const value = promises[key];
    const index = keys.length;
    keys.push(key);
    values.push(undefined);

    const nextPromise = promiseResolve.call(C, value);
    remaining.value += 1;

    let alreadyCalled = false;
    const onFulfilled = asElementFunction((x: any): any => {
      if (alreadyCalled) return undefined;
      alreadyCalled = true;
      values[index] = settled ? { status: "fulfilled", value: x } : x;
      finishIfDone(remaining, keys, values, capability.resolve);
      return undefined;
    });

    if (settled) {
      const onRejected = asElementFunction((r: any): any => {
        if (alreadyCalled) return undefined;
        alreadyCalled = true;
        values[index] = { status: "rejected", reason: r };
        finishIfDone(remaining, keys, values, capability.resolve);
        return undefined;
      });
      nextPromise.then(onFulfilled, onRejected);
    } else {
      // §: a single rejection rejects the whole result, via the capability's
      // own reject function (not a fresh wrapper — `reject-*.js` observe it).
      nextPromise.then(onFulfilled, capability.reject);
    }
  }

  finishIfDone(remaining, keys, values, capability.resolve);
  return capability.promise;
}

/**
 * Install `allKeyed` / `allSettledKeyed` on `PromiseCtor` when the host does
 * not already provide them. Never overwrites a native implementation.
 */
export function _installPromiseKeyedCombinators(PromiseCtor: any): void {
  if (PromiseCtor == null || typeof PromiseCtor !== "function") return;
  for (const [name, settled] of [
    ["allKeyed", false],
    ["allSettledKeyed", true],
  ] as const) {
    if (typeof PromiseCtor[name] === "function") continue;
    const method = function (this: any, promises: any): any {
      // `this` IS the spec's `C`. Half the family calls
      // `Promise.allKeyed.call(Constructor, …)`, so the receiver must stay
      // dynamic rather than closing over `PromiseCtor`, and the nested element
      // functions capture this alias — it is not a useless one.
      // biome-ignore lint/complexity/noUselessThisAlias: the nested element functions capture it.
      const C: any = this;
      if (C == null || (typeof C !== "object" && typeof C !== "function")) {
        throw new TypeError(`Promise.${name} called on a non-object`);
      }
      // NewPromiseCapability(C) — abrupt here propagates (it is NOT inside the
      // IfAbruptRejectPromise window): `capability-executor-not-callable.js`
      // and `ctx-ctor-throws.js` both expect a synchronous throw.
      let resolveFn: AnyFn | undefined;
      let rejectFn: AnyFn | undefined;
      const promise = new C((res: AnyFn, rej: AnyFn) => {
        if (resolveFn !== undefined || rejectFn !== undefined) {
          throw new TypeError("Promise capability already settled");
        }
        resolveFn = res;
        rejectFn = rej;
      });
      if (typeof resolveFn !== "function" || typeof rejectFn !== "function") {
        throw new TypeError("Promise capability functions are not callable");
      }
      const capability = {
        promise,
        resolve: (_t: any, v: any) => (resolveFn as AnyFn)(v),
        reject: (r: any) => (rejectFn as AnyFn)(r),
      };
      // From here on every abrupt completion REJECTS instead of throwing
      // (IfAbruptRejectPromise), which is the whole point of the
      // `*-reject.js` half of the family.
      try {
        const promiseResolve = getPromiseResolve(C);
        return performPromiseAllKeyed(settled, promises, C, capability, promiseResolve);
      } catch (error) {
        capability.reject(error);
        return promise;
      }
    };
    Object.defineProperty(method, "length", {
      value: 1,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(method, "name", {
      value: name,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(PromiseCtor, name, {
      value: method,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}
