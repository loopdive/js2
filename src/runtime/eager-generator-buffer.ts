// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6979 S7-d) Provider of the `eager-generator-buffer` regime gap (#680, the
 * one named #5385 gap left): the `__gen_*` / `__create_generator` /
 * `__create_async_generator` imports a generator shape uses when the native
 * generator lowering declines it. Split out of `src/runtime.ts`'s
 * `resolveImport`; it goes when #680 closes.
 */
import {
  _AsyncGeneratorState,
  _GeneratorState,
  _getAsyncGeneratorInstancePrototype,
  _getGeneratorInstancePrototype,
} from "./iterator-polyfills.js";
import { readEnv } from "../env.js";

interface CallbackState {
  getExports: () => Record<string, Function> | undefined;
}

/** The runtime's value-boundary operations this provider needs. */
export interface EagerGeneratorHostOps {
  materializeIterable(iter: any, callbackState?: CallbackState): any;
  sidecarGet(obj: any, key: string): any;
  safeGet(obj: any, key: string, callbackState?: CallbackState): any;
  isWasmStruct(value: any): boolean;
  canBeWeakKey(value: any): boolean;
  /** Is `value` a registered fnctor-subclass instance (#3123)? */
  isFnctorInstance(value: object): boolean;
  /** The `__gen_yield_star_step` import, built lazily by the strict iterator provider. */
  yieldStarStepImport(): Function;
}

// Captured at load, like `src/runtime.ts`'s copy (#4616): survives a user patch of `Array.isArray`.
const nativeIsArray = Array.isArray;

// (#6798) Each eager generator buffer's last `yield*` completion value, read
// (and cleared) once by `__gen_yield_star_result`.
const genYieldStarResults = new WeakMap<object, unknown>();
const takeGenYieldStarResult = (buf: object): unknown => {
  const result = genYieldStarResults.get(buf);
  genYieldStarResults.delete(buf);
  return result;
};

