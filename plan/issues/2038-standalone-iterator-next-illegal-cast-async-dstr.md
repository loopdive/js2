---
id: 2038
title: "standalone: `illegal cast` in __iterator_next / async destructuring & yield* paths (~470 tests)"
status: done
sprint: 62
created: 2026-06-10
updated: 2026-06-14
completed: 2026-06-14
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: iterators, for-await-of, async-generators, destructuring
goal: standalone-mode
related: [1665, 1664, 681, 1323, 1048]
test262_bucket: standalone-iterator-illegal-cast
test262_count: 470
es_edition: es2018
origin: "2026-06-10 standalone-vs-host baseline diff: 473 non-Temporal gap rows fail with `illegal cast`, 213 of them inside __iterator_next, concentrated in for-await-of and async-generator destructuring."
---

# #2038 — standalone: iterator-protocol `illegal cast` bucket

## Problem

~470 gap tests (host-pass) trap at runtime with `illegal cast`
(`ref.cast` failure) in standalone mode. Sub-buckets by trap site:

| Count | Trap site | Example |
| ---: | --- | --- |
| 210 | `__iterator_next() ← fn ← test` | `language/statements/for-await-of/async-func-dstr-var-async-obj-ptrn-empty.js` |
| 115 | `[in test()]` directly, async-generator `yield*` | `language/expressions/async-generator/named-yield-star-getiter-async-returns-number-throw.js` |
| ~145 | misc: `__obj_find ← __extern_get ← __closure_*`, compound-assignment closures, `__obj_insert ← __defineProperty_value` (the last belongs to #2042) | |

Confirmed on main @ 936d1ac51:
`for-await-of/async-func-dstr-var-async-obj-ptrn-empty.js` compiled standalone
traps `illegal cast` at runtime (host: pass).

The dominant shape is **async** iteration consuming the pure-Wasm iterator
protocol: `for await (var {} of [asyncIter])`, async-generator method
destructuring (`async-func-dstr-*`, `async-gen-*`), and `yield*` delegating to
an async iterator whose `next()` resolves to a non-object/number
([§27.6.3.8 AsyncGeneratorYield / §7.4.3 IteratorNext](https://tc39.es/ecma262/#sec-iteratornext)).

## Root cause in compiler (to confirm)

The standalone iterator runtime (`$IteratorResult` struct path from #1323 /
native generators from #1665) and the **async** wrapper path disagree about
the carrier type: `__iterator_next` `ref.cast`s the iterator/result to the
sync `$IteratorResult`/`$Object` layout, but async paths hand it a different
representation (boxed promise resolution value, externref, or the async
generator's own state struct). Sync `for-of` over the same patterns largely
passes, so the cast mismatch is specific to the async bridging added around
the microtask/CPS scheduler (#1326/#1326c).

## Suggested fix

1. Trace one repro: dump WAT for the minimal failing form, find which
   `ref.cast` traps and what the actual operand type is.
2. Unify the async-iterator-result carrier with the sync `$IteratorResult`
   struct (or brand-switch before casting), including the
   `yield*`-rejects-non-object path which must throw TypeError, not trap.
3. Keep the #1888 invariant: unknown carrier ⇒ JS `TypeError` via the
   standalone throw helper, never a Wasm trap (`illegal cast` reads as a
   compiler bug, and aborts the whole test instead of being catchable).

## Acceptance criteria

- `async-func-dstr-var-async-obj-ptrn-empty.js` and the
  `named-yield-star-getiter-async-returns-number-throw.js` family pass
  standalone.
- `illegal cast` rows inside `__iterator_next` drop to 0 in the standalone
  baseline; overall bucket ≤ 50 (remaining rows reassigned to owners).
- Wasm traps are not used for spec-reachable error paths in the iterator
  protocol (TypeError surfaces as catchable JS error).

## Investigation (2026-06-14, sdev) — PR-A as scoped is ALREADY satisfied; the
## remaining bucket needs the DEFERRED sub-bucket B + PR-C, not PR-A

Re-traced on current main (d1aba0601 — 76+ commits past the architect spec's
936d1ac51 base). The spec's "## Implementation Plan" is on a not-yet-merged
branch; I read it from the /workspace copy. Findings against live HEAD:

1. **Array-literal-backed for-await already works standalone** — the loop is
   inlined/unrolled over the literal, bypassing the iterator protocol. All
   compile valid, leak ZERO env imports, run correctly:
   `for await (const x of [1,2,3])` → 6; `for await (var {} of [{a:1}])` (the
   spec's "simplest passing case") → ok; `for await (const {a} of [{a:1},{a:2}])`
   → 3; `for await (const [x,y] of [[1,2],[3,4]])` → 10. So PR-A's sync-backed
   array acceptance shapes **pass on current main with no change.**

2. **The spec's premise "sync is healthy" is INACCURATE for custom iterables.**
   BOTH sync `for-of` AND async `for await` over a user
   `{ [Symbol.iterator](){ return {next(){…}} } }` trap `illegal cast` in
   standalone — the native iterator runtime (`iterator-native.ts`
   `__iterator`/`__iterator_next`) only supports the canonical externref **vec**
   carrier (`ref.cast $vecExtern`), NOT the general user `{next()}` protocol.
   This is a broad native-iterator gap, not an async-only carrier mismatch.

3. **The named PR-A smoke file is actually a sub-bucket-B case.**
   `async-func-dstr-var-async-obj-ptrn-empty.js` =
   `var asyncIter = (async function*(){ yield* [obj]; })(); for await (var {} of asyncIter)`
   — an **async generator** with **`yield*`**. It compiles standalone to an
   INVALID module leaking 7 host imports (`__create_async_generator`,
   `__gen_yield_star`, `__async_iterator`, `__make_getter_callback`,
   `__gen_create_buffer`, `__get_caught_exception`, `__extern_is_undefined`).
   Native-async-generators + standalone-Promise territory — the spec's own
   **deferred** sub-bucket B / PR-C.

### Conclusion / recommendation
No clean in-scope PR-A change remains: the sync-backed array for-await shapes PR-A
targets already pass; every remaining 470-bucket row needs either (a) extending
the native iterator runtime to the general `{next()}` protocol (affects sync
for-of too — a separate broad effort) or (b) native async generators + standalone
Promise/Await (deferred sub-bucket B / PR-C). Recommend re-scoping #2038 around a
**native `{next()}`-protocol iterator runtime** (the real shared root cause for
sync+async custom iterables) and keeping async-generator/Promise as the
explicitly-deferred follow-ups. Surfaced to tech lead for a scope decision rather
than shipping a no-op PR-A or silently expanding into the deferred work.

## Re-scope APPROVED (tech-lead, 2026-06-14) + implementation design (sdev)

Scope: add a **USER_ITER carrier** to `src/codegen/iterator-native.ts` so the
standalone native iterator runtime drives the general `{next()}` protocol, not
just the canonical externref vec. Fixes BOTH sync `for-of` and (sync-backed)
async `for await` over a user
`{ [Symbol.iterator]() { return { next(){…} } } }`. DEFERRED (separate
follow-ups): native async generators + `yield*` (sub-bucket B), standalone
Promise runtime (PR-C).

### Precise trap (confirmed via WAT)
For-of consumer emits `call $__iterator(subject)` → `$IterRec` → loop
`call $__iterator_next(iter)`. Native `__iterator` (iterator-native.ts:106)
unconditionally `ref.cast`s `subject` to `$vecExtern`; a custom-iterable object
struct is not a vec ⇒ `illegal cast`. (For arrays the loop is inlined upstream,
so only custom iterables reach here.)

### Design — USER_ITER carrier (kind=1)
Extend `$IterRec` to carry a user iterator object as an externref alongside the
vec. Two new fields (keep vec path byte-identical):
`(struct $__IterRec (field kind i32) (field vec (ref null $vecExtern))
  (field idx (mut i32)) (field userIter (mut externref)))`.

- **`__iterator(subject)`**: `ref.test (ref $vecExtern)` on
  `any.convert_extern(subject)`.
  - vec ⇒ existing kind=VEC path (unchanged).
  - else ⇒ obtain the user iterator: call `subject[@@iterator]()` and store the
    result in `userIter`, build `$IterRec{kind:USER, vec:null, idx:0, userIter}`.
    Resolving `@@iterator` on an arbitrary externref needs the standalone
    method-by-name dispatch — reuse the same mechanism `compileForOfDirectIterator`
    uses for typed structs, lifted to a name-keyed call (`@@iterator` field +
    `__call_fn_method_*`). If `subject` is ALREADY an iterator (has `next` but no
    `@@iterator` — the result of a manual `obj[Symbol.iterator]()`), pass through.
- **`__iterator_next(rec)`**: branch on `rec.kind`.
  - VEC ⇒ existing path.
  - USER ⇒ call `userIter.next()` via the closure dispatcher → result externref
    → `done = truthy(__sget_done(result))`, `value = __sget_value(result)`.
    Return `(done, value)` in ABI order. A non-object `next()` result ⇒ TypeError
    via the standalone throw helper (#1888 invariant), never a trap.
- **`__iterator_return(rec)`**: USER ⇒ if `userIter.return` exists, call it; else
  no-op (sync-backed close is a no-op for the common shape).

### Building blocks (already present)
- `__sget_value` / `__sget_done` per-field getters (index.ts:1856) — emitted when
  `.value`/`.done` are accessed; ensure they exist (force-register for USER path).
- closure dispatch `__call_fn_method_*` for calling `next`/`@@iterator` closures.
- `@@iterator` reserved field name (literals.ts:1162/1246).
- truthiness helper for `done` (boxed-bool / number) — reuse buildTruthyCheck.

### Async (for-await) reuse
`ensureAsyncIterator` (destructuring.ts:377) in standalone should NOT add the
host import; instead return the native `__iterator` (CreateAsyncFromSyncIterator
= identity carrier for sync-backed), so the async consumer drives the SAME
USER_ITER carrier. Per-element Await reduces to identity for already-settled
(sync-backed) values — no `Promise_resolve` leak. Genuinely-pending Promises
remain deferred to PR-C (refuse-loud, no host leak).

### Smoke tests
- sync: `for (const x of {[Symbol.iterator](){let i=0;return{next(){return i<3?{value:i++,done:false}:{value:undefined,done:true}}}}}) …` → 0+1+2
- async sync-backed: same subject under `for await` → identical.
- both standalone (`--target wasi`): valid module, ZERO env imports, correct sum.
- regression: array for-of/for-await (inlined) + typed-struct @@iterator
  (compileForOfDirectIterator) byte-identical.

### Status
status stays `ready`/in-progress; implementation in worktree
`/workspace/.claude/worktrees/issue-2038-async-iter-carrier`
(branch `issue-2038-async-iter-carrier`).

### Confirmed building blocks (all already in standalone)
- **`__extern_method_call(recv, name, args)`** — native, `object-runtime.ts:4141`
  (filled at finalize via `fillApplyClosure` → `__call_fn_method_0..4`). Use it
  to call `subject["@@iterator"]()` and `userIter["next"]()` from the
  fctx-less native iterator bodies. Pass an empty args vec.
- **`__obj_find(obj, key)`** / `__sget_value` / `__sget_done` — native property
  read on the `{value,done}` result. `__sget_*` getters are emitted only when
  the field name is referenced; FORCE-register `__sget_value`/`__sget_done` (and
  the `@@iterator`/`next`/`done`/`value` string constants) when the USER_ITER
  path is enabled so they exist at runtime.
- **truthiness** for `done` — reuse `buildTruthyCheck` (boxed-bool / number).
- **`@@iterator`** reserved field name — `literals.ts:1162/1246`.

## Suspended Work (2026-06-14, sdev) — full blueprint ready, NOT yet coded

- **Worktree**: `/workspace/.claude/worktrees/issue-2038-async-iter-carrier`
  (branch `issue-2038-async-iter-carrier`). Only this issue doc is modified;
  NO source changed yet (analysis + design only).
- **Why suspended**: re-scope approved late in a long session; the USER_ITER
  carrier is a sizable, careful `iterator-native.ts` runtime change (extend
  `$IterRec`, branch `__iterator`/`__iterator_next` on kind, wire
  `__extern_method_call` + `__sget_value`/`__sget_done` + truthiness + TypeError
  on non-object next-result + late-import/funcIdx ordering). Best done as a
  focused pass on the freshest main (after PRs #1450/#1452 land), not rushed at
  session tail.
- **Resume steps**:
  1. Extend `getOrRegisterIterRecType` (iterator-native.ts:43) with a mutable
     `userIter` externref field (4th field). Keep field order so existing
     `fieldIdx` refs (kind=0, vec=1, idx=2) are unchanged; userIter=3.
  2. Add `ITER_KIND_USER = 1`. In `__iterator` (`:106`): `ref.test (ref
     $vecExtern)` on `any.convert_extern(subject)` — vec ⇒ existing path; else ⇒
     `__extern_method_call(subject, "@@iterator", emptyVec)` (if it returns
     non-null use it as userIter; if subject already has `next` and no
     `@@iterator`, treat subject itself as userIter), build
     `$IterRec{kind:USER, vec:null, idx:0, userIter}`.
  3. In `__iterator_next` (`buildIteratorNextBody`, `:183`): branch on
     `struct.get kind`. USER ⇒ `r = __extern_method_call(userIter, "next",
     emptyVec)`; non-object `r` ⇒ TypeError via `__new_TypeError`+exn tag (#1888);
     `done = truthy(__sget_done(r))`, `value = __sget_value(r)`; return (done,value).
  4. `__iterator_return` USER ⇒ call `userIter["return"]()` if present, else no-op.
  5. Async reuse: in `ensureAsyncIterator` (destructuring.ts:377), when
     `ctx.standalone || ctx.wasi` do NOT addImport — return native `__iterator`
     (identity CreateAsyncFromSyncIterator for sync-backed); mirror its
     `shiftLateImportIndices`. Per-element Await = identity for already-settled.
  6. Force-register `__sget_value`/`__sget_done` + string constants
     `@@iterator`/`next`/`return`/`value`/`done` when the USER path is enabled.
  7. Validate (`.tmp` probes already written): sync `for (const x of
     {[Symbol.iterator](){…}})` → 0+1+2; async `for await` same → identical;
     both `--target wasi` valid + ZERO env imports; arrays + typed-struct
     `@@iterator` (compileForOfDirectIterator) byte-identical; full equivalence
     suite identical failing-set vs origin/main.
  8. New `tests/issue-2038.test.ts` per the smoke list above. PR + self-merge.
- **Pitfalls**: `__extern_method_call`/`__call_fn_method_*` are filled at
  FINALIZE — ensure the native iterator bodies reference them by funcMap name
  (resolved at finalize), not by eager funcIdx. Watch late-import index shifting
  when registering the new string constants / forcing `__sget_*`.

### Implementation-start learnings (2026-06-14, sdev — partial attempt, reverted)
Started the carrier on freshest main (branch is merged-current with main), then
reverted to keep the branch clean (blueprint-only) because the full USER carrier
is a sizable, finalize-ordering-sensitive runtime change that warrants a
fresh-context focused pass rather than a rushed one at deep context. Concrete
gotchas confirmed while starting:
1. **Struct arity is load-bearing.** Adding `userIter` as `$__IterRec` field 3
   means the EXISTING vec-path `__iterator` body (`struct.new $__IterRec` with
   3 operands: kind, vec, idx) becomes INVALID — it must push a 4th operand
   (`ref.null.extern` for userIter). Update BOTH the `__iterator` vec arm AND
   any other `struct.new $__IterRec` site in lockstep with the field add, or the
   module fails validation. (I extracted the body into a `buildIteratorBody`
   helper to branch vec-vs-user; do the same and keep the vec arm's 4-field
   struct.new.)
2. **Dependency setup order in `ensureNativeIteratorRuntime`:** call
   `ensureObjectRuntime(ctx)` (registers/reserves `__extern_method_call`,
   `__extern_get`, `__obj_find`) and force-register `__sget_value`/`__sget_done`
   + the `@@iterator`/`next`/`value`/`done` string constants
   (`addStringConstantGlobal` then `stringConstantExternrefInstrs(ctx, …)`)
   BEFORE building the `__iterator`/`__iterator_next` bodies, so their funcIdx /
   string-global refs are stable. The native bodies are passed EAGERLY to
   `registerNative`, so capture `ctx.funcMap.get("__extern_method_call")` etc.
   after `ensureObjectRuntime` — referencing the reserved index is fine
   (finalize fills the body, not the index).
3. **`stringConstantExternrefInstrs(ctx, value)`** (native-strings.ts:169) is the
   right way to push a string-const externref from the fctx-less native body
   (call `addStringConstantGlobal(ctx, value)` first). Use it for the
   `@@iterator` / `next` name args to `__extern_method_call`.
4. **USER `__iterator_next`:** `r = __extern_method_call(userIter, "next", emptyVec)`;
   `done = truthy(__sget_done(r))` (reuse buildTruthyCheck), `value = __sget_value(r)`;
   non-object `r` ⇒ TypeError via the standalone throw helper (#1888), never a
   trap. Build the empty-args vec the same way the for-of consumer builds arg
   vecs (or pass a null/empty externref the host bridge tolerates).
5. **Validate incrementally:** after the struct+vec-arm change alone, the array
   for-of/typed-struct paths must stay byte-identical (run the generator/for-of
   suites) BEFORE adding the USER arm — that isolates a struct-arity regression
   from a USER-arm bug.

## Implementation attempt (2026-06-14, sdev) — USER carrier WIP + PREREQUISITE BLOCKER

Implemented the USER_ITER carrier on this branch (committed WIP):
- `$IterRec` extended with `userIter` (field 3, externref); the vec-path
  `__iterator` `struct.new` updated to push the 4th operand. **Vec/array path is
  byte-identical and fully intact** (array for-of host+wasi → 6; `issue-1320-
  standalone-iter` 5/5; closure tests green — zero regression).
- `__iterator` now branches `ref.test $vecExtern`: vec → VEC carrier; else →
  USER carrier: `userIter = __extern_method_call(obj, "@@iterator", emptyVec)`
  (falls back to `obj` itself if no `@@iterator`), builds `$IterRec{USER, null,
  0, userIter}`. The module compiles VALID with ZERO leaked env imports.
- `__iterator_next` branches on `rec.kind`: USER →
  `res = __extern_method_call(userIter, "next", emptyVec)`,
  `done = __is_truthy(__extern_get(res, "done"))`,
  `value = __extern_get(res, "value")`.
- Deps set up before bodies: `ensureObjectRuntime`, force-register the
  `@@iterator`/`next`/`value`/`done` string constants, capture
  `__extern_method_call`/`__extern_get`/`__is_truthy` funcMap indices. All three
  are NATIVE funcs in standalone (not imports). tsc clean, module valid.

### BLOCKER (root cause for the runtime hang)
The USER runtime path HANGS (infinite loop in `__iterator_next` — `done` never
becomes truthy). Traced to a PREREQUISITE GAP, not a bug in this code:
**standalone any-receiver method dispatch is broken.** Direct repro on current
main: `const o: any = { next() { return 7; } }; o.next()` → **standalone returns
0** (should be 7) and does NOT even emit `__extern_method_call` — it takes a
different, broken path. So `__extern_method_call(userIter, "next", …)` never
actually invokes the iterator's `next()`; it returns null → `__extern_get(null,
"done")` → null → `__is_truthy` 0 → never done → infinite loop.

Root: `__extern_method_call` only handles an OPEN `$Object` receiver
(object-runtime.ts:~4188 — non-`$Object` brands return undefined); a standalone
object-literal method is a CLOSED WasmGC struct, and the any-receiver call path
doesn't route closed-struct method calls through a working dispatcher. This is
the STANDALONE analog of #2015 (which fixed the JS-host any-receiver `this`
path). The USER carrier is correct in shape but cannot function until standalone
any-receiver object-literal/iterator method dispatch works.

### Recommendation
Prerequisite needed: **native standalone any-receiver method dispatch**
(`o.method()` on an `any`/externref object-literal receiver → call the
closed-struct's compiled method, or a `__extern_method_call` that handles closed
structs). File as a SENIOR prerequisite blocking #2038's USER arm. The
USER-carrier scaffolding (struct + `__iterator`/`__iterator_next` branches) is
committed and ready to light up once the dispatch prereq lands — then the sync
custom-iterable repro (`for (const x of {[Symbol.iterator](){return
{next(){…}}}})` → 0+1+2) should pass, and `ensureAsyncIterator` returning native
`__iterator` in standalone extends it to sync-backed `for await`. Keep
async-gen/yield* + Promise deferred.

## Deep re-analysis (2026-06-14, sdev3) — precise dispatch mechanism + two fix paths

Independently re-confirmed the whole chain on current main (branch
`issue-2038-async-iter-carrier` @ `8ca988f34`). The USER carrier is correct and
regression-free (vec/array path byte-identical, module valid, zero leaked `env`
imports). #2038 is genuinely blocked by **#25**. Two new precise facts beyond
the prior write-up:

### Fact 1 — `__extern_method_call`/`__extern_get` are `$Object`-ONLY; object literals are CLOSED structs
The native `__extern_method_call` (object-runtime.ts ~`:4188`) body is:
`if ref.test (ref $Object) → __apply_closure(__extern_get(recv,name), recv,
args) else → ref.null.extern`. A standalone object literal `{ next(){…} }`
compiles to a **closed nominal WasmGC struct** with a named funcref field
(`$next`), NOT the open `$Object` open-hash-map. So `ref.test $Object` is FALSE
→ else arm → `ref.null.extern`. `__extern_get` (`:~ same family`) has the same
`$Object`-only gate, so reading `.value`/`.done` off the (also closed) result
struct returns null too. Net: the USER `__iterator_next` gets `next()`→null,
`done`→null→falsy→never done→**infinite loop** (clean repro:
`const o:any={next(){return 7}}; o.next()` → **0 in BOTH `--target wasi` AND
`--target standalone`**; under wasi it additionally can't even instantiate
because the any-method arg-array path requests refused `env.__js_array_new`).

### Fact 2 — closed-struct dispatchers ALREADY EXIST and work on these structs
`emitIteratorMethodExport` (index.ts `:2190`, via `emitMethodDispatch`
`:2198`) emits, at finalize, **type-switch** dispatchers over every registered
closed struct:
- `__call_@@iterator(externref)->externref` — `ref.test/ref.cast/call
  <Struct>_@@iterator` per struct.
- `__call_next(externref)->externref` — same for `<Struct>_next`.

and `emitStructFieldGetters` (index.ts `:1737`) emits `__sget_value` /
`__sget_done` — type-switch field getters over closed structs (the #1320
`{value,done}` host-read path). **Verified at runtime**: on the sync
custom-iterable module, `exports.__call_@@iterator(obj)` returns the closed
`{next}` struct (non-null) and `exports.__call_next(it)` returns the `{value,
done}` struct — i.e. these dispatch closed structs correctly. (Could not read
the boxed value from JS, but dispatch fires; the all-`$Object` path returns
null.)

### Two fix paths

**PATH A — targeted carrier rewrite (unblocks #2038 alone, does NOT need #25):**
In `iterator-native.ts`, the USER arms should call the closed-struct
dispatchers, NOT the `$Object`-only helpers:
- `__iterator` USER arm: `userIter = __call_@@iterator(obj)` (fallback to `obj`
  if null), instead of `__extern_method_call(obj,"@@iterator",emptyVec)`.
- `__iterator_next` USER arm: `res = __call_next(userIter)`;
  `done = __is_truthy(__sget_done(res))`; `value = __sget_done(res)?undef:__sget_value(res)`,
  instead of `__extern_method_call`/`__extern_get`.
- **Ordering hazard (the reason this is senior work):** `__call_@@iterator` /
  `__call_next` / `__sget_*` are emitted at FINALIZE (after user structs are
  known), but the carrier bodies are built EARLY in `ensureNativeIteratorRuntime`.
  So their funcIdx are forward references → use the established
  **reserve-then-fill** pattern (`reserveProtoIteratorDriver` /
  `fillProtoIteratorDriver`, #1719) — reserve the carrier `__iterator`/
  `__iterator_next` funcIdx with placeholder bodies, and fill them at finalize
  AFTER `emitIteratorMethodExport` + `emitStructFieldGetters` have run, so the
  `call` targets resolve. Alternatively, late-bind the dispatcher funcIdx the
  same way `fillApplyClosure` does. Validate the vec arm stays byte-identical.
- Spec edge (§7.4.4): a non-object `next()` result ⇒ TypeError via the #1888
  standalone throw helper, never a trap (covered once the USER arm dispatches).
- This path is self-contained to `iterator-native.ts` + finalize ordering and
  does not regress the general any-method path.

**PATH B — general #25 fix (broader, helps every standalone object-literal
method call):** Give `__extern_method_call`/`__extern_get` a closed-struct
fallback. Because they are name-dynamic and fctx-less, a per-name `ref.test`
switch can't live inside one generic body — instead route the call SITE
(calls.ts any-receiver fallback `:7966`, and `emitWrapperDynamicMethodCall`
`:1137`) to: (a) for `ctx.wasi`, take the **ObjVec-builder** branch too (the
`if (ctx.standalone)` at `:8068` / `:1147` must be `ctx.standalone || ctx.wasi`,
else wasi requests refused `__js_array_new`); and (b) when the receiver is a
known closed struct, emit a `ref.test/ref.cast/call <Struct>_<method>`
type-switch (generalize `emitMethodDispatch` to arbitrary method names + args).
Larger surface; needs its own regression pass over all standalone method calls.

### Recommendation (sdev3)
Do **PATH A** to unblock #2038 now (contained, finalize-ordering-sensitive →
keep on senior); pursue **PATH B** as the standalone #25 epic in parallel since
it fixes the whole class. The committed USER-carrier scaffolding only needs its
two dispatch calls swapped to `__call_@@iterator`/`__call_next` + `__sget_*`
plus the reserve-then-fill ordering. Clean repros for both paths:
`const o:any={next(){return 7}};o.next()` (→ should 7) and
`for (const x of {[Symbol.iterator](){let i=0;return{next(){return i<3?{value:i++,done:false}:{value:undefined,done:true}}}}}) sum+=x` (→ 3).

## PATH A LANDED (2026-06-14, sdev4) — USER carrier wired to closed-struct dispatchers

Implemented PATH A exactly as sdev3 specced. `status: done`.

**What changed**
- `src/codegen/iterator-native.ts` — the `$IterRec` USER arm now dispatches
  through the closed-struct helpers, NOT the `$Object`-only
  `__extern_method_call`/`__extern_get` (which returned null → infinite loop):
  - `__iterator` USER arm: `userIter = __call_@@iterator(obj)` (fallback to `obj`
    if null = obj is itself a bare-`next` iterator).
  - `__iterator_next` USER arm: `res = __call_next(userIter)`;
    `done = __is_truthy(__sget_done(res))`; `value = done ? undefined :
    __sget_value(res)`.
  - **Reserve-then-fill (#1719):** the carrier `__iterator`/`__iterator_next` are
    emitted **vec-only** in `ensureNativeIteratorRuntime` (byte-identical to the
    pre-#2038 runtime) with `ctx.nativeIteratorUserArmPending`. The new
    `fillNativeIteratorUserArms(ctx)` rebuilds both bodies with the USER arm at
    FINALIZE, after `emitStructFieldGetters` + `emitIteratorMethodExport` have run
    (so the `__sget_*` / `__call_*` funcIdx resolve). If a module has no custom
    iterable, the dispatchers are absent → the fill is a no-op → vec-only carrier
    (byte-identical, verified).
- `src/codegen/index.ts` — (1) `emitIteratorMethodExport` + `emitStructFieldGetters`
  now register their emitted funcs (`__call_@@iterator`/`__call_next`/`__sget_*`)
  in `ctx.funcMap` (they previously only pushed to `mod.functions`/`mod.exports`,
  so the fill couldn't find them — the actual blocker); (2) finalize calls
  `fillNativeIteratorUserArms` after the two emitters, force-registering
  `__is_truthy` via `addUnionImports` only in the rare bucket that didn't box.
- `src/codegen/statements/destructuring.ts` — `ensureAsyncIterator` in
  standalone/wasi returns the native `__iterator` (CreateAsyncFromSyncIterator =
  identity for sync-backed) instead of the `env.__async_iterator` host import, so
  sync-backed `for await` drives the SAME USER carrier (no host leak, no
  `illegal cast`). Host mode unchanged.

**Validation (all green)**
- sync `for (const x of {[Symbol.iterator](){return {next(){…}}}})` → 3,
  array-backed custom iterable → 60 — standalone, ZERO env imports.
- async sync-backed `for await (const x of customIterable)` → 3 — standalone,
  ZERO env imports. (Was `illegal cast` before.)
- array for-of / for-await / spread / destructuring / generator standalone
  binaries **byte-identical** (sha256) to origin/main — no regression.
- new `tests/issue-2038.test.ts` (6 cases) passes; iterator/generator equiv
  suites show the SAME pre-existing failure set as origin/main (3 unrelated:
  one #681 case, two `symbol-async-iterator` test-harness instantiate errors —
  both fail identically on main, not caused here).

**Still deferred (NOT in this PR):** async-generator `yield*` (sub-bucket B,
`generators-native.ts` sequential-restriction lift) and the standalone
Promise/microtask runtime for genuinely-pending for-await (PR-C). The general
closed-struct any-method dispatch is the separate #25 epic (PATH B).
