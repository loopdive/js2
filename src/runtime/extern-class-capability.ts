// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6979 S7-d) Provider of `extern_class` imports: declared external API
 * classes (DOM, Web/URL, Node namespaces, embedder `declare class`es — the
 * `platform-capability` `extern:<Class>` family), the test262 harness error,
 * and the RegExp / Date / Intl classes of a selected host accelerator (#6978,
 * #6986). ECMAScript builtins never reach here: the publication gate rejects a
 * host extern-class import of one. Split out of `src/runtime.ts`'s
 * `resolveImport`.
 */
import type { ImportIntent } from "../index.js";
import * as intlAccel from "./intl-host-accelerator.js";
import { marshalExports } from "./init-marshal-registry.js";
import { _updateLegacyRegExpState, type LegacyRegExpState } from "./legacy-regexp.js";
import { resolveNamespacedClass } from "./node-require.js";
import * as test262Host from "./test262-harness-host.js";
import { getWebHostConstructors } from "./web-host-constructors.js";

interface CallbackState {
  getExports: () => Record<string, Function> | undefined;
}

type ExternClassIntent = Extract<ImportIntent, { type: "extern_class" }>;

/** Per-import inputs `resolveImport` threads through. */
export interface ExternClassImportEnv {
  deps: Record<string, any> | undefined;
  callbackState: CallbackState | undefined;
  legacyRegExpState: LegacyRegExpState | undefined;
  /** (#4150) Declared wasm parameter count, `self` included; undefined when unknown. */
  paramCount: number | undefined;
  /** The coherent-realm builtin lookup (`globalSandbox[name]` or the fallback). */
  builtin<T>(name: string, fallback: T): T;
}

/** The runtime's value-boundary operations this provider needs. */
export interface ExternClassHostOps {
  miss: unknown;
  isWasmStruct(value: any): boolean;
  safeGet(obj: any, key: any, callbackState?: CallbackState): any;
  safeSet(obj: any, key: any, value: any): void;
  sidecarGet(obj: any, key: any): any;
  unwrapForHost(value: any, reader?: any): any;
  wrapForHost(value: any, exports: Record<string, Function> | undefined): any;
  hostToPrimitive(value: any, hint: "number" | "string" | "default", callbackState?: CallbackState): any;
  resolveHostField(obj: any, key: any, exports: Record<string, Function> | undefined): any;
  maybeWrapCallableUnknownArity(value: any, callbackState?: CallbackState): any;
  marshalWasmDateForHost(value: any, exports: Record<string, Function> | undefined): any;
}

/**
 * (#5381) Extern-class constructors that consume a struct argument BY IDENTITY
 * — they store it, return it, or hand it back — so the default "marshal every
 * compiled struct through `_wrapForHost`" rule must not apply to them.
 *
 * `Object(x)` returns x itself (§7.1.18 ToObject on an object is the identity),
 * `Array(x)` with one non-numeric argument yields `[x]`, `WeakRef(t)` hands `t`
 * back from `deref()`, and `AggregateError`/`SuppressedError` expose their
 * `errors`/`error`/`suppressed` arguments verbatim. Wrapping any of those would
 * make the program observe a proxy where it stored a value, which is a
 * strictly worse failure than the opaque struct it gets today (the opaque
 * struct at least still compares equal to itself). `Function` is here for the
 * separate reason that its arguments are ToString'd source text.
 *
 * The wrapper and ToPrimitive constructors are excluded by their own flags at
 * the construct site rather than by this set.
 */
const structArgIdentityCtors = new Set([
  "Object",
  "Function",
  "Array",
  "WeakRef",
  "FinalizationRegistry",
  "AggregateError",
  "SuppressedError",
  "Test262Error",
]);

// (#2671) RegExp.lastIndex value-preserving slot. §22.2.7.2 RegExpBuiltinExec
// reads lastIndex as `ToLength(? Get(R, "lastIndex"))`; the setter stores the
// value verbatim. When a WasmGC struct is assigned (`r.lastIndex =
// {valueOf(){…}}`) the eventual ToLength must fire the struct's `valueOf`
// exactly once and propagate a throwing `valueOf` as the program's own error.
//
// Default (deferred) representation: store the struct behind a coercion shim
// whose ToPrimitive bridges to `hostToPrimitive`. The wasm/builtin read paths
// (native exec, the protocol methods' RegExpExec) coerce it through the
// get-import (unwrap → raw struct → wasm ToNumber) or via the shim's
// ToPrimitive, firing valueOf once and propagating a throw; the get-import
// unwraps the shim to the raw struct so an explicit `r.lastIndex` read keeps
// object identity (`assert.sameValue(r.lastIndex, obj)`).
//
// (#3084) A set DURING a regex protocol call (inside a user-overridden `exec`
// invoked by RegExp.prototype[@@match/@@replace/@@split]) ALSO defers.
// §22.2.6.8/11/14 store the assigned value verbatim; the property is only read
// as `ToLength(? Get(rx, "lastIndex"))` in the EMPTY-match advance branch, and
// V8's slow (modified-RegExp) protocol path performs exactly that read —
// measured: empty match fires the shim's valueOf via the native ToLength;
// non-empty match never reads it (so a throwing valueOf must NOT fire,
// Symbol.match/g-match-no-coerce-lastindex.js). The former eager
// protocol-depth coercion here fired valueOf unconditionally at assignment
// time, which was spec-incorrect for the non-empty-match case.
// Primitive numbers are always stored verbatim.
const lastIndexShimRaw = new WeakMap<object, any>();
function makeLastIndexShim(struct: any, callbackState: CallbackState | undefined, ops: ExternClassHostOps): any {
  const shim = {
    [Symbol.toPrimitive](hint: "number" | "string" | "default"): any {
      return ops.hostToPrimitive(struct, hint === "default" ? "number" : hint, callbackState);
    },
    valueOf(): any {
      return ops.hostToPrimitive(struct, "number", callbackState);
    },
    toString(): string {
      return String(ops.hostToPrimitive(struct, "string", callbackState));
    },
  };
  lastIndexShimRaw.set(shim, struct);
  return shim;
}

/** The host function bound to one `extern_class` import. */
export function resolveExternClassImport(
  intent: ExternClassIntent,
  env: ExternClassImportEnv,
  ops: ExternClassHostOps,
): Function {
  const { callbackState } = env;
  if (intent.className === "Document" && intent.action === "get" && intent.member === "body") {
    return (self: any) => self.body;
  }
  if (intent.className === "Document" && intent.action === "method" && intent.member === "createElement") {
    return (self: any, tagName: any, options?: any) =>
      options == null ? self.createElement(tagName) : self.createElement(tagName, options);
  }
  if (intent.action === "method" && intent.member === "addEventListener") {
    return (self: any, type: any, listener: any, options?: any) =>
      options == null ? self.addEventListener(type, listener) : self.addEventListener(type, listener, options);
  }
  if (intent.action === "new") return resolveExternClassConstructor(intent, env, ops);
  // (#2671) `RegExp.lastIndex` is a value-preserving data slot: §22.2.7.2
  // RegExpBuiltinExec (and @@match/@@replace/@@split/@@search via RegExpExec)
  // read it as `ToLength(? Get(R, "lastIndex"))` at exec time — the spec
  // stores whatever was assigned verbatim. A WasmGC-struct value
  // (`r.lastIndex = {valueOf(){…}}`) is opaque to V8's ToNumber ("Cannot
  // convert object to primitive value"), so on WRITE store a struct behind a
  // lastIndex coercion shim (`makeLastIndexShim`) whose ToPrimitive bridges
  // to the struct via `_hostToPrimitive` — native exec / @@replace can then
  // ToLength it, firing valueOf once and surfacing a *throwing* valueOf as
  // the program's own error. On READ unwrap the shim back to the raw struct
  // so an explicit `r.lastIndex` read sees the SAME object the program stored
  // (`assert.sameValue(r.lastIndex, obj)`). Primitive numbers pass through
  // untouched.
  if (intent.className === "RegExp" && intent.member === "lastIndex") {
    if (intent.action === "get") {
      return (self: any) => {
        const stored = ops.safeGet(self, "lastIndex");
        const raw = stored != null && typeof stored === "object" ? lastIndexShimRaw.get(stored) : undefined;
        return raw !== undefined ? raw : stored;
      };
    }
    if (intent.action === "set") {
      return (self: any, v: any) => {
        if (!ops.isWasmStruct(v)) {
          ops.safeSet(self, "lastIndex", v);
        } else {
          // (#3084) ALWAYS defer, protocol call or not — §22.2.6.8/11/14
          // store the value verbatim; only the empty-match advance reads it
          // (ToLength → shim fires). See the makeLastIndexShim doc block.
          ops.safeSet(self, "lastIndex", makeLastIndexShim(v, callbackState, ops));
        }
      };
    }
  }
  // (#4150) `extern_class` get/set has a STATIC string member name and a
  // receiver that is almost always an ordinary host object (a DOM node, a
  // host record). For that shape `_safeGet`/`_safeSet` reduce to a plain
  // property access — every other branch in them is keyed on the receiver
  // being a WasmGC struct or the key needing ToPropertyKey coercion, and
  // neither can happen here. Taking the direct access first skips the whole
  // preamble; the helpers still run for struct receivers, host-proxy views,
  // sidecar-only properties and failed writes, so behaviour is unchanged.
  // Measured: `_safeSet` alone was ~2/3 of `dom/modify-text`'s runtime.
  if (intent.action === "get") {
    const member = intent.member!;
    return (self: any) => {
      if (self !== null && typeof self === "object" && !ops.isWasmStruct(self)) {
        // Mirrors `_safeGet`'s own non-struct tail: native read first, and
        // only `undefined` falls through to the sidecar lookup.
        const direct = self[member];
        if (direct !== undefined) return direct;
      }
      return ops.safeGet(self, member);
    };
  }
  if (intent.action === "set") {
    const member = intent.member!;
    return (self: any, v: any) => {
      // `ops.unwrapForHost(self) === self` is the explicit form of "the helper's
      // proxy-unwrap step would be a no-op", so a `_wrapForHost` view still
      // takes the full path and writes through to its raw vec.
      if (
        self !== null &&
        typeof self === "object" &&
        !ops.isWasmStruct(self) &&
        !ops.isWasmStruct(v) &&
        ops.unwrapForHost(self) === self
      ) {
        try {
          self[member] = v;
          return;
        } catch {
          // Frozen/sealed/accessor/proxy-trap failure — the helper owns the
          // sidecar fallback and the rethrow rules.
        }
      }
      ops.safeSet(self, member, v);
    };
  }
  return resolveExternClassMethod(intent, env, ops);
}

function resolveExternClassConstructor(
  intent: ExternClassIntent,
  env: ExternClassImportEnv,
  ops: ExternClassHostOps,
): Function {
  const { deps, callbackState, builtin } = env;
  // Test262Error is a simple Error subclass used by the test262 harness
  // (#4394) Was a fresh `class Test262Error extends Error` minted per
  // resolver call, so two modules — or two imports in one module — saw
  // different constructor identities. Bound to the hoisted single class.
  const Test262Error = test262Host.HostTest262Error;
  // (#6979) ECMAScript builtins are native-regime-owned and never reach a
  // host extern-class import (the publication gate rejects them); only the
  // accelerator families (RegExp/Date/Intl), the test262 harness error and
  // the Web/URL/embedder platform classes remain.
  const builtinCtors: Record<string, Function> = {
    RegExp: builtin("RegExp", RegExp),
    Date: builtin("Date", Date),
    Test262Error,
    ...intlAccel.intlHostConstructors(), // Intl constructors (#1070, #5355; #6986: every class the `intl` accelerator registers)
    // (#1792) node:url — WHATWG URL / URLSearchParams globals (Node 18+ /
    // every browser). Registered as extern-class host constructors so
    // `new URL(...)` / `new URLSearchParams(...)` bind to the real host
    // constructor; property/method reads flow through the boundary.
    ...(typeof URL !== "undefined" ? { URL } : {}),
    ...(typeof URLSearchParams !== "undefined" ? { URLSearchParams } : {}),
    ...getWebHostConstructors(),
  };
  let Ctor = deps?.[intent.className] ?? builtinCtors[intent.className];
  // #1044 — Resolve via namespace path (e.g. require('http').Server)
  if (!Ctor && intent.namespacePath && intent.namespacePath.length > 0) {
    Ctor = resolveNamespacedClass(intent.namespacePath, intent.className, deps);
  }
  if (!Ctor)
    return (...args: any[]) => {
      throw new Error(`No dependency provided for extern class "${intent.className}"`);
    };
  // Strip trailing null/undefined args — the compiler pads missing
  // optional args with ref.null.extern, but constructors like RegExp
  // reject explicit null (e.g. new RegExp("x", null) throws).
  // EXCEPT for String/Number/Boolean: new String(undefined) must produce "undefined",
  // not "" (which new String() with no args produces).
  const isWrapperCtor =
    intent.className === "String" || intent.className === "Number" || intent.className === "Boolean";
  // (#1716) Constructors that run ToPrimitive / ToString on their
  // arguments. A WasmGC struct argument is opaque to V8's ToPrimitive, so
  // coerce it through `_hostToPrimitive` (the #1319 OrdinaryToPrimitive
  // walker) first so the compiled valueOf / toString / @@toPrimitive run.
  // `Boolean` is deliberately excluded — `new Boolean(obj)` applies
  // ToBoolean, not ToPrimitive.
  const coercesArgsToPrimitive =
    intent.className === "RegExp" ||
    intent.className === "Date" ||
    intent.className === "String" ||
    intent.className === "Number";
  const argCoercionHint: "number" | "string" | "default" =
    intent.className === "Number" ? "number" : intent.className === "Date" ? "default" : "string";
  // (#5381) A host constructor that READS PROPERTIES off an argument
  // (`Request`/`Response` init bags, `Intl.DateTimeFormat` options — the
  // #5378 Temporal chain) cannot see the fields of an opaque WasmGC
  // struct, so a compiled struct argument is marshalled through
  // `_wrapForHost` by DEFAULT. The exceptions consume an argument by a
  // protocol other than "read its properties": the wrapper and
  // ToPrimitive constructors above, and `structArgIdentityCtors`, which
  // store or return the argument itself. Primitives and host externrefs
  // are untouched: the guard is `_isWasmStruct`.
  const marshalsStructArgsForHost = !(
    isWrapperCtor ||
    coercesArgsToPrimitive ||
    structArgIdentityCtors.has(intent.className)
  );
  return (...args: any[]) => {
    if (!isWrapperCtor) {
      let len = args.length;
      while (len > 0 && args[len - 1] == null) len--;
      args = args.slice(0, len);
    }
    if (marshalsStructArgsForHost) {
      let hostExports: Record<string, Function> | undefined;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a == null || typeof a !== "object" || !ops.isWasmStruct(a)) continue;
        // Resolve exports lazily: the common case has no struct argument
        // at all, and `getExports()` is not free during module init.
        if (hostExports === undefined) hostExports = callbackState?.getExports();
        args[i] = ops.wrapForHost(a, hostExports);
      }
    }
    if (coercesArgsToPrimitive && args.length > 0) {
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a != null && typeof a === "object" && ops.isWasmStruct(a)) {
          // Throws TypeError per §7.1.1 step 6 if no chain yields a
          // primitive — the spec-correct outcome here too.
          args[i] = ops.hostToPrimitive(a, argCoercionHint, callbackState);
        }
      }
    }
    return new Ctor(...args);
  };
}

