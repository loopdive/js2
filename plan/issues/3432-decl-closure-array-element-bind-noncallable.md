---
id: 3432
title: "Top-level function-declaration closures stored in array literals read back host-non-callable inside nested functions (testTypedArray harness, ~1.8k tests)"
status: done
created: 2026-07-18
completed: 2026-07-18
assignee: ttraenkler/fable-5
priority: high
feasibility: hard
task_type: bugfix
area: codegen-closures
goal: test262-conformance
model: fable
sprint: current
horizon: m
related: [3419, 3417, 3370]
# Site-required: the skip-gate + rationale live at the exact match-and-recast
# arm in variables.ts (mostly comment lines documenting the #2873 RTT hazard).
loc-budget-allow:
  - src/codegen/statements/variables.ts
  # Follow-up (CI-FIX #16): the skipped-recast decl registry field doc lives
  # with the other closure maps in context/types.ts, and the per-decl gate
  # check belongs inside calleeMayBeHostCallable (calls.ts) next to the #1941
  # rationale it amends — mostly comment lines.
  - src/codegen/context/types.ts
  - src/codegen/expressions/calls.ts
---

# #3432 — `argFactory.bind` non-callable: declaration-closures in arrays lose host callability

## Problem

With #3419 landed (duplicate-`isPrimitive` early error fixed, var-counter i32
gate, sandbox TypedArray globals), the former 2,050-test `Duplicate identifier`
bucket now executes and dies overwhelmingly (34/40 of a deterministic sample) at:

```
TypeError: Function.prototype.bind called on non-callable
  in testWithAllTypedArrayConstructors() at testTypedArray.js:269
  var boundArgFactory = argFactory.bind(undefined, constructor);
```

## Verified reduction (2026-07-18, fable-5)

Per-element probe over `typedArrayCtorArgFactories`
(`[makePassthrough, makeArray, makeArrayLike]` + pushes) read **inside a nested
function** through an alias (`var ctorArgFactories = typedArrayCtorArgFactories`):

```
k0:ERR k1:ERR k2:ERR k3:ok(function) k4:ERR k5:ERR k6:ERR k7:ERR
```

- k0-2 (`makePassthrough/makeArray/makeArrayLike`) — top-level **function
  declarations** referenced in the array literal → `.bind` throws non-callable.
- k3 (`makeIterable`) — **function expression** assigned to a var, `.push`ed →
  `.bind` works.
- k4 (`makeArrayBuffer`) — declaration, `.push`ed → ERR. k5-7 — expressions
  assigned inside an `if` block → ERR (so expression-vs-declaration is not the
  whole story; k3 vs k5-7 differ in… TBD — k3 is guarded by `typeof Symbol`,
  k5-7 by `ArrayBuffer.prototype.resize` and close over `copyIntoArrayBuffer`).
- Reading the SAME array at **top level** (module init): every element's
  `typeof` is "function" and `.bind` works (fake-bind4 probe passed).
- Minimal shapes (`function add(){}; var fs=[add]; fs[0].bind(undefined,2)`)
  pass — the loss needs the nested-function + aliased-read context.

`typeof argFactory === "function"` SUCCEEDS on the same value whose `.bind`
throws — so the wrapper is recognized by `__typeof` but the host
`__extern_method_call(recv, "bind", …)` receiver is not a callable bridge
(likely the raw closure-struct wrapper instead of a `_wrapForHost` function
bridge). Suspect the dynamic element-read path inside a function returns the
un-bridged element, while the top-level read path (or the store path used by
`.push` from a var holding an already-bridged closure) preserves callability.

Repro probes (copy into `.tmp/`): see #3419's `## Follow-up filed` section;
probe files `fake-bind5.js` / `fake-bind6.js` shapes are embedded there.

## Value

~1,800 tests (the residual of the 2,050 bucket) in `built-ins/TypedArray*` —
the single largest post-#3419 recovery lever in the host lane.

## Root cause (verified 2026-07-18, fable-5) — NOT a host-bridge bug

The nulls appear at the **`var f = fs[k]` assignment**, not at `.bind` and not
in the array. WAT of the failing `probe()`:

```
array.get 1            ;; element (externref)
any.convert_extern
ref.test (ref 30)      ;; ONE signature-matched closure wrapper type
(if (then ref.cast null 30) (else ref.null 30))   ;; ← sibling wrappers NULLED
extern.convert_any
local.set $f           ;; f is an externref slot — the narrow was pointless
```

Emitter: `src/codegen/statements/variables.ts` "initializer returned externref
but the type is callable" arm — it signature-matches ONE entry from
`ctx.closureInfoByTypeIdx` (map-iteration order = creation order) and
`emitGuardedRefCast`s to that struct. Closure wrapper structs are sibling
`sub final` types whose RTTs are creation-ORDER-dependent (#2873 —
`reference_2873_funcref_wrapper_chain_rtt_order`), so every stored closure of a
sibling wrapper nulls out. Because the slot is externref (var-hoisted), the
narrowed value was immediately widened BACK to externref — the cast had zero
upside and destroyed values. Position-dependence explained: include-position vs
body-position changes wrapper creation order, which flips WHICH elements
survive (k3-only vs k0-2+k4).

At top level the same read works because module-global slots take the plain
externref path (no matched-cast) — confirmed by an all-8-elements-visible
top-level dump of the identical array.

## Fix

`variables.ts`: skip the match-and-recast whenever the local slot is (stays)
externref — the #962 guard already refused to narrow such slots, so the cast
could never help there; the closure value now survives verbatim and
`.bind`/calls dispatch via the externref-callee path. Slots that genuinely
narrow keep the old behavior (follow-up hazard note: that residual cast still
targets an arbitrary first-match wrapper — the #2873 root-cast pattern would be
the full fix; no corpus hit once the externref-slot case is fixed).

Result: all 8 `typedArrayCtorArgFactories` elements bind (`k0..k7:ok`); the
40-file bucket sample progresses past the bind blocker into heterogeneous
next-layer TypedArray substrate gaps (dynamic `new TA()` extern-class dependency,
`ta.constructor` property reads) — filed observations in the sample table below.

Post-fix sample error distribution (40 files, was 34× bind-non-callable):
`No dependency provided for extern class "TA"` ×10 · `Cannot access property on
null or undefined` (ta.constructor / TA.prototype reads) ×12 · assorted ×13 ·
pass 5.

## Suggested starting points (original hypothesis — superseded by root cause above)

- Host bridge: `_wrapForHost` / `__make_callback` / wasmClosureDynamicBridge in
  `src/runtime.ts` — what does `__extern_method_call` receive for a closure
  element read out of a wasm vec via the externref path?
- Codegen: array-literal element store for identifier references to top-level
  function declarations (closure materialization — does it store the raw
  closure struct where the dynamic read path expects a host-bridged value?).
- Compare the top-level read path (works) vs nested-function aliased read
  (fails) to find where the bridging diverges.

## Follow-up (merge_group park fix, CI-FIX #16 — 2026-07-19)

The skip-recast guard over-applied at DIRECT-CALL sites: skipping also dropped
the "matched-closure-struct or null" normalization that the #1941 gate
(`calleeMayBeHostCallable`) relies on to omit the #1712 `__call_function`
fallback arm. A foreign callable left raw in the externref slot (host builtin,
bound function, bridge-wrapped closure read off a property — harness
`var format = compareArray.format; … format(actual)`) reached the
closure-struct dispatch, where the guarded root cast nulls and `struct.get`
traps "dereferencing a null pointer" → the +107 `null_deref` merge_group
bucket on PR #3370 (those files were already `fail` on main with a catchable
TypeError; the skip converted them to uncatchable traps).

Fix: record each decl taking the skip path in
`ctx.skippedClosureRecastDecls` (context/types.ts) and return true from
`calleeMayBeHostCallable` for exactly those decls, so their direct-call
sites emit the host-dispatch arm. Verified: regressed cluster files
(concat/copyWithin/flat) no longer trap (back to catchable Test262Error);
TypedArray bind behavior byte-identical to PR head; #1941 dual-mode guard
test still green; new unit test in `tests/issue-3432.test.ts` (host builtin
in a skipped-recast var direct-called → PASS, was null-deref trap).
