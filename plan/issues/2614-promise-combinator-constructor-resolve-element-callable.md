---
id: 2614
title: "Promise.{all,allSettled,any,race}: read constructor's own `resolve` + callable resolve/reject element functions (~45 fails)"
status: blocked
assignee: ttraenkler/senior-developer
created: 2026-06-22
updated: 2026-06-24
priority: medium
feasibility: medium
task_type: bug
area: async, codegen, promise
language_feature: promise
goal: async-model
sprint: Backlog
parent: 1042
related: [1528, 1368, 1116, 1694]
blocked_on: [2623]
note: "BLOCKED (2026-06-22, sd re-ground + impl attempt). The architect framing was wrong for current main: combinators delegate to native V8 (which already does Get(C,'resolve')). The real fix — route C to the user's realm Promise so a patched resolve is observed — is INSEPARABLE from the closure-as-dynamic-ctor capability bridge: the moment C is the realm Promise, NewPromiseCapability(C)→Construct(C, wasmExecutor) hits the same __fn_tramp_Constructor cross-realm illegal-cast as #2615/#1528a-residual (#1632b-2). Attempted observability fix proven net-NEGATIVE (regressed any/invoke-resolve pass→illegal-cast). Fold into / block behind the capability bridge; do NOT ship a standalone runtime.ts patch."
---
# #2614 — Promise combinators: invoke the constructor's own `resolve` + expose callable resolve/reject element functions

## Re-measured context (2026-06-22, ASYNC lane)

`test/built-ins/Promise/{all,allSettled,any,race}` has **125 fails** on
current main even though #1368, #1116, #1694 all landed. The breakdown:

| Sub-bucket | n | Owner |
|---|---|---|
| `promise_error: Promise resolve or reject function is not callable` | 45 | **this issue** |
| `illegal_cast in Constructor()/__fn_tramp_Constructor_*` (subclass/species capability) | ~19 | this issue (secondary) or follow-up |
| `[object Object] is not a constructor` (non-constructor TypeError) | ~8 | **#1528** (already ready, sprint 65) |
| `Function.prototype.bind called on non-callable` | ~5 | this issue (same element-fn root) |
| assorted `arguments.length` / `callCount` assertions | ~rest | downstream of the above |

This issue scopes the **45-fail `not callable` bucket + its `bind`/element-fn
siblings** — the largest combinator bucket not owned by #1528.

## Problem

Two related spec-conformance gaps in the combinator lowering:

1. **The combinator must read `resolve` off the constructor** (spec
   `PerformPromiseAll/Any/Race` step: `Let promiseResolve be ? Get(constructor,
   "resolve"); If IsCallable(promiseResolve) is false, throw TypeError`). Tests
   monkey-patch `Promise.resolve` and assert the combinator calls *that*
   function once per iterated value, with `this === Promise` and a single arg
   (`all/invoke-resolve.js`, `any/invoke-resolve-on-promises-*.js`,
   `race/invoke-resolve.js`). Our combinator path uses an internal resolve and
   never invokes the constructor's observable `resolve`, so the patched
   function's `callCount` stays 0 and the `not callable` guard or the
   assertion fails.

2. **The per-element resolve/reject functions must be real callable JS
   functions** (spec `CreateResolvingFunctions` / the all-resolve-element /
   allSettled-resolve-element / reject-element closures). Tests call
   `.bind`, read `.length`, and invoke these element functions directly
   (`allSettled/call-resolve-element.js`,
   `allSettled/reject-element-function-length.js`,
   `any/invoke-resolve-on-values-every-iteration-of-custom.js` →
   `Function.prototype.bind called on non-callable`). Our lowering produces a
   non-callable internal value for the element function.

## Failing test examples (re-measured)

- `test/built-ins/Promise/all/invoke-resolve.js`
- `test/built-ins/Promise/any/invoke-resolve-on-promises-every-iteration-of-promise.js`
- `test/built-ins/Promise/race/invoke-resolve.js`
- `test/built-ins/Promise/allSettled/call-resolve-element.js`
- `test/built-ins/Promise/any/invoke-resolve-on-values-every-iteration-of-custom.js`
- `test/built-ins/Promise/{all,allSettled,any}/species-get-error.js`

