# Fable-window worklist — ready-to-execute queue (consolidated 2026-07-07)

**Purpose.** During the 2026-07 Opus session the seniors/devs root-caused a set
of conformance gaps that turned out to be substrate-deep or otherwise
**not cleanly landable on Opus** — each was documented and de-risked but left
unimplemented because the real fix needs the Fable budget window (hard /
architectural / `model: fable`). This file consolidates that scattered
de-risking into **one prioritized, root-caused queue** so the next Fable window
can execute without re-deriving.

For each item: **root cause** (one line) · **fix approach** · **exact issue
ref**. Verify each against current `main` before coding — several written
findings this session were stale (verify-first).

---

## Impact ranking — highest-ROI fix order (measured 2026-07-07)

Rank the Tier-0 substrate roots by the **conformance they unblock**, so the
next Fable window spends its budget on the biggest rocks first. Counts below are
**measured** this session (harvested from `.test262-cache/test262-current.jsonl`
+ spot-verified with `runTest262File` on current `main`), not estimated. The
headline: **one keystone bug gates the two largest clusters on the board.**

### #1 — KEYSTONE: `#2939` / `#2940` closure-dispatch across the externref boundary

**Root cause (one line):** a closure/callback held in an **`any`-typed
container** (array element, or an `any` param) is **not dispatched** when
invoked — `validators[i](value)` / `fn(...)` **no-ops** (or only fires when the
call's arity *and* arg type-kinds exactly match the callback's declared
params). The assertion/effect lives *inside* the callback, so a dropped
dispatch yields a **vacuous pass**, not a visible error.

**Why it's #1 — it gates the two largest clusters + a host-lane sibling:**

| cluster | files (measured) | how it maps to the keystone |
| --- | ---: | --- |
| TypedArray harness-wrapper vacuous (`testWith*Constructors(function(TA){…})`) | **~1487** | #2940 — the wrapper's `fn(ctor, …)` closure never dispatches ⇒ every assertion in the body is dead. |
| matchAll `compareIterator`/`matchValidator` ("assert is not defined") | **13** | #3083 — `validators[i](step.value)` on an `any[]` of closures no-ops (verified: a faithful shim flips 7/13 but a sabotaged-index negative control **still passed all 7** ⇒ dispatch dropped). |
| Array HOF-with-callback (reduce 128 · reduceRight 111 · filter 71 · map 64 · every 61 · some 55 · forEach 55) | **~545** | **DUAL-ROOT — partial** (see caveat). Some are dispatch; the sampled `map` case is #2773. |
| host-lane sibling: standalone destructuring throwing-accessor / user `@@iterator` | (dev-B) | #3076 — dev-B independently hit the *same* callback-across-boundary root from the host lane. |