/** The provider for one eager-generator import, or `undefined` when `name` is not one. */
export function resolveEagerGeneratorImport(
  name: string,
  callbackState: CallbackState | undefined,
  ops: EagerGeneratorHostOps,
): Function | undefined {
  // Generator support: buffer management and generator creation
  //
  // Eager-generator hard cap (#991/#992): we lower generators to an array
  // that is fully populated before .next() can be called. An infinite
  // generator (e.g. `while (true) { yield; }`) would push forever, OOMing
  // the Node process and causing the parent test runner to register a
  // 30s timeout. Throwing a RangeError after a bounded number of yields
  // turns those tests into a quick runtime exception instead of a
  // worker-killing OOM. The cap is high enough (1M) that real-world
  // generators are never affected.
  const __EAGER_GEN_LIMIT = 1_000_000;
  if (name === "__gen_create_buffer") return () => [];
  if (name === "__gen_push_f64")
    return (buf: any[], v: number) => {
      if (buf.length >= __EAGER_GEN_LIMIT) {
        throw new RangeError("Eager generator buffer exceeded " + __EAGER_GEN_LIMIT + " yields");
      }
      buf.push(v);
    };
  if (name === "__gen_push_i32")
    return (buf: any[], v: number) => {
      if (buf.length >= __EAGER_GEN_LIMIT) {
        throw new RangeError("Eager generator buffer exceeded " + __EAGER_GEN_LIMIT + " yields");
      }
      buf.push(v);
    };
  if (name === "__gen_push_ref")
    return (buf: any[], v: any) => {
      if (buf.length >= __EAGER_GEN_LIMIT) {
        throw new RangeError("Eager generator buffer exceeded " + __EAGER_GEN_LIMIT + " yields");
      }
      buf.push(v);
    };
  if (name === "__gen_yield_star")
    return (buf: any[], rawIterable: any) => {
      // Iterate the inner iterable and push all values into the outer buffer.
      // Per §27.5.3 yield* output, the inner generator's RETURN value is the
      // value of the `yield*` expression and must NOT leak into the outer
      // stream — `for...of`/manual iteration already stops at the inner
      // `done:true` result, so only the yielded (`done:false`) values are
      // pushed here. (#2035)
      // (#3075) Under `--target standalone`/`wasi` the `yield*` operand is
      // an opaque WasmGC `$Vec` struct, not a JS iterable — it has no
      // `Symbol.iterator`, so this push loop silently drained ZERO values
      // (the buffered generator then reported done immediately, the vacuous
      // half of the for-await dstr cluster). Materialize it into a real JS
      // array through the module's `__vec_len`/`__vec_get` exports first;
      // non-vec / host iterables pass through unchanged.
      // (#3227 S3) `yield* <async generator>` inside an `async function*`:
      // the inner object carries only `Symbol.asyncIterator`, so the sync
      // for-of below drained ZERO values — the outer async generator then
      // reported `{value: undefined, done: true}` on the first `.next()`
      // (the yield-star half of the S3 flip cluster). Our async generators
      // are EAGERLY buffered (`_AsyncGeneratorState` → `{buf, index}`), so
      // the settled values are synchronously available: drain the
      // remaining buffer directly, then propagate a pendingThrow exactly
      // like the eager body would (§27.6.3.8 — an inner abrupt completion
      // propagates out of the `yield*`).
      const asyncState = rawIterable != null ? _AsyncGeneratorState.get(rawIterable) : undefined;
      if (asyncState !== undefined) {
        while (asyncState.index < asyncState.buf.length) {
          if (buf.length >= __EAGER_GEN_LIMIT) {
            throw new RangeError("Eager generator buffer exceeded " + __EAGER_GEN_LIMIT + " yields");
          }
          buf.push(asyncState.buf[asyncState.index++]);
        }
        if (asyncState.pendingThrow !== null && asyncState.pendingThrow !== undefined) {
          const e = asyncState.pendingThrow;
          asyncState.pendingThrow = null;
          throw e;
        }
        return;
      }
      const iterable = ops.materializeIterable(rawIterable, callbackState);
      if (iterable != null && typeof iterable[Symbol.iterator] === "function") {
        // (#6798) Step by hand (not for-of) so the delegate's terminal
        // `{done: true, value}` survives: it is the `yield*` expression's value.
        const iterator = iterable[Symbol.iterator]();
        const next = iterator.next;
        for (;;) {
          const step = next.call(iterator);
          if (Object(step) !== step) throw new TypeError("Iterator result is not an object");
          if (step.done) {
            genYieldStarResults.set(buf, step.value);
            return;
          }
          if (buf.length >= __EAGER_GEN_LIMIT) {
            iterator.return?.();
            throw new RangeError("Eager generator buffer exceeded " + __EAGER_GEN_LIMIT + " yields");
          }
          buf.push(step.value);
        }
      }
    };
  if (name === "__gen_yield_star_result") return takeGenYieldStarResult;
  // __gen_set_return: (buf, value) → void. Stashes the generator's `return`
  // value on the buffer object (a non-enumerable side property) rather than
  // pushing it as a yielded element. `__create_generator` reads it into
  // `_GeneratorState.retVal` so the terminal `{value, done:true}` result
  // carries it exactly once. (#2035)
  if (name === "__gen_set_return")
    return (buf: any, v: any) => {
      if (buf != null) {
        Object.defineProperty(buf, "__genReturn", {
          value: v,
          writable: true,
          enumerable: false,
          configurable: true,
        });
      }
    };
  if (name === "__create_generator")
    return (buf: any[], pendingThrow: any) => {
      // (#1516) Generator instances now share `%GeneratorPrototype%` (built
      // by `_getGeneratorPrototype`) so `next`/`return`/`throw` are NOT own
      // properties — they live on the prototype and read instance state
      // from `_GeneratorState`. This makes
      // `Generator.prototype.next.call(non_gen)` throw TypeError per spec
      // §27.5.3.2 (GeneratorValidate), and installs the spec-mandated
      // property descriptors ({writable: true, enumerable: false,
      // configurable: true} for the methods, `Symbol.toStringTag` =
      // "Generator", etc.).
      //
      // %GeneratorPrototype% inherits from %IteratorPrototype% so
      // .map/.filter/.drop/.take/... (#1367) still resolve through the
      // chain.
      // (#1639) Instances inherit from the per-function instance prototype
      // (`genFn.prototype`), which in turn inherits from %GeneratorPrototype%,
      // so `Object.getPrototypeOf(instance) === genFn.prototype` per spec and
      // `next`/`return`/`throw` still resolve up the chain. State lives on the
      // instance, not the prototype, so the brand check
      // (`_GeneratorState.get(this)`) is unaffected.
      const proto = _getGeneratorInstancePrototype();
      const obj: any = Object.create(proto);
      // (#3032) LAZY thunk mode: a non-Array first arg is the generator-
      // expression CLOSURE itself (an opaque wasm ref), not an eager
      // buffer. Defer the body: on the first `next()` re-invoke the
      // closure through the module's `__call_fn_0` export with the
      // `__gen_set_eager` flag held — the closure then takes its
      // historical eager-buffer path and we adopt the inner generator's
      // state. `return`/`throw` before the first `next()` complete the
      // generator WITHOUT running the body (spec §27.5.3.2). This fixes
      // the eager-at-creation side effects of the buffer lowering
      // (test262 dstr fixture: `var iter = function*(){ iterations += 1 }()`
      // must keep iterations === 0 until a resume).
      if (buf !== null && buf !== undefined && !nativeIsArray(buf)) {
        const st: {
          buf: any[];
          index: number;
          pendingThrow: any;
          retVal?: any;
          thunk?: any;
          materialize?: () => void;
        } = { buf: [], index: 0, pendingThrow: null, retVal: undefined, thunk: buf };
        st.materialize = () => {
          const DBG = readEnv("GEN_DEBUG") === "1";
          const thunk = st.thunk;
          st.thunk = undefined;
          st.materialize = undefined;
          const exports = callbackState?.getExports?.() as any;
          const setEager = exports?.__gen_set_eager as ((v: number) => void) | undefined;
          const callFn0 = exports?.__call_fn_0 as ((c: any) => any) | undefined;
          if (!setEager || !callFn0) {
            throw new TypeError(
              "lazy generator: __call_fn_0/__gen_set_eager exports unavailable (host must wire setExports)",
            );
          }
          let inner: any;
          try {
            setEager(1);
            inner = callFn0(thunk);
          } finally {
            setEager(0);
          }
          const innerSt = _GeneratorState.get(inner);
          if (DBG) console.error("MATERIALIZE inner=", inner, "innerSt=", innerSt);
          if (innerSt) {
            st.buf = innerSt.buf;
            st.pendingThrow = innerSt.pendingThrow;
            st.retVal = innerSt.retVal;
          }
        };
        _GeneratorState.set(obj, st);
        return obj;
      }
      // (#2035) Read the generator's return value off the buffer's side
      // property (set by `__gen_set_return`) into the instance state so the
      // terminal `{value, done:true}` result carries it — without it ever
      // appearing as a yielded element.
      _GeneratorState.set(obj, {
        buf,
        index: 0,
        pendingThrow,
        retVal: (buf as any)?.__genReturn,
      });
      return obj;
    };
  if (name === "__create_async_generator")
    return (buf: any[], pendingThrow: any) => {
      // (#1516) Async generators share `%AsyncGeneratorPrototype%`. See the
      // matching comment on `__create_generator`. The instance is just a
      // plain object whose [[Prototype]] is the singleton — state lives in
      // `_AsyncGeneratorState`.
      // (#1639) See __create_generator — inherit from the instance prototype
      // so `Object.getPrototypeOf(instance) === asyncGenFn.prototype`.
      const proto = _getAsyncGeneratorInstancePrototype();
      const obj: any = Object.create(proto);
      _AsyncGeneratorState.set(obj, { buf, index: 0, pendingThrow });
      return obj;
    };
  // (#3123) Shared miss-arm for the __gen_* dispatchers: a registered
  // fnctor-subclass instance's `next`/`return`/`throw` is a compiled class
  // method/getter invisible to a native property read — resolve it through
  // the wasm-aware reader (class-member kind dispatch + fnctor prototype
  // walk). Gated on the registration WeakMap so every other receiver keeps
  // the exact pre-#3123 behavior.
  const genMemberFallback = (gen: any, key: string): any => {
    if (gen == null || typeof gen !== "object") return undefined;
    if (!ops.isWasmStruct(gen) || !ops.canBeWeakKey(gen) || !ops.isFnctorInstance(gen)) return undefined;
    return ops.safeGet(gen, key, callbackState);
  };
  if (name === "__gen_next")
    return (gen: any) => {
      const next = gen.next ?? ops.sidecarGet(gen, "next") ?? genMemberFallback(gen, "next");
      if (typeof next === "function") return next.call(gen);
      throw new TypeError("generator.next is not a function");
    };
  if (name === "__gen_return")
    return (gen: any, val: any) => {
      const ret = gen.return ?? ops.sidecarGet(gen, "return") ?? genMemberFallback(gen, "return");
      if (typeof ret === "function") return ret.call(gen, val);
      return { value: val, done: true };
    };
  if (name === "__gen_throw")
    return (gen: any, err: any) => {
      const thr = gen.throw ?? ops.sidecarGet(gen, "throw") ?? genMemberFallback(gen, "throw");
      if (typeof thr === "function") return thr.call(gen, err);
      throw err;
    };
  if (name === "__gen_result_value")
    return (result: any) => {
      let val = result.value;
      if (val !== undefined) return val;
      val = ops.sidecarGet(result, "value");
      if (val !== undefined) return val;
      const exports = callbackState?.getExports();
      return exports?.__sget_value?.(result);
    };
  if (name === "__gen_result_value_f64")
    return (result: any) => {
      let val = result.value ?? ops.sidecarGet(result, "value");
      if (val === undefined) {
        const exports = callbackState?.getExports();
        val = exports?.__sget_value?.(result);
      }
      return Number(val);
    };
  if (name === "__gen_result_done")
    return (result: any) => {
      let done = result.done ?? ops.sidecarGet(result, "done");
      if (done === undefined) {
        const exports = callbackState?.getExports();
        done = exports?.__sget_done?.(result);
      }
      return done ? 1 : 0;
    };
  if (name === "__gen_yield_star_step") return ops.yieldStarStepImport();
  return undefined;
}