## Implementation Plan

### Root cause
The combinator codegen/runtime path short-circuits the spec's observable
operations: it does not `Get(constructor, "resolve")` and invoke it per
element, and the resolve/reject element functions it creates are not
first-class callable functions (no `__make_callback`-style host wrapper /
no `.length`/`.bind`-able shape).

### Where the combinators live
- `grep` for the combinator dispatch: `Promise.all` / `Promise.allSettled` /
  `Promise.any` / `Promise.race` handling in `src/codegen/expressions/calls.ts`
  (the `.then`/Promise static-method dispatch region near the
  `calls.ts:3807` instance-method block) and the host runtime
  implementations in `src/runtime.ts` (search `Promise_all`,
  `Promise_allSettled`, `Promise_any`, `Promise_race`).
- Determine whether each combinator is (a) lowered to a host import call, or
  (b) compiled-away. The `not callable` host string suggests the **host
  runtime** implementations of these combinators are the locus.

### Changes (JS-host first; standalone deferred)

**File: `src/runtime.ts`** (the combinator implementations)
- Rewrite each combinator to follow the spec algorithm using the **passed-in
  constructor** `C` (the `this` of `Promise.all` etc.):
  1. `let promiseResolve = C.resolve` (a property GET, so a monkey-patched
     `Promise.resolve` is observed). `if (typeof promiseResolve !== "function")
     throw TypeError("Promise resolve or reject function is not callable")`.
  2. For each iterated value: `nextPromise = promiseResolve.call(C, nextValue)`
     — invoked with `this === C` and exactly one argument (satisfies the
     `invoke-resolve` assertions).
  3. Build the per-element resolve function as a **real closure** (a JS
     function with the spec `length` of 1 and `.bind`-able) — not an internal
     marker. For `all`/`allSettled`/`any` the element functions carry the
     `[[AlreadyCalled]]` / index / values / capability slots.
  4. Settle the combined capability via the same resolving functions the
     executor would use.
- Keep the host implementations behind the existing JS-host gate; standalone
  combinator conformance to this depth stays deferred (the standalone
  `$Promise` combinator path is a separate, larger effort — file forward).

**File: `src/codegen/expressions/calls.ts`** (only if the combinator is
compiled-away rather than host-imported)
- If the combinator is currently lowered inline, ensure it threads the actual
  constructor receiver (`Promise` or a subclass) into the runtime call so
  `C.resolve` is read from the right object. Reuse the species/`this`-capability
  plumbing landed by #1694.

### Edge cases
- `Promise.resolve` deleted / non-callable → `TypeError` with the exact spec
  wording the tests assert.
- Subclass receiver (`class P2 extends Promise {}`; `P2.all([...])`) — read
  `resolve` off `P2`. (The `illegal_cast in Constructor()` sub-bucket is the
  subclass-capability path; if it does not fall out of the same rewrite, file
  it forward as a follow-up rather than expanding this slice.)
- `species-get-error.js` — a throwing `Symbol.species`/`resolve` getter must
  propagate; do not swallow.

### Test files to verify (must flip pass)
- `test/built-ins/Promise/all/invoke-resolve.js`
- `test/built-ins/Promise/race/invoke-resolve.js`
- `test/built-ins/Promise/allSettled/call-resolve-element.js`
- `test/built-ins/Promise/any/invoke-resolve-on-promises-every-iteration-of-promise.js`

### Regression watch
- The 487 Promise tests that currently pass must stay green — the rewrite
  must preserve the happy-path resolution order.
- Coordinate with **#1528** (non-constructor TypeError sub-bucket): both touch
  the combinator path. Land order: whichever lands first, the second rebases;
  create a `[CONFLICT]` TaskList item if both edit the same `runtime.ts`
  combinator block.

### Estimate / honesty
This is the **most involved of the three ASYNC-lane slices** — it is
combinator-internals work, not a one-line detector fix. Scope to the
`not callable` + `bind`/element-fn bucket (~45 + ~5). The
`illegal_cast`/subclass-capability sub-bucket (~19) may or may not fall out;
if not, file forward. Estimate ~120 LoC `runtime.ts` + ~30 LoC codegen +
~60 LoC tests. **~45-50 test262 pass** if the subclass path comes along, ~45
otherwise. Suitable for a **senior-dev**.