**Rough total unblocked: ~1500 files verified same-root (#2940 + #3083), up to
~2000 counting the #2939 share of the HOF cluster.** By far the highest-ROI
item on the board.

**Fix approach:** arity/type-kind-tolerant dynamic dispatch of an `any`-typed
closure (the `#2939` blocker cited by `#2940`) — invoke the closure by its
`funcref`/wrapper regardless of arity/type-kind exactness, coercing args at the
call boundary. Landing it flips the ~1487 TypedArray files from vacuous→honest
and the 13 matchAll files pass→honest **with no per-test work**. (Same
closure-through-`externref` dispatch that Tier-1 **#3049** iterator-helpers and
**#3050**/#3076 need — landing the keystone also unblocks those.)

**UPDATE 2026-07-07 (dev-keystone, verify-first) — the keystone landed as
`#3074`, corrected root cause + value:** The bug was NOT a missing dispatch
shim. `#2939` already landed the nested-scope candidate registration but
**gated it on `ctx.standalone`**, so the gc/HOST (default) lane never registered
the harness callback → `fn(...)` dropped. The default lane is the broken one
(1,535 default > 448 standalone). Fix = **de-gate to both lanes** (one line;
`src/codegen/expressions/calls.ts` `ensureFuncValueWrappersRegistered`). Draft
PR **#2790** (held for the `#3086` honest baseline). **0 regressions** measured
(113 non-harness + 54 TypedArray real-corpus samples).

**Corrected value (was ~1800 pass — optimistic):** the de-gate is the dispatch
**ENABLER + honest-classifier**, not an immediate ~1800 pass jump. The un-masked
harness bodies EXECUTE but then **honest-fail on downstream gaps**, so the
immediate pass delta is modest; the durable wins are the general gc-lane
HOF-dispatch bug fix + ~1487 dishonest-vacuous scores becoming honest. The
vacuous→**pass** realization is gated on three filed follow-ups (keystone is a
prerequisite for all):

- **`#3087`** — dynamic `new TA(...)` on the gc/host lane ("No dependency
  provided for extern class TA"). **Dominant honest-fail after #3074 → highest-
  value next step.** (compiler; #1679/#812/#814 area)
- **`#3088`** — non-BigInt `testWithTypedArrayConstructors` runner shim passes
  1 arg vs the real harness's 2 → 2-param callbacks stay vacuous via the #1837
  over-arity-void skip (runner, bounded; sequence AFTER the honest baseline).
- **`#3089`** — BigInt-TA i64 `Binary emit error: offset out of bounds`
  (~22/30, pre-existing CE, unrelated to dispatch).

The `any[]`-element site (`validators[i](x)`, `#3083` matchAll ~13 files) is a
DISTINCT dispatch path (needs a runtime-`ref.test` fallback in the hot
element-access branch; a typed `CB[]` already dispatches) — deliberately not
bundled with the keystone; belongs to `#3083`. It is NOT #2773 substrate.

> **Caveat (measured — do not over-credit #2939):** the HOF-with-callback
> cluster is **dual-root**. I verified one `map` file
> (`15.4.4.19-8-c-ii-1.js`): the callback *did* dispatch but received **wrong
> args** — `obj[idx] !== val` over a heterogeneous `[0,1,true,null,{},"five"]`
> + sparse array — which is **#2773 any-element-rep**, not dispatch-drop. The
> generic `reduce.call(arraylike, cb)` variants add a **receiver-shape**
> component. So treat the ~545 as an **upper bound** on #2939's share; a
> per-file split is needed to attribute precisely. #2773 (below) closes the
> element-rep half.

### #2 — `#2773` any/dynamic value representation (Tier 0)

Closes the **other half** of the HOF cluster (heterogeneous/sparse array
elements + generic array-like receivers → correct callback args), plus most
any-receiver read gaps and the object-destructuring-param `NaN` residual. Pairs
with #2939 to fully close the Array HOF cluster.

### #3 — Resizable/growable ArrayBuffer + `transfer` (feature, not a single bug)

Not a substrate bug — a missing **ES2024 feature**. Measured: the
`CreateRabForTest` **compile-fail** cluster is **~150** files (`resizable-buffer`
tests across `Array/*` + `TypedArray/*`, all failing to compile the harness's
`new ArrayBuffer(n, {maxByteLength})` + `.resize()`); plus ArrayBuffer
`transfer` / `transferToImmutable` / `transferToFixedLength` / `.resize` =
**~38** ("X is not a function"). Needs resizable-AB storage + detach semantics
(#3054 area). Bounded to the feature, no substrate dependency — good standalone
Fable rock.

### #4 — `#2963` method/builtin first-class value identity (Tier 0)

~87 files (class-method-identity `c.m === C.prototype.m`); enables #3080. Lower
raw count than #1–#3 but unblocks a distinct semantic class.

Tier-0 **#3037** (object-identity canonicalisation) and the async roots
**#2865** / **#2895** remain as listed below — narrower conformance surface than
#1–#4, sequenced after.

> **Note:** #2939/#2940 is **not yet in the Tier-0 table below** (it was
> scattered across the #2940/#3083 issue files). It belongs at the **head of
> Tier 0** — this ranking is the authoritative statement until the table is
> folded in.

---

## Tier 0 — substrate roots (land these first; they unblock the Tier-1 gaps)

These are the deep enablers. Most Tier-1 gaps below are *instances* of one of
these, so landing the substrate closes clusters, not single tests.

| # | root cause (one line) | fix approach |
| --- | --- | --- |
| **#2773** | any/dynamic values have no uniform native representation → reconstructed dynamic reads return `NaN`/`null` when TS can't infer the concrete type. | `[EPIC][ARCH]` value-rep substrate: one native dispatch for reconstructed dynamic values. Closes the object-destructuring-param NaN residual (see Tier-1 #2774 note) and most any-receiver read gaps. |
| **#2963** | methods/builtins have no stable first-class value identity (dynamic `__get_builtin` shape re-materialises a wrapper per access). | Reify builtins/methods as first-class values with canonicalisation. Enables #3080 and the whole class-method-identity cluster (`c.m === C.prototype.m`, ~87 test262 files). |
| **#3037** | standalone dynamic reads don't canonicalise object identity → `ref.eq`/`===` between two reads of the same object is false. | Object-identity canonicalisation substrate for standalone dynamic reads. Co-enabler with #2963 for method/object identity. |
| **#2865** | standalone async generators / `for await` have no Wasm-native carrier — `asyncGen()` returns `null` / leaks `__…`. | Wasm-native async-generator + for-await carrier. Closes the async-generator `forbidden-ext` cluster (~46 files) and unblocks #2978. |
| **#2895** | a genuinely-pending `await` cannot suspend the current frame (only the single-tail-await fast path works). | True frame suspension (AG1 / PATH). Prerequisite for #2978 and real multi-await async. |

---

## Tier 1 — language/semantics gaps (Opus-documented, Fable to land)

Ordered by leverage. Each names the Tier-0 substrate it depends on (if any).

### #3049 — `Iterator.prototype` helpers (`map`/`filter`/`take`/`drop`/`flatMap`/…) → "X is not a function"
- **Root cause:** the 4th layer — the helper's internal iterator-record must
  **dispatch the user callback (mapper/predicate), a *compiled closure*, across
  the `externref` boundary**; that closure-through-externref dispatch is not
  wired, so the helper method resolves as not-a-function / traps.
- **Fix approach:** implement compiled-closure dispatch across `externref` in
  the iterator-helper lowering (materialise the callback as a callable the
  helper record can invoke; reuse the closure-struct call path).
- **Ref:** #3049 (`ready`, hard, `model: fable`).

### #3050 — `Generator.prototype.throw()` through `try/finally` / `try/catch` hits `unreachable`
- **Root cause:** the generator resume machine does **not model try-region
  state**, so a `.throw()` resumed into a `try/finally` cannot route the abrupt
  completion through the `finally` — it falls off into an `unreachable`.
- **Fix approach:** a **try-region state-machine** in the generator (and shared
  async) drive layer — track the active try/finally regions per suspension
  point so a resumed throw unwinds through the correct `finally`.
- **Ref:** #3050 (`ready`, hard, `model: fable`).

### #2978 — standalone `for await` over a sync iterator yielding a **rejected** promise
- **Root cause:** **no bounded synchronous fix exists** — the rejected promise
  must **suspend the async frame** and reject on resume; the current lane can't
  suspend there.
- **Fix approach:** depends on **#2895** (frame suspension) + the **`$Promise`
  widen** from **#2865**'s carrier. Do not attempt a sync shortcut (verified: no
  bounded sync fix).
- **Ref:** #2978 (`ready`, hard, `model: fable`) → blocked on #2895 / #2865.

### #3076 — standalone destructuring must invoke throwing accessor getters / user `@@iterator`
- **Root cause:** the standalone destructuring lowering does **not invoke**
  user-defined getters or a user `@@iterator` while binding a pattern (host mode
  does), so `var {p} = {get p(){throw}}` / `var [a] = throwingIterable` silently
  bind instead of throwing. Also **exposes standalone `assert.throws` leniency**
  (opaque WasmGC thrown values ⇒ any throw passes) → **vacuous** assertions.
- **Fix approach:** wire getter / `@@iterator` invocation into the standalone
  destructuring lane; and de-vacuify standalone `assert.throws` so a real
  Test262Error is distinguished (the vacuity-metric strand — see **#3056**).
- **Ref:** #3076 (`ready`, hard) — **blocks #3040**; vacuity strand **#3056**.

### #3080 — arrow-captured-`this` private-method value identity (`this.#m === (()=>this)().#m`)
- **Root cause:** accessing a private method **as a value** materialises a
  fresh, non-canonical function wrapper per access → two accesses of the same
  method on the same receiver are not `===` (fails for class **declarations**;
  the class-expression form passes since #3045's Bug-2 fix). Method **calls**
  through the arrow are fine — only the value identity fails.
- **Fix approach:** method-value reification/canonicalisation → **folds into
  #2963 / #3037**; not a bespoke wrapper-dedup.
- **Note (verify-first):** #3045's other residual — private-method `.name`
  (`this.#m.name === '#m'`) — is **already resolved on main** (basic / generator
  / static / via-local all pass). **Do not re-chase `.name`.**
- **Ref:** #3080 (filed this session; `ready`, hard, `model: fable`).

### #3084 — RegExp `@@match`/`@@replace`/`@@split` eager `lastIndex` coercion during a user-overridden `exec` fires `valueOf` when the spec does not
- **Root cause:** `src/runtime.ts` (`RegExp.lastIndex` `set`, ~L7838-7847)
  eagerly coerces a struct `lastIndex = {valueOf}` assigned during a protocol
  call (`_regexProtocolDepth > 0`) via `Number(_hostToPrimitive(...))`. Per
  §22.2.6.8 assignment stores verbatim; `ToLength(Get(rx,"lastIndex"))` runs
  **only in the empty-match branch**, so a non-empty match must not coerce.
- **Fix approach:** make the branch **deferred** (always `_makeLastIndexShim`)
  and have the native `@@match`/`@@replace`/`@@split` loops read the JS-visible
  `lastIndex` via `ToLength` in the empty-match branch (fires the shim exactly
  when the spec mandates). **Tension:** `tests/issue-2671-regexp.test.ts:108`
  depends on the eager firing for the `@@replace` **empty**-advance case (native
  loop reads its own internal lastIndex) — the deferred fix must preserve it.
- **Verified:** `g-match-no-coerce-lastindex.js` PASS on main `f426ef61`, FAIL
  on the #2777 branch (throwing `valueOf` invoked). Un-masked by #2777/#3051, not
  introduced by it.
- **Ref:** #3084 (filed this session; `ready`, hard, `model: fable`); **blocks
  #2777** (its sole "regression" is this bug's vacuity-unmask).

---

## Related context (not Fable-window, recorded to prevent re-chasing)

- **Destructuring-param-default cluster (47 files, `Cannot destructure null in
  __closure`).** Root cause = the closure free-variable scan skipped parameter
  defaults, so a var used only in a param default wasn't captured (`(x=o)=>x`
  returned `0`). **Fix is landing via PR #2774 (#3040, Fable)** —
  independently confirmed correct. **Residual after #2774:** object-destructuring
  params still return `NaN` when TS can't infer the field type (arrow-in-var /
  variable arg) — that residual is **#2773**, not #3040.
- **#3026 negative-test residual (6 real, deferred — NOT Fable-window):** eval ×2,
  module+top-level-await, `using`/ERM, strict-`PutValue` runtime, restricted-global
  runtime. Bounded early-error lane is done (#2779, merged). These belong to their
  feature epics, not this queue.
- **Stale-baseline caution:** the fetched `test262-current.jsonl` lagged `main`
  badly this session (e.g. 49/55 `negative_test_fail` entries were phantom).
  **Re-verify any cluster against `runTest262File` on current `main` before
  coding.**
