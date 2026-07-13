# Standalone host-free `assertion_fail` dispatch map

**Source:** promoted standalone baseline `test262-standalone-current.jsonl`
(2026-07-13 22:20 UTC), `status==fail && error_category==assertion_fail &&
host-free` = **9,742**. Sub-bucketed by (test262 area × normalized assert
signature) with sampled root-cause verdicts (opus-defineprop2, 2026-07-13).

**Caveats:**
- Sizes are single-run, NOT cold-isolated. Apply the ~±0.6% (~277-test)
  run-to-run flake band before committing a dispatch. That flake is dominated
  by deterministic Math/parseInt/Date reorder effects — **none of the clusters
  below sit in that band**, so they are structural, not flake churn.
- `built-ins/Temporal` (942) EXCLUDED — deferred feature, not a dispatch target.
- Verify each pick's size cold (fresh standalone run) before dispatching a wave,
  especially the overlap-flagged ones.

## Dispatch queue (top sub-clusters)

| # | Cluster | Size | Root verdict | Overlap / notes |
|---|---------|------|--------------|-----------------|
| 1 | **annexB B.3.3 function-in-block** (`annexB/language/*`) | 96 | **SHARED-ROOT, single semantic** | `assert.throws(ReferenceError, ()=>f)` — a block/switch fn-decl with a conflicting lexical `let f` must NOT create the AnnexB outer `var` binding; we hoist it so `f` resolves. Suppress the AnnexB hoist when a conflicting lexical binding is in scope. Likely BOTH-LANE. **CLEANEST pick.** → in-flight (opus-defineprop2) |
| 2 | **class/elements** (`language/statements/class/elements`) | 222 | **SHARED-FEATURE, MULTI-ROOT** | field/private-method PLACEMENT (`!hasOwnProperty.call(C/C.prototype,"a")` ~49; `throws(SyntaxError,new C())` 14; verifyProperty 9). Decompose into 2–3 slices (field placement / private access / early errors). Biggest single lever. |
| 3 | **Iterator Helpers** (`built-ins/Iterator/prototype`) | 198 | **SHARED-FEATURE, ~2–3 roots** | find/some/take/every/map/filter/reduce/flatMap: brand-check TypeError (25), getPrototypeOf (11), lazy "next should not be read" (10). ⚠️ **OVERLAPS #3249** iterator-ladder-triage (PR #3036 merged) — coordinate with that owner before dispatch. |
| 4 | **Array generic-method over defined-accessor index** (`built-ins/Array/prototype/{map,filter,reduce,reduceRight,forEach,some,every}`) | ~204 (+43 `newArr.length`) | **SHARED-ROOT** | `Object.defineProperty(arr,"1",{get(){…}})` then iterate; getter never stored/consulted. **FOLDS INTO #3251** (array-descriptor overlay) — NOT a separate dispatch. |
| 5 | **for-of destructuring** (`language/statements/for-of/dstr`) | 139 | **SHARED-FEATURE, partial overlap** | binding / obj-rest / iterator-close (`nextCount`, `getOwnPropertyDescriptor(rest)`). Overlaps **#2602** (for-of/for-await assign-rest write). |
| 6 | **String.prototype this-value ToString** (`built-ins/String/prototype/{trim,trimEnd,trimStart,search,replace,match,replaceAll,split}`) | ~130 (trim family 76) | **SHARED-ROOT (trim family)** | trim/trimEnd/trimStart this-value-object-cannot-convert (RequireObjectCoercible + object-`this` ToString throws). search/replace/match are a DISTINCT Symbol.match/replace-protocol sub-root. |
| 7 | **Function.prototype bind/apply/call** (`built-ins/Function/prototype`) | ~110 | **likely 2 roots** | bind 42 (bound-fn length/name/this) + apply 34 / call 33 (array-like spread + this). Needs deeper sampling to split. |
| 8 | **Promise combinators GetIterator-reject** (`built-ins/Promise/{any,allSettled,all,race}`) | 34 | **SHARED-ROOT** | non-iterable arg → reject with a TypeError whose `[[Prototype]]` is `TypeError.prototype`. Gated on promise-carrier maturity in standalone. |

**Recommended wave order:** annexB-B.3.3 (96, clean single-root) → class/elements
decomposition (222) → String this-ToString trim family (76) → Promise
combinators (34). **Hold** Iterator (=#3249) and TypedArray-methods
(~500: slice 64/filter 59/map 57/subarray 47/copyWithin 38 — **must cold-verify
it's method-semantics, not the TA/AB brand-check owned by opus-tabrand**) pending
owner/cold checks. Array-204 folds into **#3251** (array-descriptor overlay epic).

## Non-tractable (excluded, for the record)
- `scope.x === #. Actual: NaN` (~30, `language/expressions/{compound-assignment,
  prefix-increment}`) — these use `with (scope)`; **`with` is deferred/wont-fix**
  (CLAUDE.md skip filters). Not a dispatch target.
- `throw new Test262Error()` opaque rows (scattered across every area) — the
  runner couldn't extract an assert; diffuse, low-signal, not a cluster.