## Re-grounding against current main (2026-06-22, senior-dev)

**The architect's root-cause framing does NOT hold on current main.** The
combinators are NOT compiled-away with an internal resolve — `src/runtime.ts`
(`Promise_all`/`_race`/`_allSettled`/`_any`, ~L10063-10082) **delegate to native
V8** `Promise.all.call(C, _toIterable(arr))`. V8 itself performs
`Get(C, "resolve")`, creates real callable resolve/reject element functions, and
runs the full spec algorithm — so "rewrite the combinators to read C.resolve" is
the wrong fix; that observable already works. Verified: `any/invoke-resolve-on-
promises-every-iteration-of-promise.js` and `all/invoke-resolve-get-error.js`
PASS today.

**Faithful `runTest262File` re-measure of the actual residual buckets:**

| Test | status | true signature |
|---|---|---|
| `all/invoke-resolve.js` | fail | `returned 2 \| assert #1 at L31` — patched `Promise.resolve` IS invoked, but `nextValue !== current` → **element-identity break** through the array round-trip, NOT a "not callable" guard |
| `race/invoke-resolve.js` | fail | same `assert #1` identity break |
| `allSettled/call-resolve-element.js` | fail | `illegal cast in Constructor() … __fn_tramp_Constructor_*` — subclass/capability path |
| `race/resolve-from-same-thenable.js` | fail | same `illegal cast in Constructor()` |
| `all/resolve-element-function-name.js` | fail | `Promise resolve or reject function is not callable` (reads `.name` off element fn) |
| `all/invoke-resolve-error-close.js` | fail | `Cannot set property resolve of #<Object> which has only a getter` — host `Promise` exposes `resolve` getter-only, so `Promise.resolve =` throws |
| `all/ctx-ctor.js` | fail | `instance.constructor !== SubPromise` — subclass species |

