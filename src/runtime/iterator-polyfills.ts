// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Extracted verbatim from src/runtime.ts (#3103) — generator/iterator prototype
// machinery and ES2025 iterator-helper polyfills. Pure move, host-side only;
// emits zero Wasm. No logic change. The eight symbols still referenced by
// runtime.ts are re-exported at the bottom and imported back there.

/**
 * (#1516) Per-generator-instance state: `{buf, index, pendingThrow}`.
 *
 * Storing state in a WeakMap (keyed by the generator instance) instead of as
 * own closure-captured properties on the instance lets the prototype methods
 * `next`/`return`/`throw` be *shared* on `%GeneratorPrototype%` (spec
 * §27.5.1) and perform the GeneratorValidate this-value check (§27.5.3.2)
 * — `if (!_GeneratorState.has(this)) throw TypeError(...)`. The old
 * implementation attached own methods to every instance which made
 * `Generator.prototype.next.call(non_gen)` succeed (wrong).
 *
 * State shape:
 *   buf: any[]            — eager-yield buffer (filled by the generator body)
 *   index: number         — next read position in `buf`
 *   pendingThrow: any     — exception captured by the generator body, to be
 *                            re-thrown on the first `next()` after the
 *                            buffer is drained (#928)
 *   retVal: any           — the generator's `return` value (#2035). Per
 *                            §27.5.3.3 / §27.5.1.2 the return value belongs
 *                            ONLY to the terminal `{value, done:true}` result;
 *                            it must NOT appear as a yielded (`done:false`)
 *                            element. Surfaced once when the buffer drains.
 *   retDone: boolean      — `true` once the terminal `{retVal, done:true}`
 *                            result has been handed out, so subsequent
 *                            `next()` calls return `{value:undefined,done:true}`
 *   asyncWrap?: boolean   — `true` for async-generator state (so the same
 *                            map can back both `%GeneratorPrototype%` and
 *                            `%AsyncGeneratorPrototype%` methods)
 */
const _GeneratorState = new WeakMap<
  object,
  {
    buf: any[];
    index: number;
    pendingThrow: any;
    retVal?: any;
    retDone?: boolean;
    /** (#3032) LAZY thunk mode: the generator-expression closure (an opaque
     *  wasm externref) whose deferred invocation produces the buffer. Present
     *  only until the first `next()` (or cleared without running by
     *  `return`/`throw` on a not-yet-started generator — spec §27.5.3.2:
     *  resuming a suspendedStart generator abruptly completes it WITHOUT
     *  running the body). */
    thunk?: any;
    /** (#3032) Runs the thunk via the module's `__call_fn_0` export with the
     *  `__gen_set_eager` flag held, then adopts the inner eager generator's
     *  state. Captured at `__create_generator` time (needs `callbackState`). */
    materialize?: () => void;
  }
>();
const _AsyncGeneratorState = new WeakMap<
  object,
  { buf: any[]; index: number; pendingThrow: any; retVal?: any; retDone?: boolean }
>();

let _GeneratorPrototypeCache: any = null;
let _GeneratorFunctionPrototypeCache: any = null;
let _AsyncGeneratorPrototypeCache: any = null;
let _AsyncGeneratorFunctionPrototypeCache: any = null;
// (#1639) `genFn.prototype` — the per-function instance prototype. Per spec
// §27.3.4 / §27.4.4 it is `OrdinaryObjectCreate(%(Async)GeneratorPrototype%)`,
// one level below the shared `%(Async)GeneratorPrototype%`. Generator instances
// inherit from this object, so `Object.getPrototypeOf(instance) === genFn.prototype`.
let _GeneratorInstancePrototypeCache: any = null;
let _AsyncGeneratorInstancePrototypeCache: any = null;
let _IteratorPrototypeCache: any = null;
let _AsyncIteratorPrototypeCache: any = null;
// (#3049) Shared `%ArrayIteratorPrototype%` stand-in for iterators the
// `__iterator` host import SYNTHESIZES over compiled vec structs. §23.1.5.2:
// array iterators are ObjectCreate(%ArrayIteratorPrototype%), whose
// [[Prototype]] is %IteratorPrototype%. The old one-level chain made the
// spec-shaped walk `getPrototypeOf(getPrototypeOf([][Symbol.iterator]()))`
// (hardcoded by tests + the runner's `Iterator` shim) overshoot the
// helper-bearing proto onto Object.prototype → every
// `Iterator.prototype.<helper>` lookup was undefined. One SHARED cached
// middle object keeps getPrototypeOf identity stable across iterators.
let _SynthArrayIteratorPrototypeCache: any = null;

// Test262 runs sloppy and strict variants as separate realm-equivalent module
// instances. The host runtime normally keeps these synthetic intrinsics for
// the lifetime of the JS realm, which is correct for ordinary consumers but
// lets one variant's deliberate descriptor mutation leak into the next. Keep
// the original host Iterator descriptor so the harness can discard the
// synthetic realm without permanently changing a host that lacked Iterator.
const _InitialHostIteratorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Iterator");

/**
 * Drop compiler-owned iterator/generator intrinsic caches between isolated
 * harness realms. Existing generator objects keep their prototype objects;
 * only later `buildImports` calls allocate a fresh intrinsic graph.
 *
 * This is intentionally an explicit harness hook rather than an automatic
 * `buildImports` side effect: concurrently-live production instances share a
 * JS realm and must not have their intrinsics reset behind their backs.
 */
