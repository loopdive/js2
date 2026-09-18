// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6492 r19/r20) The `%Promise%` intrinsic operations, captured ONCE at module
// load — before any user or test262 code can run — for the host imports that
// implement the compiler's own Promise plumbing.
//
// ## Why a late `Promise.<name>` property read is a defect here
//
// Every one of these imports is emitted by codegen for an operation it has
// already resolved statically, and several are reachable from a folded alias
// (`const r = Promise.resolve.bind(Promise); r(x)` lowers onto the
// `Promise_resolve` import through the const-alias fold). Reading the property
// again at call time therefore does not "respect an override" — it re-enters
// one. Measured 2026-09-18 on `built-ins/Promise/any/invoke-resolve.js`, the
// standard test262 idiom
//
//     let bound = Promise.resolve.bind(Promise);
//     Promise.resolve = function (...a) { return bound(...a); };
//
// produced unbounded recursion once #6492 r18 made the harness sandbox share
// the host `%Promise%`: honest lane `RangeError: Maximum call stack size
// exceeded`, linked lane an unwind that surfaced as `$DONE is not defined`.
//
// ## What this does NOT change: the observable `Get(C, "resolve")`
//
// The combinator entries are the intrinsic METHODS, still invoked as
// `PROMISE_INTRINSICS.all.call(C, iterable)`. §27.2.4.1.1 step 5's
// `GetPromiseResolve(C)` is performed by the engine INSIDE that call, on the
// receiver the compiled program chose — so `Promise.resolve = fn` is still
// observed by `all`/`race`/`allSettled`/`any`, which is exactly what the
// `invoke-resolve*.js` family asserts. Freezing the method being CALLED and
// freezing what that method READS are different things; only the first is done
// here.
//
// A user-visible `Promise.all(x)` / `Promise.reject(x)` call site is likewise
// unaffected: it reads the property through the ordinary member-call path.

type PromiseMethod = (this: unknown, ...args: any[]) => any;

const has = typeof Promise !== "undefined";

/** Intrinsic `%Promise%` operations. Missing engine methods stay `undefined`. */
export const PROMISE_INTRINSICS: {
  readonly resolve: (value: any) => any;
  readonly reject: (reason: any) => any;
  readonly all: PromiseMethod | undefined;
  readonly race: PromiseMethod | undefined;
  readonly allSettled: PromiseMethod | undefined;
  readonly any: PromiseMethod | undefined;
} = {
  // `resolve`/`reject` are bound: their callers never re-target the receiver,
  // and a bound pair cannot be mis-invoked with a foreign `this`.
  resolve: has ? Promise.resolve.bind(Promise) : (v: any) => v,
  reject: has
    ? Promise.reject.bind(Promise)
    : (r: any) => {
        throw r;
      },
  // The combinators stay UNBOUND — the receiver is the spec's `C` and is
  // supplied per call (`Promise.all.call(SubclassCtor, …)` is half the
  // `ctx-*.js` family).
  all: has ? (Promise.all as PromiseMethod) : undefined,
  race: has ? (Promise.race as PromiseMethod) : undefined,
  allSettled: has ? (Promise.allSettled as PromiseMethod | undefined) : undefined,
  any: has ? ((Promise as any).any as PromiseMethod | undefined) : undefined,
};