**Revised bucket map (different from the spec's):**
1. **Element-identity break** (`invoke-resolve` all/race) — the `[p1,p2,p3]`
   array literal / `_toIterable` round-trip does not preserve the *same*
   externref the user holds, so V8's per-element `resolve(nextValue)` sees a
   different object than `current`. `__vec_get` uses `extern.convert_any` (slot
   identity preserved), so the re-wrap is upstream — likely the array-literal
   element store or the host-boundary box. **Needs pinning.**
2. **`__fn_tramp_Constructor` illegal cast** (allSettled/race/ctx-ctor) — the
   subclass/capability construct path; this is the `~19 illegal_cast` sub-bucket
   the spec said "may not fall out" — and it's the SAME root as #1528 and the
   #2615-class `__fn_tramp_Constructor` work.
3. **`Promise.resolve` getter-only writability** — the host `Promise` mirror
   exposes `resolve` as a non-writable getter, so a test's `Promise.resolve =`
   throws. Narrow host-glue fix.
4. **Element-fn `.name`/callable shape** (`resolve-element-function-name`) — the
   spec's named ~45 bucket; needs the V8 element fns to surface to compiled
   code as callable-with-`.name`. Since we delegate to V8 the element fns ARE
   real — the gap is how a *compiled* callback reads `.name`/`.length` off them.

**Recommendation:** this is NOT a single ~120-LoC runtime rewrite. It is 3-4
distinct narrow root causes, two of which (#2, and arguably #4) overlap the
`__fn_tramp_Constructor` capability work already in flight (#2615 / #1528).
Re-scoping with the tech lead before implementing — the highest-ROI standalone
slice here is the element-identity break (#1) + the getter-only writability (#3),
which together are small and don't touch the contested capability path.

### Bucket 1 (element-identity) — exact location pinpointed

`emitIterableArg` (`src/codegen/expressions/calls.ts:1163`) materializes an
array-literal iterable `[p1,p2,p3]` into a real JS array (`__js_array_new` +
`__js_array_push` per element) so native V8 can `GetIterator` it. Each element
is pushed via `compileExpression(ctx, fctx, el, { kind: "externref" })` with a
belt-and-braces `extern.convert_any`. The candidate identity break is here OR in
`_toIterable`'s `__vec_get` materialization (`src/runtime.ts` ~L9960) for the
non-array-literal path. `__vec_get` for externref elements uses
`extern.convert_any` (slot identity preserved), so the array-literal push path is
the more likely culprit: if a `Promise` element is held as a wasm struct ref and
`extern.convert_any`-wrapped at push time, V8 sees a wrapper distinct from the
test's `var p1` (which holds the raw host Promise externref from
`__new_Promise`). Next implementer: trace whether `p1` (a `new Promise(...)`
binding) is stored as a raw externref or a struct ref at the push site, and
ensure the push forwards the identical externref V8 will compare against.

## Implementation attempt + definitive coupling finding (2026-06-22, senior-dev)

**Attempted the bucket-1 "observable resolve" fix** in `src/runtime.ts`: the
combinator/`Promise.resolve` host imports closed over the module-level intrinsic
`Promise`, so a test that monkey-patches its realm's `globalSandbox.Promise.resolve`
was never observed (`Get(C,"resolve")` read the unpatched intrinsic). Routing `C`
(via `_resolveCtor` directCall) and `Promise.resolve`/`reject` through
`globalSandbox.Promise ?? Promise` **fixed the observability/identity break** —
the three identity probes pass and `all/race invoke-resolve` advanced past
assert #1 (`nextValue === current` now holds).

**But it is net-NEGATIVE and cannot ship as an independent slice:**
- `all/invoke-resolve` / `race/invoke-resolve` still fail at **assert #2**
  (`arguments.length === 1`): V8's native combinator calls the test's *compiled*
  `Promise.resolve` closure through `wasmClosureDynamicBridge`
  (`runtime.ts:1854`), and `arguments.length` inside a host→wasm-bridged closure
  does not reflect the JS call's arg count. That is the mapped-`arguments`/bridge
  machinery, not combinator code.
- **REGRESSION**: `any/invoke-resolve-on-promises-every-iteration-of-promise.js`
  flips **pass → `illegal cast in __call_fn_method_1`**. Routing `C` to the
  sandbox-realm Promise makes `Promise.any.call(sandboxC, …)` do
  `NewPromiseCapability(sandboxC)` → `Construct(sandboxC, executor)` where the
  executor is a compiled wasm closure — the cross-realm construct hits the SAME
  `__fn_tramp_Constructor` capability-bridge `illegal cast` as #2615/#1528.

**Conclusion (validates the re-grounding):** the observable-resolve fix is
**inseparable** from the closure-as-dynamic-constructor capability bridge owned
by #2615 / #1528a-residual (#1632b-2, task #56). `Get(C,"resolve")` observability
requires `C` to be the user's realm Promise, but the moment `C` is that realm's
Promise, the combinator's `NewPromiseCapability(C)` construct routes a compiled
executor through the cross-realm bridge that currently `illegal cast`s. #2614
should be **blocked on / folded into the capability-bridge work**, not shipped as
a standalone runtime.ts patch. The attempted diff is preserved out-of-tree
(not committed — net-negative). Recommend: re-route #2614 behind #1632b-2 /
#2615, or hand the combined combinator+capability slice to whoever owns that
bridge.

## Status update (2026-06-22, post #56+#86 merge)

#56/#1940 (closure-construct bridge) and #86/#1945 (capability-ctor executor-call
host-routing) BOTH MERGED. #86 banked **+2 rows** for this cluster
(`capability-executor-called-twice`, `species-get-error`) — the executor-call
surface is now on main.

The DOMINANT rows remain blocked, re-pointed to the new follow-up **#2623**
(Promise capability-cluster — multi-hop host→wasm callback cast + species/proto
identity):
- `invoke-resolve` (all/race) — observable-resolve identity, coupled to the
  inbound-callback substrate (proven net-negative alone pre-#1940).
- `call-resolve-element` / `resolve-from-same-thenable` — the inner CAPTURING
  `resolve` closure passed to the host executor null-derefs/casts on the inbound
  callback (the #86 capturing-residual; same root as the await-thenable bucket).
- `ctx-ctor` (all/allSettled/race/any) — `instance.constructor === SubPromise`
  species/prototype identity through the bridge.

`blocked_on` updated to `[2623]`. This issue stays `blocked` until #2623 lands
the inbound-callback substrate.

## Reground re-probe (2026-06-25, sdev-async-sm — post #2637/#2615/#1528)

Re-probed the 9 representative tests against current `origin/main` (HEAD
`d28fdb2c5`, after #2637 B1+B2 / #2615 / #1528 all landed) via
`runTest262File`. **Verdict: STILL BLOCKED on #2623; NOT unblocked by the
capability-ctor work. Did not claim.**

| Test | 2026-06-22 | now | Δ |
|---|---|---|---|
| `all/invoke-resolve` | fail (assert#1 identity) | fail (assert#1 identity) | — |
| `race/invoke-resolve` | fail (assert#1 identity) | fail (assert#1 identity) | — |
| `any/invoke-resolve-…promise` | pass | pass | — |
| `allSettled/call-resolve-element` | fail (illegal_cast) | fail (**"not callable"**) | shifted, still fail |
| `race/resolve-from-same-thenable` | fail (illegal_cast) | fail (**"not callable"**) | shifted, still fail |
| `all/resolve-element-function-name` | fail (not callable) | fail (assert#1) | shifted, still fail |
| `all/invoke-resolve-error-close` | fail (getter-only) | fail (callCount=1) | shifted, still fail |
| `all/ctx-ctor` | fail (subclass species) | **PASS** | **FLIPPED ✓** |
| `all/species-get-error` | — | pass | — |

**What #2637/#2615/#1528 banked:** the `__fn_tramp_Constructor illegal_cast`
signature is GONE — the *outbound* subclass/capability construct path now
works (`ctx-ctor` flipped pass). This is real progress and validates the
coordinator's premise that the capability ctor landed.

**Why #2614 is still blocked:** the dominant buckets are unmoved. The two
`illegal_cast` rows shifted to **"Promise resolve or reject function is not
callable"** — i.e. the construct succeeds but the **inbound host→wasm
resolve-element callback** is still not a callable wasm value. That inbound
multi-hop callback substrate is **exactly #2623's scope** (`status:
in-progress`, assigned `ttraenkler/sendev-promise-subclass` — a LIVE
senior-dev). The `invoke-resolve` assert#1 identity break is the same
observable-resolve coupling the 2026-06-22 pass *proved net-negative* to fix
alone. An independent #2614 runtime.ts patch would (a) re-attempt a proven
net-negative fix and (b) collide with the live #2623 owner.

`blocked_on: [2623]` stands. The remaining #2614 buckets fall out of #2623,
not the capability ctor. Re-evaluate #2614 when #2623 lands.

**Sibling consumers (2026-06-23, #1528 probe):** the same arms-B/D substrate also
gates `.finally` (7 fails) and `Promise.try` (3 fails) — see the
"Downstream consumers (observed gaps)" section in
`plan/issues/2623-promise-capability-cluster-multihop-callback-cast.md` for the
exact test paths to fold into the #42 re-spec acceptance set.

## Unified-spec routing (architect, 2026-07-04)

The residual buckets here are now specced as concrete slices of the
**unified Promise semantics spec in #2623**:

- `invoke-resolve` assert-#1 element-identity (all/race) → **#2623 §P4 B-4 /
  §P7 slice P-7 (Fable)** — the observable-resolve fix re-tested COMPOSED on
  the now-landed B-1..B-3 substrate (its pre-#1940 net-negative regression
  path is legal now).
- `.finally` (7 rows) + `Promise.try` (3 rows) + `arguments.length`-through-
  the-bridge reflection → also **P-7** (§P4 B-5: spec-algorithm
  `Promise_finally` shim instead of delegating to native `.finally`).
- `call-resolve-element` / `resolve-from-same-thenable` ("not callable"
  residual) → **#2623 §P7 slice P-8** (`Test262Error.thrower` +
  `promiseHelper.js` runner shims + drain contract) — the substrate half
  landed with #1981; what remains on these two rows is harness, not codegen.
- Element-function `.name`/`.length` shapes → re-measure after P-7/P-8;
  file forward only if still red.

`blocked_on: [2623]` stands, now with slice-level targets (P-7, P-8)
instead of a monolithic dependency.