function _resetIteratorRuntimeIntrinsicsForRealmIsolation(): void {
  _GeneratorPrototypeCache = null;
  _GeneratorFunctionPrototypeCache = null;
  _AsyncGeneratorPrototypeCache = null;
  _AsyncGeneratorFunctionPrototypeCache = null;
  _GeneratorInstancePrototypeCache = null;
  _AsyncGeneratorInstancePrototypeCache = null;
  _IteratorPrototypeCache = null;
  _AsyncIteratorPrototypeCache = null;
  _SynthArrayIteratorPrototypeCache = null;
  _iteratorHelpersInstalled = false;

  try {
    if (_InitialHostIteratorDescriptor) {
      Object.defineProperty(globalThis, "Iterator", _InitialHostIteratorDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "Iterator");
    }
  } catch {
    // A test may have made the global non-configurable. The worker's existing
    // poison/recycle path handles that unrecoverable realm mutation.
  }
}
function _getSynthArrayIteratorPrototype(base: any): any {
  if (_SynthArrayIteratorPrototypeCache) return _SynthArrayIteratorPrototypeCache;
  const proto = Object.create(base ?? null);
  _SynthArrayIteratorPrototypeCache = proto;
  // §23.1.5.2.2 %ArrayIteratorPrototype% [ @@toStringTag ]
  Object.defineProperty(proto, Symbol.toStringTag, {
    value: "Array Iterator",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  return proto;
}

/**
 * Install a built-in method on a prototype with spec-mandated descriptor
 * flags. ES2024 §17 specifies that built-in function objects have:
 *   - `length`: { value: N, writable: false, enumerable: false, configurable: true }
 *   - `name`:   { value: "<name>", writable: false, enumerable: false, configurable: true }
 * and that built-in methods on a prototype are installed with
 *   { writable: true, enumerable: false, configurable: true }.
 */
function _installBuiltinMethod(
  proto: object,
  name: string,
  length: number,
  impl: (this: any, ...args: any[]) => any,
): void {
  // Re-assign `name`/`length` to match spec descriptors. We name the
  // function via `Object.defineProperty` so it doesn't appear as an
  // anonymous arrow in stack traces.
  Object.defineProperty(impl, "length", {
    value: length,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(impl, "name", {
    value: name,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(proto, name, {
    value: impl,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

/**
 * Install a static helper (e.g. `Iterator.zip`) with spec-correct property
 * descriptors. The function's own `length` and `name` are reset to the
 * spec-mandated values with attributes `{writable:false, enumerable:false,
 * configurable:true}` (§17 — built-in function `length`/`name`), and the
 * property on `target` itself is `{writable:true, enumerable:false,
 * configurable:true}` (§17 default data-property attributes). TS optional
 * params (`options?`) inflate `fn.length`, so we override it explicitly.
 */
function _installStaticHelper(
  target: object,
  name: string,
  length: number,
  impl: (this: any, ...args: any[]) => any,
): void {
  Object.defineProperty(impl, "length", {
    value: length,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(impl, "name", {
    value: name,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(target, name, {
    value: impl,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

/**
 * Build `%IteratorPrototype%` (spec §27.1.2). Its sole own property is
 * `[Symbol.iterator]()` which returns `this`. `%GeneratorPrototype%` inherits
 * from it so generators are iterable. (#1639) We build it explicitly rather
 * than borrowing `globalThis.Iterator.prototype`, which may be absent and in
 * any case is not the object test262 walks to via the generator's proto chain.
 */
function _getIteratorPrototype(): any {
  if (_IteratorPrototypeCache) return _IteratorPrototypeCache;
  const proto = Object.create(Object.prototype);
  _IteratorPrototypeCache = proto;
  const fn = function (this: any) {
    return this;
  };
  Object.defineProperty(fn, "length", { value: 0, writable: false, enumerable: false, configurable: true });
  Object.defineProperty(fn, "name", {
    value: "[Symbol.iterator]",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(proto, Symbol.iterator, {
    value: fn,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return proto;
}

/**
 * Build `%AsyncIteratorPrototype%` (spec §27.1.3). Its sole own property is
 * `[Symbol.asyncIterator]()` which returns `this`. `%AsyncGeneratorPrototype%`
 * inherits from it. (#1639)
 */
function _getAsyncIteratorPrototype(): any {
  if (_AsyncIteratorPrototypeCache) return _AsyncIteratorPrototypeCache;
  const proto = Object.create(Object.prototype);
  _AsyncIteratorPrototypeCache = proto;
  const fn = function (this: any) {
    return this;
  };
  Object.defineProperty(fn, "length", { value: 0, writable: false, enumerable: false, configurable: true });
  Object.defineProperty(fn, "name", {
    value: "[Symbol.asyncIterator]",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(proto, Symbol.asyncIterator, {
    value: fn,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return proto;
}

/** Build `%GeneratorPrototype%` (spec §27.5.1). Idempotent. */
function _getGeneratorPrototype(): any {
  if (_GeneratorPrototypeCache) return _GeneratorPrototypeCache;
  // GeneratorPrototype inherits from %IteratorPrototype% so .map/.filter/etc.
  // (#1367) resolve via the prototype chain, and test262 reaches
  // %IteratorPrototype% via getPrototypeOf(getPrototypeOf(g.prototype)). (#1639)
  const proto = Object.create(_getIteratorPrototype());
  _GeneratorPrototypeCache = proto;

  _installBuiltinMethod(proto, "next", 1, function (this: any, _value?: any) {
    const state = _GeneratorState.get(this);
    if (!state) {
      throw new TypeError("Generator.prototype.next called on incompatible receiver");
    }
    // (#3032) Lazy generator: run the deferred body now (first resume).
    if (state.materialize) state.materialize();
    if (state.index < state.buf.length) {
      return { value: state.buf[state.index++], done: false };
    }
    if (state.pendingThrow !== null && state.pendingThrow !== undefined) {
      const e = state.pendingThrow;
      state.pendingThrow = null;
      throw e;
    }
    // Buffer drained: surface the generator's `return` value ONCE as the
    // terminal `{value, done:true}` result (#2035, §27.5.1.2 step 6). After
    // that, every further `next()` returns `{value:undefined, done:true}`.
    if (!state.retDone) {
      state.retDone = true;
      return { value: state.retVal, done: true };
    }
    return { value: undefined, done: true };
  });

  _installBuiltinMethod(proto, "return", 1, function (this: any, value?: any) {
    const state = _GeneratorState.get(this);
    if (!state) {
      throw new TypeError("Generator.prototype.return called on incompatible receiver");
    }
    // Early termination: skip the rest of the buffer AND suppress the
    // generator's own return value — the caller-supplied `value` becomes the
    // terminal result (§27.5.3.3). Mark retDone so a later next() is terminal.
    // (#3032) A not-yet-started lazy generator completes WITHOUT running its
    // body (§27.5.3.2 GeneratorResumeAbrupt on suspendedStart) — drop the thunk.
    state.thunk = undefined;
    state.materialize = undefined;
    state.index = state.buf.length;
    state.retDone = true;
    return { value, done: true };
  });

  _installBuiltinMethod(proto, "throw", 1, function (this: any, e?: any) {
    const state = _GeneratorState.get(this);
    if (!state) {
      throw new TypeError("Generator.prototype.throw called on incompatible receiver");
    }
    // (#3032) See `return` — abrupt resume of suspendedStart never runs the body.
    state.thunk = undefined;
    state.materialize = undefined;
    state.index = state.buf.length;
    throw e;
  });

  // `[Symbol.iterator]` returning `this` — generators are their own iterators
  // (Iterator.prototype already provides this via @@iterator returning this,
  // but install it explicitly to be robust against missing %IteratorPrototype%
  // in older runtimes).
  if (!(Symbol.iterator in proto)) {
    Object.defineProperty(proto, Symbol.iterator, {
      value: function (this: any) {
        return this;
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  // Symbol.toStringTag = 'Generator' (spec §27.5.1.5)
  Object.defineProperty(proto, Symbol.toStringTag, {
    value: "Generator",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // The `constructor` slot points at %Generator% (= %GeneratorFunction.prototype%).
  // Spec §27.5.1.1 requires a *data* property {writable:false, enumerable:false,
  // configurable:true} — not an accessor. `_getGeneratorFunctionPrototype` set its
  // own cache before it called us (so this call returns the in-progress object
  // without recursing), making the data value safe to install here.
  Object.defineProperty(proto, "constructor", {
    value: _getGeneratorFunctionPrototype(),
    writable: false,
    enumerable: false,
    configurable: true,
  });

  return proto;
}

/**
 * (#1639) Build the per-`function*` instance prototype `genFn.prototype`
 * (spec §27.3.4): `OrdinaryObjectCreate(%GeneratorPrototype%)`. Generator
 * instances inherit from this object so the spec chain holds:
 *   instance → genFn.prototype → %GeneratorPrototype% → %IteratorPrototype%.
 */
function _getGeneratorInstancePrototype(): any {
  if (_GeneratorInstancePrototypeCache) return _GeneratorInstancePrototypeCache;
  _GeneratorInstancePrototypeCache = Object.create(_getGeneratorPrototype());
  return _GeneratorInstancePrototypeCache;
}

/** Build `%GeneratorFunction.prototype%` (= `%Generator%`, spec §27.3.3). */
function _getGeneratorFunctionPrototype(): any {
  if (_GeneratorFunctionPrototypeCache) return _GeneratorFunctionPrototypeCache;
  // %Generator% inherits from %Function.prototype% so `typeof g.constructor === 'function'`.
  const proto = Object.create(Function.prototype);
  _GeneratorFunctionPrototypeCache = proto;

  // `prototype` slot = `%GeneratorPrototype%` (writable: false, !enum, configurable: false per spec —
  //   §27.3.3.3 — though several engines ship it as configurable; configurable is what test262
  //   verifyProperty defaults check against).
  Object.defineProperty(proto, "prototype", {
    value: _getGeneratorPrototype(),
    writable: false,
    enumerable: false,
    configurable: false,
  });

  Object.defineProperty(proto, Symbol.toStringTag, {
    value: "GeneratorFunction",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  return proto;
}

/** Build `%AsyncGeneratorPrototype%` (spec §27.6.1). */
function _getAsyncGeneratorPrototype(): any {
  if (_AsyncGeneratorPrototypeCache) return _AsyncGeneratorPrototypeCache;
  // Inherits from %AsyncIteratorPrototype% (#1639) — test262 reaches it via
  // getPrototypeOf(getPrototypeOf(asyncGen.prototype)).
  const proto = Object.create(_getAsyncIteratorPrototype());
  _AsyncGeneratorPrototypeCache = proto;

  function mkResult(value: any, done: boolean) {
    const plain = { value, done };
    return {
      value,
      done,
      then(res: any, rej: any) {
        return Promise.resolve(plain).then(res, rej);
      },
    };
  }
  function mkError(e: any) {
    return {
      done: true,
      value: undefined as any,
      then(res: any, rej: any) {
        return Promise.reject(e).then(res, rej);
      },
    };
  }

  _installBuiltinMethod(proto, "next", 1, function (this: any, _value?: any) {
    const state = _AsyncGeneratorState.get(this);
    if (!state) {
      return mkError(new TypeError("AsyncGenerator.prototype.next called on incompatible receiver"));
    }
    if (state.index < state.buf.length) return mkResult(state.buf[state.index++], false);
    if (state.pendingThrow !== null && state.pendingThrow !== undefined) {
      const e = state.pendingThrow;
      state.pendingThrow = null;
      return mkError(e);
    }
    return mkResult(undefined, true);
  });

  _installBuiltinMethod(proto, "return", 1, function (this: any, value?: any) {
    const state = _AsyncGeneratorState.get(this);
    if (!state) {
      return mkError(new TypeError("AsyncGenerator.prototype.return called on incompatible receiver"));
    }
    state.index = state.buf.length;
    return mkResult(value, true);
  });

  _installBuiltinMethod(proto, "throw", 1, function (this: any, e?: any) {
    const state = _AsyncGeneratorState.get(this);
    if (!state) {
      return mkError(new TypeError("AsyncGenerator.prototype.throw called on incompatible receiver"));
    }
    state.index = state.buf.length;
    return mkError(e);
  });

  if (!(Symbol.asyncIterator in proto)) {
    Object.defineProperty(proto, Symbol.asyncIterator, {
      value: function (this: any) {
        return this;
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  Object.defineProperty(proto, Symbol.toStringTag, {
    value: "AsyncGenerator",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // Spec §27.6.1.1 — `constructor` is a data property {writable:false,
  // enumerable:false, configurable:true} pointing at %AsyncGenerator%.
  Object.defineProperty(proto, "constructor", {
    value: _getAsyncGeneratorFunctionPrototype(),
    writable: false,
    enumerable: false,
    configurable: true,
  });

  return proto;
}

/**
 * (#1639) Build the per-`async function*` instance prototype `genFn.prototype`
 * (spec §27.4.4): `OrdinaryObjectCreate(%AsyncGeneratorPrototype%)`. The chain
 * is: instance → genFn.prototype → %AsyncGeneratorPrototype% → %AsyncIteratorPrototype%.
 */
function _getAsyncGeneratorInstancePrototype(): any {
  if (_AsyncGeneratorInstancePrototypeCache) return _AsyncGeneratorInstancePrototypeCache;
  _AsyncGeneratorInstancePrototypeCache = Object.create(_getAsyncGeneratorPrototype());
  return _AsyncGeneratorInstancePrototypeCache;
}

/** Build `%AsyncGeneratorFunction.prototype%` (= `%AsyncGenerator%`, spec §27.4.3). */
function _getAsyncGeneratorFunctionPrototype(): any {
  if (_AsyncGeneratorFunctionPrototypeCache) return _AsyncGeneratorFunctionPrototypeCache;
  const proto = Object.create(Function.prototype);
  _AsyncGeneratorFunctionPrototypeCache = proto;
  Object.defineProperty(proto, "prototype", {
    value: _getAsyncGeneratorPrototype(),
    writable: false,
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(proto, Symbol.toStringTag, {
    value: "AsyncGeneratorFunction",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  return proto;
}

/**
 * #1464 — ES2025 Iterator helper polyfills.
 *
 * `Iterator.zip(iters, opts)`, `Iterator.zipKeyed(iterMap, opts)` and
 * `Iterator.concat(...iters)` are recent ES2025 additions that some hosts
 * (Node ≤24 / older V8) don't ship. They are wired through
 * `__extern_method_call` (since `Iterator` is in `BUILTIN_CLASS_NAMES`),
 * so installing a single polyfill on `globalThis.Iterator` makes every
 * call site work uniformly. The polyfill:
 *   - returns helper iterators that inherit from `%Iterator.prototype%`
 *     so chained `.map / .filter / .toArray` continue working
 *   - validates arguments eagerly and calls `return()` on any
 *     already-opened underlying iterator when one rejects
 *   - implements `mode: "shortest" | "longest" | "strict"` for `zip` per
 *     the proposal text (TC39 stage 4, ES2025)
 *
 * Called from `buildImports` (once, guarded by `_iteratorHelpersInstalled`).
 * Safe to call on a host that already ships the helpers — we only install
 * when the method is missing.
 */
let _iteratorHelpersInstalled = false;
const _intrinsicStringIterator = String.prototype[Symbol.iterator];
function _installIteratorHelperPolyfills(): void {
  if (_iteratorHelpersInstalled) return;
  _iteratorHelpersInstalled = true;
  const compilerIteratorProto = _getIteratorPrototype();
  let I: any = (globalThis as any).Iterator;
  if (typeof I !== "function" || typeof I.prototype !== "object" || I.prototype == null) {
    I = function Iterator(this: any) {
      throw new TypeError("Iterator is not a constructor");
    };
    I.prototype = compilerIteratorProto;
    Object.defineProperty(globalThis, "Iterator", {
      value: I,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  const Iproto: any = typeof I.prototype === "object" && I.prototype != null ? I.prototype : compilerIteratorProto;

  if (Iproto !== compilerIteratorProto) {
    let wouldCycle = false;
    for (let p = Iproto; p != null; p = Object.getPrototypeOf(p)) {
      if (p === compilerIteratorProto) {
        wouldCycle = true;
        break;
      }
    }
    if (!wouldCycle && Object.getPrototypeOf(compilerIteratorProto) !== Iproto) {
      Object.setPrototypeOf(compilerIteratorProto, Iproto);
    }
  }

  function _isObject(value: any): boolean {
    return (typeof value === "object" && value !== null) || typeof value === "function";
  }

  function _getIteratorDirect(iter: any): any {
    if (!_isObject(iter)) {
      throw new TypeError("Iterator helper: iterator is not an object");
    }
    if (typeof iter.next !== "function") {
      throw new TypeError("Iterator helper: iterator has no next()");
    }
    return iter;
  }

  function _getIterator(iterable: any): any {
    if (!_isObject(iterable)) {
      throw new TypeError("Iterator helper: argument is not iterable");
    }
    const method = iterable[Symbol.iterator];
    if (typeof method !== "function") {
      throw new TypeError("Iterator helper: argument is not iterable");
    }
    return _getIteratorDirect(method.call(iterable));
  }

  function _iteratorStepValue(iter: any): { done: true; value?: undefined } | { done: false; value: any } {
    const result = iter.next();
    if (!_isObject(result)) {
      throw new TypeError("Iterator result is not an object");
    }
    if (result.done) return { done: true };
    return { value: result.value, done: false };
  }

  // ES2025 GetIteratorFlattenable — accepts an iterable OR a raw iterator.
  // `Iterator.from` uses iterate-string-primitives; iterator helper flattening
  // (e.g. flatMap) uses reject-primitives.
  function _getFlattenable(obj: any, primitiveHandling: "iterate-string-primitives" | "reject-primitives"): any {
    if (obj == null) {
      throw new TypeError("Iterator helper: argument is null or undefined");
    }
    const primitive = typeof obj !== "object" && typeof obj !== "function";
    if (primitive) {
      if (primitiveHandling === "reject-primitives" || typeof obj !== "string") {
        throw new TypeError("Iterator helper: argument is not iterable");
      }
    }
    let it: any;
    const stringLike = typeof obj === "string" || obj instanceof String;
    let sym = primitive ? Reflect.get(Object(obj), Symbol.iterator, obj) : obj[Symbol.iterator];
    if (typeof sym !== "function" && stringLike && typeof _intrinsicStringIterator === "function") {
      sym = _intrinsicStringIterator;
    }
    if (typeof sym === "function") {
      it = sym.call(obj);
    } else if (typeof obj.next === "function") {
      it = obj;
    } else {
      throw new TypeError("Iterator helper: argument is not iterable");
    }
    return _getIteratorDirect(it);
  }

  // ES2025 GetOptionsObject (iterator-sequencing / joint-iteration proposal):
  // undefined → fresh null-proto object; Object → returned as-is; any other
  // value (null, boolean, number, string, symbol, bigint) throws TypeError.
  function _getOptionsObject(options: any): any {
    if (options === undefined) return Object.create(null);
    if (typeof options === "object" && options !== null) return options;
    if (typeof options === "function") return options;
    throw new TypeError("Iterator options must be undefined or an object");
  }

  function _makeHelperIterator(nextFn: () => any, returnFn: (v?: any) => any): any {
    const obj: any = Object.create(Iproto);
    obj.next = nextFn;
    obj.return = returnFn;
    obj[Symbol.iterator] = function () {
      return this;
    };
    return obj;
  }

  function _requireIteratorReceiver(receiver: any, name: string): any {
    if (receiver == null || typeof receiver.next !== "function") {
      throw new TypeError("Iterator.prototype." + name + " called on non-iterator");
    }
    return receiver;
  }

  function _closeIterator(iter: any): void {
    try {
      iter?.return?.();
    } catch {}
  }

  function _closeIterators(iters: any[], open?: boolean[], except = -1): void {
    for (let i = 0; i < iters.length; i++) {
      if (i === except) continue;
      if (open && !open[i]) continue;
      if (open) open[i] = false;
      _closeIterator(iters[i]);
    }
  }

  function _readZipOptions(options: any): { mode: "shortest" | "longest" | "strict"; paddingOption: any } {
    options = _getOptionsObject(options);
    let mode = options.mode;
    if (mode === undefined) mode = "shortest";
    if (mode !== "shortest" && mode !== "longest" && mode !== "strict") {
      throw new TypeError("Iterator.zip: invalid mode " + String(mode));
    }
    let paddingOption: any = undefined;
    if (mode === "longest") {
      paddingOption = options.padding;
      if (paddingOption !== undefined && !_isObject(paddingOption)) {
        throw new TypeError("Iterator.zip: padding must be an object");
      }
    }
    return { mode, paddingOption };
  }

  function _makeIteratorZip(
    iters: any[],
    mode: "shortest" | "longest" | "strict",
    padding: any[],
    finishResults: (results: any[]) => any,
  ): any {
    const open = iters.map(() => true);
    let exhausted = false;

    return _makeHelperIterator(
      function next() {
        if (exhausted || iters.length === 0) return { value: undefined, done: true };
        const results: any[] = [];
        for (let i = 0; i < iters.length; i++) {
          let result: any;
          if (!open[i]) {
            result = padding[i];
          } else {
            let step: { done: true; value?: undefined } | { done: false; value: any };
            try {
              step = _iteratorStepValue(iters[i]);
            } catch (e) {
              exhausted = true;
              open[i] = false;
              _closeIterators(iters, open);
              throw e;
            }

            if (step.done) {
              open[i] = false;
              if (mode === "shortest") {
                exhausted = true;
                _closeIterators(iters, open);
                return { value: undefined, done: true };
              }
              if (mode === "strict") {
                exhausted = true;
                if (i !== 0) {
                  _closeIterators(iters, open);
                  throw new TypeError("Iterator.zip strict mode: length mismatch");
                }
                for (let k = 1; k < iters.length; k++) {
                  let openStep: { done: true; value?: undefined } | { done: false; value: any };
                  try {
                    openStep = _iteratorStepValue(iters[k]);
                  } catch (e) {
                    open[k] = false;
                    _closeIterators(iters, open);
                    throw e;
                  }
                  if (openStep.done) {
                    open[k] = false;
                  } else {
                    _closeIterators(iters, open);
                    throw new TypeError("Iterator.zip strict mode: length mismatch");
                  }
                }
                return { value: undefined, done: true };
              }

              if (!open.some(Boolean)) {
                exhausted = true;
                return { value: undefined, done: true };
              }
              result = padding[i];
            } else {
              result = step.value;
            }
          }
          results.push(result);
        }
        return { value: finishResults(results), done: false };
      },
      function returnFn() {
        exhausted = true;
        _closeIterators(iters, open);
        return { value: undefined, done: true };
      },
    );
  }

  // (#1320) Always route Iterator.from through the bridge implementation. Host
  // natives cannot call compiled accessor closures installed on primitive
  // prototypes reliably after the Wasm closure crosses externref.
  _installStaticHelper(I, "from", 1, function from(iterable: any) {
    return _getFlattenable(iterable, "iterate-string-primitives");
  });

  if (typeof Iproto.map !== "function") {
    _installBuiltinMethod(Iproto, "map", 1, function (this: any, mapper: any) {
      const outer = _requireIteratorReceiver(this, "map");
      if (typeof mapper !== "function") {
        throw new TypeError("Iterator.prototype.map: mapper is not a function");
      }
      let counter = 0;
      let done = false;
      return _makeHelperIterator(
        function next() {
          if (done) return { value: undefined, done: true };
          const r = outer.next();
          if (r && r.done) {
            done = true;
            return { value: undefined, done: true };
          }
          try {
            return { value: mapper(r.value, counter++), done: false };
          } catch (e) {
            done = true;
            _closeIterator(outer);
            throw e;
          }
        },
        function returnFn() {
          done = true;
          _closeIterator(outer);
          return { value: undefined, done: true };
        },
      );
    });
  }

  if (typeof Iproto.filter !== "function") {
    _installBuiltinMethod(Iproto, "filter", 1, function (this: any, predicate: any) {
      const outer = _requireIteratorReceiver(this, "filter");
      if (typeof predicate !== "function") {
        throw new TypeError("Iterator.prototype.filter: predicate is not a function");
      }
      let counter = 0;
      let done = false;
      return _makeHelperIterator(
        function next() {
          if (done) return { value: undefined, done: true };
          while (true) {
            const r = outer.next();
            if (r && r.done) {
              done = true;
              return { value: undefined, done: true };
            }
            let keep: any;
            try {
              keep = predicate(r.value, counter++);
            } catch (e) {
              done = true;
              _closeIterator(outer);
              throw e;
            }
            if (keep) return { value: r.value, done: false };
          }
        },
        function returnFn() {
          done = true;
          _closeIterator(outer);
          return { value: undefined, done: true };
        },
      );
    });
  }

  if (typeof Iproto.take !== "function") {
    _installBuiltinMethod(Iproto, "take", 1, function (this: any, limit: any) {
      const outer = _requireIteratorReceiver(this, "take");
      let remaining = Number(limit);
      if (!Number.isFinite(remaining)) remaining = Infinity;
      remaining = Math.trunc(remaining);
      if (remaining < 0) throw new RangeError("Iterator.prototype.take: limit must be non-negative");
      let done = false;
      return _makeHelperIterator(
        function next() {
          if (done || remaining <= 0) {
            done = true;
            return { value: undefined, done: true };
          }
          remaining--;
          const r = outer.next();
          if (r && r.done) {
            done = true;
            return { value: undefined, done: true };
          }
          return { value: r.value, done: false };
        },
        function returnFn() {
          done = true;
          _closeIterator(outer);
          return { value: undefined, done: true };
        },
      );
    });
  }

  if (typeof Iproto.drop !== "function") {
    _installBuiltinMethod(Iproto, "drop", 1, function (this: any, limit: any) {
      const outer = _requireIteratorReceiver(this, "drop");
      let remaining = Number(limit);
      if (!Number.isFinite(remaining)) remaining = Infinity;
      remaining = Math.trunc(remaining);
      if (remaining < 0) throw new RangeError("Iterator.prototype.drop: limit must be non-negative");
      let done = false;
      return _makeHelperIterator(
        function next() {
          if (done) return { value: undefined, done: true };
          while (remaining > 0) {
            remaining--;
            const skipped = outer.next();
            if (skipped && skipped.done) {
              done = true;
              return { value: undefined, done: true };
            }
          }
          const r = outer.next();
          if (r && r.done) {
            done = true;
            return { value: undefined, done: true };
          }
          return { value: r.value, done: false };
        },
        function returnFn() {
          done = true;
          _closeIterator(outer);
          return { value: undefined, done: true };
        },
      );
    });
  }

  if (typeof Iproto.toArray !== "function") {
    _installBuiltinMethod(Iproto, "toArray", 0, function (this: any) {
      const iter = _requireIteratorReceiver(this, "toArray");
      const out: any[] = [];
      for (;;) {
        const r = iter.next();
        if (r && r.done) return out;
        out.push(r.value);
      }
    });
  }

  if (typeof Iproto.forEach !== "function") {
    _installBuiltinMethod(Iproto, "forEach", 1, function (this: any, fn: any) {
      const iter = _requireIteratorReceiver(this, "forEach");
      if (typeof fn !== "function") {
        throw new TypeError("Iterator.prototype.forEach: callback is not a function");
      }
      let counter = 0;
      for (;;) {
        const r = iter.next();
        if (r && r.done) return undefined;
        try {
          fn(r.value, counter++);
        } catch (e) {
          _closeIterator(iter);
          throw e;
        }
      }
    });
  }

  if (typeof Iproto.some !== "function") {
    _installBuiltinMethod(Iproto, "some", 1, function (this: any, predicate: any) {
      const iter = _requireIteratorReceiver(this, "some");
      if (typeof predicate !== "function") {
        throw new TypeError("Iterator.prototype.some: predicate is not a function");
      }
      let counter = 0;
      for (;;) {
        const r = iter.next();
        if (r && r.done) return false;
        try {
          if (predicate(r.value, counter++)) {
            _closeIterator(iter);
            return true;
          }
        } catch (e) {
          _closeIterator(iter);
          throw e;
        }
      }
    });
  }

  if (typeof Iproto.every !== "function") {
    _installBuiltinMethod(Iproto, "every", 1, function (this: any, predicate: any) {
      const iter = _requireIteratorReceiver(this, "every");
      if (typeof predicate !== "function") {
        throw new TypeError("Iterator.prototype.every: predicate is not a function");
      }
      let counter = 0;
      for (;;) {
        const r = iter.next();
        if (r && r.done) return true;
        try {
          if (!predicate(r.value, counter++)) {
            _closeIterator(iter);
            return false;
          }
        } catch (e) {
          _closeIterator(iter);
          throw e;
        }
      }
    });
  }

  if (typeof Iproto.find !== "function") {
    _installBuiltinMethod(Iproto, "find", 1, function (this: any, predicate: any) {
      const iter = _requireIteratorReceiver(this, "find");
      if (typeof predicate !== "function") {
        throw new TypeError("Iterator.prototype.find: predicate is not a function");
      }
      let counter = 0;
      for (;;) {
        const r = iter.next();
        if (r && r.done) return undefined;
        try {
          if (predicate(r.value, counter++)) {
            _closeIterator(iter);
            return r.value;
          }
        } catch (e) {
          _closeIterator(iter);
          throw e;
        }
      }
    });
  }

  if (typeof Iproto.reduce !== "function") {
    _installBuiltinMethod(Iproto, "reduce", 1, function (this: any, reducer: any, initial?: any) {
      const iter = _requireIteratorReceiver(this, "reduce");
      if (typeof reducer !== "function") {
        throw new TypeError("Iterator.prototype.reduce: reducer is not a function");
      }
      let counter = 0;
      let acc: any = initial;
      if (arguments.length < 2) {
        const first = iter.next();
        if (first && first.done) {
          throw new TypeError("Iterator.prototype.reduce: empty iterator with no initial value");
        }
        acc = first.value;
        counter = 1;
      }
      for (;;) {
        const r = iter.next();
        if (r && r.done) return acc;
        try {
          acc = reducer(acc, r.value, counter++);
        } catch (e) {
          _closeIterator(iter);
          throw e;
        }
      }
    });
  }

  if (typeof I.zip !== "function") {
    _installStaticHelper(I, "zip", 1, function zip(iterables: any, options?: any) {
      if (!_isObject(iterables)) {
        throw new TypeError("Iterator.zip: iterables must be an object");
      }
      const { mode, paddingOption } = _readZipOptions(options);
      const iters: any[] = [];
      let inputIter: any;
      try {
        inputIter = _getIterator(iterables);
        for (;;) {
          const next = _iteratorStepValue(inputIter);
          if (next.done) break;
          try {
            iters.push(_getFlattenable(next.value, "reject-primitives"));
          } catch (e) {
            _closeIterator(inputIter);
            _closeIterators(iters);
            throw e;
          }
        }
      } catch (e) {
        _closeIterators(iters);
        throw e;
      }

      const padding: any[] = [];
      if (mode === "longest") {
        if (paddingOption === undefined) {
          for (let i = 0; i < iters.length; i++) padding.push(undefined);
        } else {
          let paddingIter: any;
          try {
            paddingIter = _getIterator(paddingOption);
            let usingIterator = true;
            for (let i = 0; i < iters.length; i++) {
              if (usingIterator) {
                const next = _iteratorStepValue(paddingIter);
                if (next.done) {
                  usingIterator = false;
                } else {
                  padding.push(next.value);
                  continue;
                }
              }
              padding.push(undefined);
            }
            if (usingIterator) {
              paddingIter.return?.();
            }
          } catch (e) {
            _closeIterators(iters);
            throw e;
          }
        }
      }

      return _makeIteratorZip(iters, mode, padding, (results) => results.slice());
    });
  }

  if (typeof I.zipKeyed !== "function") {
    _installStaticHelper(I, "zipKeyed", 1, function zipKeyed(iterables: any, options?: any) {
      if (!_isObject(iterables)) {
        throw new TypeError("Iterator.zipKeyed: iterables must be an object");
      }
      const { mode, paddingOption } = _readZipOptions(options);
      const keys: PropertyKey[] = [];
      const iters: any[] = [];
      try {
        for (const key of Reflect.ownKeys(iterables)) {
          const desc = Object.getOwnPropertyDescriptor(iterables, key);
          if (desc && desc.enumerable) {
            const value = iterables[key];
            if (value !== undefined) {
              keys.push(key);
              iters.push(_getFlattenable(value, "reject-primitives"));
            }
          }
        }
      } catch (e) {
        _closeIterators(iters);
        throw e;
      }

      const padding: any[] = [];
      if (mode === "longest") {
        if (paddingOption === undefined) {
          for (let i = 0; i < iters.length; i++) padding.push(undefined);
        } else {
          try {
            for (const key of keys) {
              padding.push(paddingOption[key]);
            }
          } catch (e) {
            _closeIterators(iters);
            throw e;
          }
        }
      }

      return _makeIteratorZip(iters, mode, padding, (results) => {
        const out: any = Object.create(null);
        for (let i = 0; i < keys.length; i++) {
          Object.defineProperty(out, keys[i]!, {
            value: results[i],
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        return out;
      });
    });
  }

  if (typeof I.concat !== "function") {
    _installStaticHelper(I, "concat", 0, function concat(...iterables: any[]) {
      const records: { iterable: any; method: any }[] = [];
      for (const iterable of iterables) {
        if (!_isObject(iterable)) {
          throw new TypeError("Iterator.concat: argument is not an object");
        }
        const method = iterable[Symbol.iterator];
        if (method === undefined) {
          throw new TypeError("Iterator.concat: argument is not iterable");
        }
        if (typeof method !== "function") {
          throw new TypeError("Iterator.concat: argument is not iterable");
        }
        records.push({ iterable, method });
      }
      let idx = 0;
      let current: any = null;
      return _makeHelperIterator(
        function next() {
          while (true) {
            if (current == null) {
              if (idx >= records.length) return { value: undefined, done: true };
              const record = records[idx++]!;
              current = _getIteratorDirect(record.method.call(record.iterable));
            }
            let r: any;
            try {
              r = current.next();
            } catch (e) {
              current = null;
              idx = records.length;
              throw e;
            }
            if (!_isObject(r)) {
              current = null;
              idx = records.length;
              throw new TypeError("Iterator result is not an object");
            }
            if (r.done) {
              current = null;
              continue;
            }
            return { value: r.value, done: false };
          }
        },
        function returnFn() {
          if (current != null) {
            try {
              current.return?.();
            } catch {}
          }
          idx = iterables.length;
          current = null;
          return { value: undefined, done: true };
        },
      );
    });
  }

  // #1718 S1 — Iterator.prototype.flatMap (TC39 iterator-helpers, ES2025).
  // §27.1.4.x: for each value v of the underlying iterator, call
  // mapper(v, counter); GetIteratorFlattenable(result, reject-primitives);
  // yield every value of that inner iterator before advancing the outer.
  // Hosts that lack the native helper (older V8 / Node) fall through to here;
  // installing it on %Iterator.prototype% makes every helper-iterator and
  // synthesized iterator (which inherit from Iproto, #1367) gain flatMap.
  if (typeof Iproto.flatMap !== "function") {
    Object.defineProperty(Iproto, "flatMap", {
      value: function flatMap(mapper: any) {
        // 1. RequireObjectCoercible(this) + this has [[next]] (it's an Iterator).
        if (this == null || typeof this.next !== "function") {
          throw new TypeError("Iterator.prototype.flatMap called on non-iterator");
        }
        // 2. mapper must be callable.
        if (typeof mapper !== "function") {
          throw new TypeError("Iterator.prototype.flatMap: mapper is not a function");
        }
        const outer: any = this;
        let counter = 0;
        let inner: any = null; // currently-open inner iterator, or null
        let done = false;

        function closeInner(): void {
          if (inner != null) {
            const innerIt = inner;
            inner = null;
            try {
              innerIt.return?.();
            } catch {}
          }
        }

        return _makeHelperIterator(
          function next() {
            if (done) return { value: undefined, done: true };
            while (true) {
              if (inner == null) {
                // Advance the outer iterator.
                let outerRes: any;
                try {
                  outerRes = outer.next();
                } catch (e) {
                  done = true;
                  throw e;
                }
                if (outerRes && outerRes.done) {
                  done = true;
                  return { value: undefined, done: true };
                }
                // mapped = mapper(value, counter); IfAbruptCloseIterator(outer).
                let mapped: any;
                try {
                  mapped = mapper(outerRes.value, counter);
                } catch (e) {
                  done = true;
                  try {
                    outer.return?.();
                  } catch {}
                  throw e;
                }
                counter++;
                try {
                  inner = _getFlattenable(mapped, "reject-primitives");
                } catch (e) {
                  done = true;
                  try {
                    outer.return?.();
                  } catch {}
                  throw e;
                }
              }
              // Pull from the inner iterator.
              let innerRes: any;
              try {
                innerRes = inner.next();
              } catch (e) {
                done = true;
                inner = null;
                try {
                  outer.return?.();
                } catch {}
                throw e;
              }
              if (innerRes && innerRes.done) {
                inner = null;
                continue; // inner exhausted — advance outer
              }
              return { value: innerRes.value, done: false };
            }
          },
          function returnFn() {
            done = true;
            closeInner();
            try {
              outer.return?.();
            } catch {}
            return { value: undefined, done: true };
          },
        );
      },
      writable: true,
      configurable: true,
    });
  }
}

export {
  _GeneratorState,
  _AsyncGeneratorState,
  _getSynthArrayIteratorPrototype,
  _getGeneratorInstancePrototype,
  _getGeneratorFunctionPrototype,
  _getAsyncGeneratorInstancePrototype,
  _getAsyncGeneratorFunctionPrototype,
  _installIteratorHelperPolyfills,
  _resetIteratorRuntimeIntrinsicsForRealmIsolation,
};
