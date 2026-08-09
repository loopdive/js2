// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3603 S1, root cause B) Write-back for `__make_iterable` vec mirrors.
// Host-side only; emits zero Wasm and changes no compiled bytes.
//
// ── The defect this closes ─────────────────────────────────────────────────
//
// `__make_iterable`'s `convertToJS` materialises a WasmGC vec struct into a
// REAL JS array so native host APIs (`Array.prototype.*`, spread, JSON, Map/Set)
// see an array, and it REFRESHES that array FROM the vec on every crossing
// (#3368, so ECMAScript array identity survives assignment through `any` slots).
// Reads are therefore correct — but any host-side MUTATION of the mirror is
// silently dropped: the vec never learns about it and the next crossing
// overwrites the mirror.
//
// So `Array.prototype.push` applied to a compiled array THROUGH the host is a
// SILENT NO-OP. Both dispatch shapes are affected, and they share this one
// cause (traced through the import bridge, not inferred):
//
//   Array.prototype.push.call(a, x)   → __extern_method_call(push, "call", [mirror, x])
//   __push(a, x)  (uncurryThis)       → __call_function(boundCall, null, [mirror, x])
//
// That is precisely why test262's `propertyHelper.js` is vacuous on the JS-host
// lane: it accumulates through
// `var __push = Function.prototype.call.bind(Array.prototype.push)`, so
// `failures.length` stays 0, the terminal
// `assert(false, __join(failures, '; '))` never fires, and `verifyProperty`
// returns `true` for ANY expectation.
//
// ── The mechanism ──────────────────────────────────────────────────────────
//
// `registerVecMirror` records mirror → vec when `__make_iterable` builds one.
// The host-call bridges then BRACKET their dispatch with
// `snapshotVecMirrors` / `reconcileVecMirrors`: if the callee changed a
// mirror's LENGTH, the change is replayed onto the vec using only the
// unconditionally-emitted `__vec_pop` / `__vec_push` exports — pop back to the
// longest common prefix, then push the mirror's tail. That is exact for
// `push` / `pop` / `shift` / `unshift` / `splice`, i.e. every mutator that
// changes length.
//
// ── Deliberate limitations (not oversights) ────────────────────────────────
//
//  * A LENGTH-PRESERVING in-place mutation (`sort` / `reverse` / `fill` /
//    `copyWithin`, or a bare `arr[i] = x`) is NOT reconciled. Detecting one
//    requires an element-by-element compare on EVERY host crossing (O(n) even
//    when nothing changed), and replaying it requires an element-setter export
//    (`__vec_set_elem`) that is only emitted when a module imports
//    `Object.defineProperty`. Those stay silent no-ops exactly as before.
//  * If the vec's OWN length also moved during the call (the callee re-entered
//    Wasm and mutated the same vec), the two edits cannot be ordered, so
//    reconciliation is SKIPPED rather than guessed at — Wasm-side state wins,
//    which is the pre-#3603 behaviour.

// ── Intrinsic capture — REQUIRED, not defensive style ──────────────────────
//
// This registry is a real `WeakMap`, and test262 MUTATES HOST INTRINSICS.
// `propertyHelper.js`'s `verifyProperty` is DESTRUCTIVE by design: its
// `isConfigurable` probe does `delete obj[name]`. So
// `test/built-ins/WeakMap/prototype/get/get.js` — which calls
// `verifyProperty(WeakMap.prototype, "get", …)` — DELETES
// `WeakMap.prototype.get` out from under the whole realm. Any later
// `_vecMirrorSource.get(…)` then throws
// `TypeError: _vecMirrorSource.get is not a function`, turning an unrelated
// passing test into a failure.
//
// That is not hypothetical: it was measured on merge_group 30179758665 as a
// real regression caused by this module (1 file), and it is exactly the trap
// #3603 already documents — "verifyProperty is destructive … the host lane
// shares real host builtins across in-process runs".
//
// Capturing the methods at MODULE LOAD (before any test body runs) and
// invoking them through a captured `Reflect.apply` makes this module immune:
// no property lookup on `WeakMap.prototype`, and no lookup of `.call` on the
// method either, at call time.
const _apply = Reflect.apply;
const _wmGet = WeakMap.prototype.get;
const _wmSet = WeakMap.prototype.set;

/** mirror JS array → the WasmGC vec struct it was materialised from. */
const _vecMirrorSource = new WeakMap<object, unknown>();

/** `map.get(key)` that cannot be broken by a test deleting `WeakMap.prototype.get`. */
function _mirrorGet(key: object): unknown {
  return _apply(_wmGet, _vecMirrorSource, [key]);
}

/** `map.set(key, value)` that cannot be broken by a test deleting `WeakMap.prototype.set`. */
function _mirrorSet(key: object, value: unknown): void {
  _apply(_wmSet, _vecMirrorSource, [key, value]);
}

export type VecMirrorSnapshot = {
  mirror: unknown[];
  vec: unknown;
  mirrorLen: number;
  vecLen: number;
};

type Exports = Record<string, Function> | undefined;

/** Record a `__make_iterable` mirror so its mutations can be replayed onto the vec. */
export function registerVecMirror(mirror: unknown[], vec: unknown): void {
  _mirrorSet(mirror, vec);
}

/**
 * The vec a mirror was materialised from, or `undefined` when `v` is not a
 * mirror. Used to reverse a nested vec element back to its struct before it is
 * pushed into a vec.
 */
export function vecForMirror(v: unknown): unknown {
  if (v == null || typeof v !== "object") return undefined;
  return _mirrorGet(v as object);
}

