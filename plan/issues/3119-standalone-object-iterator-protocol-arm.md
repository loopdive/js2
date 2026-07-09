---
id: 3119
title: "Standalone plain-$Object @@iterator protocol arm in the native __iterator ladder (#3100 Design arm 3) — post-hoc x[Symbol.iterator]=fn: 810 test262 files, 0 host-free"
status: done
completed: 2026-07-09
assignee: ttraenkler/fable-3119
sprint: current
model: fable
created: 2026-07-09
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, standalone
language_feature: iterators, for-of, destructuring, spread
goal: standalone-mode
umbrella: 2860
related: [3100, 3117, 3098, 1888, 2866, 2038]
origin: "2026-07-09 fable-3100s4 — split from #3117. The dot-set closure-store fix (#3117) landed; this is the remaining, larger S1-grade slice: a $Object @@iterator arm in the GetIterator ladder. Prove-first quantified 810 files."
---

# #3119 — plain-$Object @@iterator protocol arm

## Problem (verified against origin/main, 2026-07-09, standalone)

The native `__iterator` GetIterator ladder (#3100 S1/S5, iterator-native.ts)
has arms for the canonical `$Vec`, the vec-FAMILY carriers (`$ObjVec` /
typed vecs), and the closed-struct USER `{next()}` carrier — but **NO arm for
a plain `$Object` whose `@@iterator` was installed dynamically**
(`o[Symbol.iterator] = fn`). The install itself works (computed member-set is
a genuine `$Object` store, #3117-adjacent), but iteration finds no arm:

```ts
const o: any = {};
o[Symbol.iterator] = function () {
  let i = 0;
  return {
    next: function () {
      i += 1;
      return { value: i * 10, done: i > 3 };
    },
  };
};
[...o]; // ✗ [] (length 0 — __iterator_rest sees a non-vec, non-USER record)
for (const v of o) // ✗ TRAP: illegal cast (ladder tail hard-casts to $Vec)
  let x;
[x] = o; // ✗ x undefined
```

This is #3100's **Design arm 3** (§"Design — **get_iterator / **iter*step"),
specced day one, never built. It is distinct from the S3 closed-struct USER
arm: that dispatches through the closed nominal `<Struct>*@@iterator`/`<Struct>\_next`type-switch; this needs to read`@@iterator`/`next`/`return`as`$Object`PROPERTIES and invoke them via`\_\_apply_closure`.

## Population (fresh standalone baseline, 2026-07-09)

**810 test262 files** use the post-hoc `x[Symbol.iterator] = fn` install
(185 in the dstr/for-of clusters alone, including the 57 `*-close.js` rows
that #3100 S5's closed-struct IteratorClose could not reach — those iterators
are plain `$Object`s, not closed structs). Standalone lane today:
740 fail(leaky) + 57 pass(leaky) + 13 CE — **zero host-free**. The arm is
NECESSARY for all of them.

## Design (new $IterRec kind OBJ, fill-time — same reserve-then-fill as S1/S5)

Add an OBJ kind (e.g. `ITER_KIND_OBJ = 4`) to the `__iterator` ladder,
between the vec-family arms and the USER/trap tail:

- **GetIterator** (`buildIteratorBody`): `ref.test $Object` →
  `iterFn = Get(v, @@iterator)` via the symbol-keyed object-runtime read
  (`@@iterator` is well-known symbol id 1; the `$Object` hash-map keys on the
  `$Symbol` carrier — #2866). callable ⇒ `iterObj = __apply_closure(iterFn,
v, [])`; validate `iterObj` is an Object else TypeError §7.4.3 (deferred
  refinement OK) → `$IterRec{OBJ, vec:null, 0, userIter:iterObj}`.
- **IteratorStep** (`buildIteratorNextBody`): OBJ arm →
  `next = Get(iterObj, "next")` → `res = __apply_closure(next, iterObj, [])`
  → `done = ToBoolean(Get(res,"done"))`, `value = Get(res,"value")` through
  the dynamic reader (`__extern_get`, carrier-correct #3053).
- **IteratorClose** (`buildIteratorReturnBody`, extend the S5 USER arm):
  OBJ arm → `ret = Get(iterObj, "return")` → absent/undefined ⇒ no-op; else
  `__apply_closure(ret, iterObj, [])`.

Consumers (for-of, dstr materializer `__array_from_iter_n`, `__iterator_rest`,
spread) bind through the existing names — **no consumer changes** (the #3100
chokepoint discipline). The OBJ record reuses the USER `userIter` field, so
`__iterator_rest`'s S5 USER step-to-exhaustion drain and the materializer's
user-iterable drain arms already handle it once `next` dispatches.

### Infra dependencies (all landed)

- `__apply_closure` (#1888) — arity bridge, reserve-then-fill; degrades safe.
- symbol-keyed `$Object` read (#2866 `$Symbol` carrier + `__obj_hash`/
  `__key_equals` symbol branches) — the `@@iterator` key is a `$Symbol` box.
- `__extern_get` / `__is_truthy` (object runtime) for `next`/`done`/`value`.

### Hazards to respect (from #3100 S1/S5)

- Fresh `Instr` objects per arm (factory style — #2169b shared-object
  double-remap).
- Baked funcIdxs (`__apply_closure`, `__extern_get`, `__is_truthy`,
  symbol-read helper) resolved from funcMap at fill time; import shifts walk
  the defined body.
- The GetIterator `@@iterator` read must materialize the well-known
  `$Symbol` for id 1 host-free (verify `nativeStringLiteralInstrs` is not on
  the symbol path — the key is a symbol carrier, not a string).

## Acceptance

1. `[...o]`, `for (const v of o)`, `[x] = o`, `const [x] = o` over a
   post-hoc-`@@iterator` plain object produce values host-free; IteratorClose
   fires on break/throw/non-exhaust (reuse #3100 S5 probes with a plain-object
   iterable).
2. Measured flips in the 810-file population (fresh sweep, branch vs main);
   zero unexplained pass→fail; byte-identity on unrelated corpus.
3. merge_group + standalone floor green.

## Effort

L — the GetIterator/Step/Close arms are new codegen over `$Object` reads +
`__apply_closure`, but slot into the existing fill infrastructure. Solo Fable
design slice (arm ABI + symbol-read wiring); the consumer side is already
built (S4/S5).

## Implementation Notes (2026-07-09, fable-3119) — built on fable-3022's map

**The #2866 crux resolved by direct probe, not new infra**: the host-free
symbol-keyed `@@iterator` read is simply `__extern_get(obj, __box_symbol(1))`.
Probe on pre-change main: `const f: any = o[Symbol.iterator]; f()(…).next()`
already worked end-to-end host-free — `__obj_find` classifies a `$Symbol`
search key by id (`searchIsSym`/`searchSymId`) and the stored key is the
interned carrier, so id-compare matches regardless of carrier instance. No
new symbol machinery was needed; only the ladder arm was missing.

**Design decisions that differ from (or sharpen) the original map:**

1. **No `ref.test $Object` gate on the GetIterator OBJ arm.** The arm calls
   `__extern_get(obj, boxSym(1))` directly and gates on `__is_truthy` of the
   result. Non-`$Object` subjects answer the miss (falsy) and fall through to
   the USER tail unchanged — same net behavior as a type gate, but it also
   serves any carrier the dynamic reader can handle (e.g. future sidecars).
   `__is_truthy` is the single truthiness gate everywhere (it treats the
   #2106 tag-1 `$undefined` singleton as falsy, unlike `ref.is_null`).
2. **Carrier-branched property reads (the non-obvious part).** The iterator
   OBJECT and the step RESULT both routinely pre-shape into CLOSED STRUCTS,
   not `$Object`s (`{ next: function () {…} }` is a struct with a
   field-stored closure, #3117; `{value, done}` likewise). `__extern_get`
   returns miss for those. So `next`/`return`/`done`/`value` reads all
   branch: `ref.test $Object` → `__extern_get`; else → the #2038 field
   getters (`__sget_next` / `__sget_return` / `__sget_done` / `__sget_value`),
   looked up optionally at fill time (present exactly when such a literal
   exists in the module). Without this, iteration silently drains empty —
   the first build did exactly that.
3. **Invocation** is uniformly `__apply_closure(fn, recv, emptyVec)` (#1888):
   `__extern_length(emptyVec)=0` → `__call_fn_method_0(recv, fn)`, which
   dispatches field-stored closures with `recv` bound as `this`. The bridge is
   reserve-then-fill; the fill reserves it if no other site did (safe at
   finalize: `fillApplyClosure` runs later in the index.ts sequence, after
   `emitClosureMethodCallExportN`).
4. **OBJ deps fill independently of the USER deps** — the repro module has NO
   closed-struct `__call_next`/`__call_@@iterator` dispatchers, so gating the
   OBJ arm on `deps` (as `__iterator_next`'s rebuild used to) would never
   fire. `__iterator_next` now rebuilds when `deps || objDeps`, with the kind
   chain USER → OBJ → VEC. Anti-spin guard: a falsy step result (missing/
   uncallable `next`, bridge degrade) reports `done=1` instead of looping
   (§7.4.3 TypeError refinement deferred, S1 no-throw discipline).
5. **`__array_from_iter_n` drainability**: the guard admits a source whose
   `@@iterator` property is truthy (one extra `__extern_get` probe);
   `@@iterator`-less array-like `$Object`s keep the #2904 indexed
   pass-through — this is what keeps arguments-object destructuring intact.
6. **`__iterator_rest`** admits every step-driven kind the fill installed
   (`[USER]`, `[OBJ]`, or both) — the drain itself steps through
   `__iterator_next`, which owns the kind dispatch.

**Byte-identity**: `prove-emit-identity` (39 file×target hashes incl.
standalone/wasi) — IDENTICAL vs main baseline. All builders emit exactly the
previous instruction stream when `objDeps` is undefined.

**Validated**: 9 new tests in `tests/issue-3119.test.ts` (for-of, spread,
dstr-assign, const-dstr, close-on-break, close-on-non-exhaust, mixed
array+obj, immediate-done, non-callable degrade) — all host-free (zero
imports asserted). #3100/#3100-s4/#3100-s5/#3117/#2038/#1665 suites green
(the one issue-2151-mixed-spread failure pre-exists on main).

**Measured population flip (851-file `[Symbol.iterator] =` sweep,
standalone lane, branch vs main, 2026-07-09):**

| status        | main | branch |
| ------------- | ---- | ------ |
| pass          | 118  | 318    |
| fail          | 688  | 487    |
| compile_error | 17   | 17     |
| skip          | 28   | 28     |
| run_timeout   | 0    | 1      |

Transitions: **fail→pass 200**, pass→non-pass **0** (zero regressions),
fail→run_timeout 1 (`for-of/body-put-error.js` — a never-done iterator whose
only exit is an abrupt LHS assignment we don't yet raise; added to
`HANGING_TESTS` and tracked as **#3122**, no pass lost: it was host-lane
compile_timeout / standalone fail before).

## Suspended Work (2026-07-09, fable-3022) — verify-first done + de-risked plan (HISTORICAL, superseded by the notes above)

**Status: verified-ready, groundwork complete, handed off for a fresh focused
build session.** Repro confirmed on standalone `origin/main` (for-of over a
post-hoc `o[Symbol.iterator]=fn` plain object → **"illegal cast"** trap, the
ladder tail hard-casting to `$Vec`). The design in this issue is sound and all
infra is landed. Suspended rather than start the delicate 3-arm build late in a
long session (coordinator-endorsed clean-handoff, not a rushed partial).

- **Worktree/branch:** `/workspace/.claude/worktrees/<agent>/` on
  `issue-3119-object-iterator-arm` (pushed to origin; no code changes yet — a
  fresh checkout off `origin/main` is equally fine).
- **Lock:** claim-issue lock will be RELEASED on suspend so the resumer can
  re-claim with `--force`.

### Concrete implementation map (all located this session)

**File:** `src/codegen/iterator-native.ts` — the native GetIterator ladder.

1. **Kind constant.** Add `const ITER_KIND_OBJ = 4;` next to `ITER_KIND_VEC = 3`
   (line 62) / `ITER_KIND_USER = 1` (line 74). Distinct from USER because the
   Step arm dispatches differently (property read + `__apply_closure`, NOT the
   closed-struct `__call_next`).
2. **$IterRec struct** (`getOrRegisterIterRecType`, line 105): NO new field —
   reuse `userIter` (field 3, externref) to hold the plain-`$Object` iterator.
3. **GetIterator arm** (`buildIteratorBody`, line 969): insert an OBJ arm
   BETWEEN `familyArms` (line 1036) and the USER `tail` (line 995). Shape
   (FRESH `Instr` objects — #2169b factory discipline):
   `local.get 1` (objAny) → `ref.test $Object` → if:
   `iterFn = <symbol-keyed Get(v, @@iterator)>`; `ref.is_null`/not-callable ⇒
   fall through to the USER tail (do NOT return); else
   `iterObj = __apply_closure(iterFn, v, <empty-args-vec>)` →
   `struct.new $IterRec {ITER_KIND_OBJ, ref.null vec, 0, iterObj}` →
   `extern.convert_any` → `return`.
4. **IteratorStep arm** (`buildIteratorNextBody`, line 1203): add an OBJ arm
   (guard `rec.kind == ITER_KIND_OBJ`) alongside the vecStep/USER arms:
   `iterObj = rec.userIter` → `next = Get(iterObj,"next")` →
   `res = __apply_closure(next, iterObj, <empty-args-vec>)` →
   `done = __is_truthy(Get(res,"done"))` (local 4), `value = Get(res,"value")`
   (local 5) via the dynamic reader `__extern_get` (carrier-correct, #3053).
5. **IteratorClose arm** (`buildIteratorReturnBody`, line 919, extend the USER
   arm): OBJ arm → `ret = Get(iterObj,"return")` → null/undefined ⇒ no-op; else
   `__apply_closure(ret, iterObj, <empty-args-vec>)`.
6. **Deps** (`UserCarrierDeps`, line 80 + `fillNativeIteratorLateArms`): thread
   new fill-time funcIdxs — `applyClosureIdx` (`ctx.funcMap.get("__apply_closure")`),
   `externGetIdx` (`__extern_get`), `isTruthyIdx` (already present), and the
   symbol-read helper + the well-known `@@iterator` `$Symbol` materializer.
   Reserve `__apply_closure` up front via `reserveApplyClosure(ctx)`
   (object-runtime.ts:8798) so the funcIdx is bakeable at fill.

### The ONE remaining unknown to nail before coding (the risk)

`__apply_closure(recv, fn, args)` (object-runtime.ts:8798, `(externref,
externref, externref)->externref`; `args` is a `$Vec` of externref, empty ⇒
length-0) is confirmed. **What still needs a probe:** the exact host-free
**symbol-keyed `$Object` read** for `@@iterator` (well-known symbol id 1) and
`return`/`next` (string keys):

- Find the `$Object` symbol-keyed read helper (#2866 `$Symbol` carrier +
  `__obj_hash`/`__key_equals` symbol branches). Grep `object-runtime.ts` for
  the well-known-symbol materializer (id 1 = `@@iterator`) — confirm it emits
  the `$Symbol` box host-free (NOT `nativeStringLiteralInstrs`; the key is a
  symbol carrier, not a string). This is the design's own flagged hazard.
- `next`/`done`/`value`/`return` are STRING keys → the standard `__extern_get`
  dynamic reader handles them.

### Validation (mandatory — broad standalone impact)

- Acceptance probes: `[...o]`, `for (const v of o)`, `[x]=o`, `const [x]=o`
  over a post-hoc-`@@iterator` object host-free; IteratorClose fires on
  break/throw/non-exhaust (reuse #3100 S5 probes with a plain-object iterable).
- Standalone-floor + merge_group green; byte-identity on unrelated corpus
  (`WebAssembly.validate` + sha on a non-iterator module — the vec/USER arms
  must stay byte-identical; only the new OBJ arm is additive).
- Measure flips in the 810-file population (branch vs main); zero unexplained
  pass→fail.

### Prior-session deliverables (context)

fable-3022 this session: #3116 (+146, merged), #3043 (+7, merged), #3049
(documented +1-wall, doc PR #2831). #3119 groundwork is the verify-first +
implementation map above.