function resolveExternClassMethod(
  intent: ExternClassIntent,
  env: ExternClassImportEnv,
  ops: ExternClassHostOps,
): Function {
  const { callbackState, paramCount } = env;
  const m = intent.member!;
  // (#1794) node:events EventEmitter listener-registering methods — the
  // listener argument may be a WasmGC closure struct (no [[Call]]); Node
  // validates `typeof listener === "function"` and throws
  // ERR_INVALID_ARG_TYPE on the raw struct. Wrap it as a JS callable via
  // the identity-CACHED dynamic bridge (`_wasmClosureDynamicWrapperCache`),
  // so `on(h)` and `off(h)` receive the SAME wrapper and removeListener
  // identity-matches. Direct arrow args already crossed via
  // `__make_callback`; this covers variable-held closures.
  if (
    intent.className === "EventEmitter" &&
    (m === "on" ||
      m === "once" ||
      m === "off" ||
      m === "addListener" ||
      m === "removeListener" ||
      m === "prependListener" ||
      m === "prependOnceListener")
  ) {
    return (self: any, ...args: any[]) => {
      if (self == null) return undefined;
      const wrappedArgs = args.map((a) => ops.maybeWrapCallableUnknownArity(a, callbackState));
      const fn = self[m] ?? ops.sidecarGet(self, m);
      if (typeof fn === "function") return fn.call(self, ...wrappedArgs);
      return undefined;
    };
  }
  // (#4150) The generic method shim is the DOM lane's hot path — 5,000 of
  // `dom/set-attributes`'s 7,000 crossings land here — and its rest
  // parameter allocated a fresh args array on every one of them. #3903
  // removed the inner spread but left the rest param and the `.apply`.
  // The wasm import signature fixes the argument count exactly
  // (`paramCount` counts `self` plus the method's own parameters), so build
  // a fixed-signature closure for the common arities and route the args
  // through the SAME body. `genericMethodCall` below is that shared body,
  // unchanged in behaviour: null check, sidecar fallback, wasm-struct arg
  // wrapping, the #3903 arity switch, and the #1333 legacy-RegExp hook.
  const invokeMethod = (self: any, args: any[]): any => {
    if (self == null) return undefined;
    // Method call — check sidecar if direct method missing
    let fn = self[m] ?? ops.sidecarGet(self, m);
    // (#4618) The any-receiver first-match binding (tryExternClassMethodOnAny)
    // routes WasmGC-STRUCT receivers here under a colliding ambient method
    // name (react's `element.type()` bound `CSSNumericValue_type`). An
    // opaque `self[m]` read and the sidecar both miss the struct's typed
    // FIELDS, and a stored raw closure struct is not yet callable — so the
    // call silently answered undefined. Resolve through the same
    // struct-aware field reader __extern_method_call uses, then wrap.
    if (typeof fn !== "function") {
      if (ops.isWasmStruct(self)) {
        const resolved = ops.unwrapForHost(ops.resolveHostField(self, m, callbackState?.getExports()));
        const wrapped = ops.maybeWrapCallableUnknownArity(resolved, callbackState);
        if (typeof wrapped === "function") fn = wrapped;
      } else if (ops.isWasmStruct(fn)) {
        const wrapped = ops.maybeWrapCallableUnknownArity(fn, callbackState);
        if (typeof wrapped === "function") fn = wrapped;
      }
    }
    if (typeof fn === "function") {
      // (#1332) Wrap wasmGC-struct args via _wrapForHost so a native
      // prototype method (e.g. RegExp.prototype.exec/test) can ToString
      // or read properties off an opaque wasm struct argument. Mirrors
      // the Set-method path above and __extern_method_call.
      // (#3903) `args.some(a => ops.isWasmStruct(a))` allocated a closure on
      // every crossing; a plain loop is the same predicate. This shim is
      // the DOM lane's hot path — `dom/create-elements` makes 2,000
      // `extern_class` crossings per `run()` against a mock whose whole
      // body is one allocation, so per-crossing overhead is essentially
      // the entire measurement there.
      const exports = callbackState?.getExports();
      let hasStructArg = false;
      for (let i = 0; i < args.length; i++) {
        if (ops.isWasmStruct(args[i])) {
          hasStructArg = true;
          break;
        }
      }
      let callArgs = args;
      if (hasStructArg) {
        // (#5211) A struct argument was marshalled with `_wrapForHost`
        // ALONE, so a compiled CLOSURE crossed as a data facade with no
        // [[Call]] — `n.sort(cmp)` on an `any` receiver (first-matched to
        // `Uint8ClampedArray_sort`) reached native `Array.prototype.sort`
        // as `[object Object]` and threw "The comparison function must be
        // either a function or undefined". Unlike the rest of the
        // init-window series this was NOT a timing bug: it reproduced
        // identically before and after instantiation, because
        // `_wrapForHost` never builds a callable for a closure struct.
        // Apply the same two-step marshalling every other host-dispatch
        // path already uses (`wrapHostValue` in `__extern_method_call`,
        // the keyed-collection arm above, `wrapLinkedProviderValue`):
        // callable bridge first, host facade otherwise.
        //
        // HOT PATH: the added work stays inside `hasStructArg`; the DOM
        // benchmarks never take it, and fixed-arity wrappers bypass this
        // function. A NON-closure struct argument keeps exactly its previous
        // `_wrapForHost` result: `_maybeWrapCallableUnknownArity` asks the
        // module's own `__is_closure` discriminator and returns the value
        // unchanged for anything else.
        //
        // `marshalExports` (not the strict `exports` local) is the #5209
        // marshalling-only view: wrapping a compiled value into its host
        // facade may use the `ref.func` helpers the module registered on
        // itself during its start section, while `exports` stays the
        // post-instantiation set that the arms below read as "init has
        // finished".
        const marshalExp = marshalExports(callbackState, exports);
        callArgs = new Array(args.length);
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (!ops.isWasmStruct(a)) {
            callArgs[i] = a;
            continue;
          }
          const callable = ops.maybeWrapCallableUnknownArity(a, callbackState);
          if (callable !== a) {
            callArgs[i] = callable;
            continue;
          }
          // (#5208) THE measured crossing point. Instrumenting `_wrapForHost`
          // and running the 123-row #5249 Temporal family provider-linked
          // showed exactly ONE site where a compiled `Date` reaches a host
          // function in the whole @js-temporal/polyfill: here, as the
          // argument of `Intl_DateTimeFormat_formatToParts`, from
          // `HelperBase_getCalendarParts` (and once from
          // `ChineseBaseHelper_getMonthList`). The generic proxy made the
          // host throw `RangeError: Invalid time value`, which the
          // polyfill's own `catch` rewrote into `Invalid ISO date` — 68 of
          // the 123 rows.
          const hostDate = ops.marshalWasmDateForHost(a, marshalExp);
          callArgs[i] = hostDate !== ops.miss ? hostDate : ops.wrapForHost(a, marshalExp);
        }
      }
      // (#3903) Arity switch instead of `fn.call(self, ...callArgs)` — same
      // `Function.prototype.call` invocation, without materialising the
      // spread's argument list on every crossing.
      let ret: any;
      switch (callArgs.length) {
        case 0:
          ret = fn.call(self);
          break;
        case 1:
          ret = fn.call(self, callArgs[0]);
          break;
        case 2:
          ret = fn.call(self, callArgs[0], callArgs[1]);
          break;
        case 3:
          ret = fn.call(self, callArgs[0], callArgs[1], callArgs[2]);
          break;
        default:
          ret = fn.call(self, ...callArgs);
          break;
      }
      // (#1333) Annex B §22.2.7.2 — RegExpBuiltinExec updates the legacy
      // static slots after every successful match. Hook exec/test on a
      // RegExp receiver with a string first arg.
      if ((m === "exec" || m === "test") && self instanceof RegExp && typeof callArgs[0] === "string") {
        const input = callArgs[0] as string;
        if (m === "exec" && ret != null) {
          _updateLegacyRegExpState(input, ret as RegExpExecArray, env.legacyRegExpState);
        } else if (m === "test" && ret === true) {
          // .test() also updates the slots per spec. Re-run exec on a
          // non-sticky/non-global clone so we don't perturb self.lastIndex.
          try {
            const clone = new RegExp(self.source, self.flags.replace(/[gy]/g, ""));
            const m2 = clone.exec(input);
            if (m2) _updateLegacyRegExpState(input, m2, env.legacyRegExpState);
          } catch {
            // best-effort — bad source/flags shouldn't break .test()
          }
        }
      }
      return ret;
    }
    return undefined;
  };
  // Fixed-signature wrappers over the SAME body. `paramCount` includes
  // `self`, so a 0-arg method has paramCount 1.
  //
  // These do not merely forward into `invokeMethod` — boxing the arguments
  // into an array literal to do that measured WORSE than the rest form
  // (dom/set-attributes 2.54x -> 3.31x), because the literal escapes into a
  // non-inlined callee and becomes a real heap allocation where V8 had been
  // sinking the rest array. Instead each arm inlines the ordinary case —
  // resolve the method, confirm no argument is a WasmGC struct, call it
  // directly — and hands anything unusual to the shared body, which still
  // owns the sidecar fallback, the `_wrapForHost` argument wrapping and the
  // #1333 legacy-RegExp hook. The array is then allocated only on the paths
  // that were already doing extra work.
  const needsLegacyRegExpHook = m === "exec" || m === "test";
  if (!needsLegacyRegExpHook) {
    switch (paramCount) {
      case 1:
        return (self: any) => {
          if (self != null) {
            const fn = self[m];
            if (typeof fn === "function") return fn.call(self);
          }
          return invokeMethod(self, []);
        };
      case 2:
        return (self: any, a: any) => {
          if (self != null && !ops.isWasmStruct(a)) {
            const fn = self[m];
            if (typeof fn === "function") return fn.call(self, a);
          }
          return invokeMethod(self, [a]);
        };
      case 3:
        return (self: any, a: any, b: any) => {
          if (self != null && !ops.isWasmStruct(a) && !ops.isWasmStruct(b)) {
            const fn = self[m];
            if (typeof fn === "function") return fn.call(self, a, b);
          }
          return invokeMethod(self, [a, b]);
        };
      case 4:
        return (self: any, a: any, b: any, c: any) => {
          if (self != null && !ops.isWasmStruct(a) && !ops.isWasmStruct(b) && !ops.isWasmStruct(c)) {
            const fn = self[m];
            if (typeof fn === "function") return fn.call(self, a, b, c);
          }
          return invokeMethod(self, [a, b, c]);
        };
    }
  }
  return (self: any, ...args: any[]) => invokeMethod(self, args);
}