/** Shared no-mirrors result — `__extern_method_call` / `__call_function` are HOT paths; the common case must not allocate. */
const NO_MIRRORS: readonly VecMirrorSnapshot[] = Object.freeze([]);

/**
 * Snapshot the lengths of every vec mirror among `receiver` + `args`, BEFORE a
 * host call. Receiver and args are passed SEPARATELY (rather than as one
 * spread array) precisely because these bridges are hot: the overwhelmingly
 * common case — no mirror anywhere — costs one WeakMap probe per value and
 * allocates nothing.
 */
export function snapshotVecMirrors(
  receiver: unknown,
  args: readonly unknown[],
  exports: Exports,
): readonly VecMirrorSnapshot[] {
  if (!exports) return NO_MIRRORS;
  const lenFn = exports.__vec_len as ((v: unknown) => number) | undefined;
  if (typeof lenFn !== "function") return NO_MIRRORS;
  let snaps: VecMirrorSnapshot[] | undefined;
  // (#3673) Inline loop, no per-call closure: this runs on every
  // `__extern_method_call` / `__call_function` crossing, and a fresh closure
  // per call is measurable there (the transform-added name-defineProperty per
  // closure made it worse under tsx).
  for (let i = -1; i < args.length; i++) {
    const v = i < 0 ? receiver : args[i];
    if (v == null || typeof v !== "object") continue;
    const vec = _mirrorGet(v as object);
    if (vec === undefined) continue;
    let vecLen: number;
    try {
      vecLen = lenFn(vec);
    } catch {
      continue;
    }
    if (typeof vecLen !== "number" || vecLen < 0) continue;
    const mirror = v as unknown[];
    // Index assignment, not `.push()` — see the intrinsic-capture note above:
    // a test262 file may have deleted `Array.prototype.push` by now.
    const list = (snaps ??= []);
    list[list.length] = { mirror, vec, mirrorLen: mirror.length, vecLen };
  }
  return snaps ?? NO_MIRRORS;
}

/**
 * Replay length-changing host mutations of the snapshotted mirrors back onto
 * their vecs, AFTER the host call returns.
 *
 * `unwrap` reverses a host value to the raw wasm handle the vec should store
 * (runtime.ts passes `_unwrapForHost`); nested mirrors are reversed here first.
 */
export function reconcileVecMirrors(
  snaps: readonly VecMirrorSnapshot[],
  exports: Exports,
  unwrap: (v: unknown) => unknown,
): void {
  if (snaps.length === 0 || !exports) return;
  const lenFn = exports.__vec_len as ((v: unknown) => number) | undefined;
  const getFn = exports.__vec_get as ((v: unknown, i: number) => unknown) | undefined;
  const pushFn = exports.__vec_push as ((v: unknown, x: unknown) => number) | undefined;
  const popFn = exports.__vec_pop as ((v: unknown) => unknown) | undefined;
  const mutSupFn = exports.__vec_mut_supported as ((v: unknown) => number) | undefined;
  if (
    typeof lenFn !== "function" ||
    typeof getFn !== "function" ||
    typeof pushFn !== "function" ||
    typeof popFn !== "function"
  ) {
    return;
  }
  for (const snap of snaps) {
    const { mirror, vec, mirrorLen, vecLen } = snap;
    // Untouched by the callee, or a length-preserving edit (out of scope).
    if (mirror.length === mirrorLen) continue;
    let liveVecLen: number;
    try {
      liveVecLen = lenFn(vec);
    } catch {
      continue;
    }
    // The vec moved on its own (callee re-entered Wasm) — ambiguous, skip.
    if (liveVecLen !== vecLen) continue;
    try {
      if (typeof mutSupFn !== "function" || mutSupFn(vec) !== 1) continue;
    } catch {
      continue;
    }
    // Longest common prefix between the vec and the mutated mirror. Elements
    // compare by identity (primitives, raw structs) or through the mirror
    // registry (a nested vec element crosses as its own mirror).
    let keep = 0;
    // Not `Math.min` — a deletable intrinsic (see the capture note above).
    const min = vecLen < mirror.length ? vecLen : mirror.length;
    let scanFailed = false;
    while (keep < min) {
      let raw: unknown;
      try {
        raw = getFn(vec, keep);
      } catch {
        scanFailed = true;
        break;
      }
      const m = mirror[keep];
      if (m !== raw && vecForMirror(m) !== raw) break;
      keep++;
    }
    if (scanFailed) continue;
    // Apply as pop-back-to-prefix + push-tail, but keep the popped suffix so a
    // failed push can UNDO the whole thing. `__vec_mut_supported` already said
    // this vec's element kind is covered, so a `-1` push should be
    // unreachable — but a partially-applied reconcile would silently TRUNCATE
    // live data, which is strictly worse than the no-op we are replacing.
    // All-or-nothing is the only safe contract here.
    const popped: unknown[] = [];
    try {
      for (let i = vecLen; i > keep; i--) popped[popped.length] = popFn(vec);
      for (let i = keep; i < mirror.length; i++) {
        const m = mirror[i];
        const raw = vecForMirror(m) ?? unwrap(m);
        if (pushFn(vec, raw) < 0) throw new Error("vec push rejected");
      }
    } catch {
      // Roll back to the pre-reconcile contents: drop whatever we managed to
      // push, then restore the popped suffix in its original order. Never let
      // any of this escape as a host throw.
      try {
        for (let n = lenFn(vec); n > keep; n--) popFn(vec);
        for (let i = popped.length - 1; i >= 0; i--) pushFn(vec, popped[i]);
      } catch {
        /* nothing further we can do without making it worse */
      }
    }
  }
}
