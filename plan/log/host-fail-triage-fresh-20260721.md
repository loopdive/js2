# Host-lane test262 fail triage — fresh authoritative baseline 2026-07-21

**Source**: `benchmarks/results/test262-results-20260721-042158.jsonl` (fresh full
run against current `main`, post +144 / post #3461(+40) + #3462(+88); NO stale
"ghost" entries). Host oracle-v8 lane, `oracle_version: 9`.

**Headline**: **29,540 / 43,106 host (68.5%)**. 17,999 fails. This triage mines
the fresh data to justify next-window planning. **Conclusion: the clean, low-risk,
high-flip *localized single-cause* wins are mined out** (the last two — #3511 +40,
#3512 +88 — were them). The remaining tail is broad surfaces, deep value-substrate,
big features, and skip-features → **architect-spec epics, not dev quick-fixes.**

Grouping key: `error_signature` / `error_category` (fresh fields) + test directory.
"non-skip" excludes Temporal, SharedArrayBuffer, Atomics, WeakRef,
FinalizationRegistry, dynamic-import, ShadowRealm, Proxy, async/await, eval, with.

## Ranked non-skip clusters + verdict

| # | Cluster (signature) | Size | Verdict | Why / next step |
|---|---|---|---|---|
| 1 | `TypeError: Cannot access property on null or undefined` | 1030 (~640 non-skip TypedArray) | **BROAD** | Dominated by TypedArray prototype/ctors — many methods null-deref for *different* reasons (receiver/buffer/length). Not one cause. Partly overlaps #3488 (reflective null-receiver, slice (a) landed +16). Per-method work. |
| 2 | `Expected a TypeError to be thrown but no exception was thrown` | 452 | **BROAD** | Missing-throw negative tests across many operations. No single localized sub-cause dense enough. |
| 3 | `TypeError: Cannot convert <N> to a BigInt (Testing with BigInt…)` | 359 (~261 non-Temporal) | **DEEP substrate** | BigInt typed arrays: a **Number** reaches ToBigInt → **bigint-brand-loss** (same value-substrate as #3481: brand lost through method-call/closure return). Architect-spec the value-rep/bigint-brand epic. |
| 4 | `No dependency provided for extern class "<X>"` | 232 | **RISKY/varied** | Local user-defined constructors (`ctor`, `differentTA`, `badArrayType`, custom species) misclassified as **extern classes** needing a host binding. Codegen classification bug; varied shapes → medium risk. Candidate for a *scoped* codegen slice if narrowed to one shape. |
| 5 | `invalid Wasm binary … any.convert_extern[0] expected externref, found struct/funcref` | 187 non-skip (67 = `Function/prototype/toString`) | **DEEP-ish (funcref/closure-value)** | Single wasm-validation signature: a **funcref** (captured function / arrow, from a closure struct field) fed to `any.convert_extern` (needs externref) → invalid module. The 67 `toString` all crash compiling the closure-heavy `nativeFunctionMatcher.js` harness AND need real source-text `Function.prototype.toString` → **compile-fix flips 0 there**. The ~120 non-toString (lang/expr, lang/stmt, Array) share the crash; flip value **unknown** → the one BOUNDED "make-it-compile + measure" gamble (see below). Fix is closure-value-tracking substrate → ballooning risk. |
| 6 | `assert is not defined` | 183 | **SKIP** | All `annexB/language/eval-code` — eval is a skip-feature. |
| 7 | `Cannot convert undefined or null to object [in verifyProperty]` | 154 (~130 non-skip) | **MISSING BUILTINS** | verifyProperty on `.name`/`.length` of **unimplemented** builtins (`WeakMap.prototype.getOrInsert`, new proposal methods, some `NativeErrors`, `decodeURIComponent.name`). Many individual missing builtins, not one cause. |
| 8 | `foo doesn't appear as an own property on the C constructor` | 148 | **PARTLY DONE / gated** | #3512 (+88) fixed the non-private-name instance-field-leak. Remainder is **private-name-gated** (`*-rs-static-privatename-*`) — needs private-name support (separate feature). |

Also present but skip/deferred: `Temporal is not defined` (1177), `Dynamic new K(...x)`
spread (1265, ~99% Temporal), async-test-failure clusters — all skip-feature or
async territory.

## What this implies for next-window planning

The 68.5% plateau is **structural**: the remaining 31.5% concentrates in a handful
of **architect-scale** themes, each worth its own spec:

1. **Value-rep / ToBigInt-brand substrate** (cluster #3, + the #3481 bigint-wrapper
   epic, + parts of #1) — bigint brand lost across method-call/closure/typed-array
   boundaries. Highest-leverage substrate.
2. **Closure-value / funcref-as-any substrate** (cluster #5) — funcref boxing to
   externref/any; the `any.convert_extern found funcref` crash class.
3. **TypedArray per-method semantics** (cluster #1, #2 partial) — broad, incremental.
4. **`Function.prototype.toString` source reconstruction** (cluster #5, 67) — a real
   feature (return exact source text), not a bug-fix.
5. **Missing-builtin batch** (cluster #7) — implement the unimplemented methods
   `.name`/`.length` reflection depends on.
6. **Private class names** — unblocks cluster #8 remainder + the `rs-static-privatename`
   family broadly.

Dev quick-fixes are exhausted here; these are PO/architect items.
