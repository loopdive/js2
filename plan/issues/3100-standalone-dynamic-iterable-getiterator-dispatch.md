---
id: 3100
title: "Standalone dynamic-iterable substrate: native GetIterator/IteratorStep dispatch for externref/any iterables (for-of over `Object.keys(any)` traps illegal_cast today)"
status: done
completed: 2026-07-09
assignee: ttraenkler/fable-3100
sprint: Backlog
model: fable
created: 2026-07-09
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, standalone
language_feature: iterators, for-of, destructuring, spread
goal: standalone-mode
umbrella: 2860
related: [2864, 2865, 3023, 3099, 3098, 2157, 1323, 3031, 2949]
origin: "2026-07-09 fable-arch hard-problems audit (domain 3) — iterator_protocol is the largest standalone leak class (8,156 files @ 2026-06-26 JSONL); probe pinned the dynamic-iterable arm as the live gap on current main"
---

# #3100 — native GetIterator dispatch for dynamic iterables

## Problem (verified against origin/main @ 928c85179, 2026-07-09)

Iteration is native standalone for **statically-typed** iterables, but a
**dynamically-produced / `any`-typed** iterable has no native GetIterator
dispatch — the lowering either bakes a wrong `ref.cast` (trap) or leans on
host imports (`__array_from_iter_n`, `__gen_*`).

Probes (standalone, `nativeStrings`):

```ts
// typed — all native + correct:
for (const s of ["ab","c"]) …           // ✓ 3
const a: string[] = ["ab","c"]; for (const s of a) …  // ✓ 3
const o = {a:5,b:6}; for (const k of Object.keys(o)) …  // ✓ 2  (typed literal receiver)

// dynamic — traps:
const o: any = {a:5,b:6};
for (const k of Object.keys(o)) { n += 1; }        // TRAP: illegal cast (even without touching k)
for (const [k,v] of Object.entries(o)) …           // TRAP: illegal cast
// control: index loop over the same value works:
const ks = Object.keys(o); for (let i=0;i<ks.length;i++) n += o[ks[i]];  // ✓ 11
```

The `iterator_protocol` leak class is the **largest standalone bucket**:
8,156 files in the 2026-06-26 standalone JSONL (4,783 leaky-pass + 2,724
fail + 649 CE), carried by `__gen_*` (generator carrier — #2864, staffed),
`__array_from_iter_n` (4,348), and `__make_callback` (#3098). The generator
carrier work retires the `__gen_*` share; **nothing staffed owns the
"iterate a value whose static type is `any`/externref" dispatch** — this
issue.

## Root cause

The for-of lowering forks on the STATIC type of the iterated expression:

- typed vec struct → native indexed loop (fast path, correct);
- string → native char iteration;
- generator → carrier (native standalone since #2864 lane);
- **externref/`any` → there is no runtime classification arm.** The lowering
  picks a vec typeIdx from unreliable static info and emits
  `ref.cast $vec<T>` on a value that is actually a different carrier
  (`$ObjVec` keys array, boxed-any vec, host-shaped array) → `illegal cast`.
  `Object.keys(<any>)`'s result is exactly this shape, which is why the
  typed-receiver control passes and the `any` receiver traps.

This is the iteration twin of the #3053 reader-carrier convergence: the
_read_ side got a unified `__dyn_member_get`; the _iterate_ side still has
per-shape baked casts.

## Design — `__get_iterator` / `__iter_step`: one native iteration ladder

One pair of runtime helpers (standalone; host lane keeps its host protocol),
mirroring §7.4 GetIterator/IteratorStep and the #3031 Part-0 ladder order:

```
__get_iterator(v externref) -> externref   ;; an IterState carrier
  1. ref.test $Proxy        → trap-aware Get(v, @@iterator) → call → validate
  2. ref.test $vec family   → native index-iterator state {vec, i}  (incl. $ObjVec, boxed-any vec, string[] carrier)
  3. ref.test $Object       → Get(v, @@iterator) via __extern_get (finds user
                               iterators incl. shorthand `[Symbol.iterator]() {}` — needs #3099);
                               callable → invoke via __apply_closure; result must be Object else TypeError (§7.4.3)
  4. native string          → char iterator state
  5. generator/asyncgen carrier → the #2864/#2865 frame (already native)
  6. null/undefined         → TypeError "is not iterable" (catchable)
  7. else (host externref, gc lane only) → host GetIterator import (unchanged)

__iter_step(state externref) -> externref  ;; {done,value} carrier or done-sentinel
  fast arms for the index-iterator states (no per-step allocation for arm 2/4);
  protocol arm calls next() via __apply_closure and reads .done/.value through
  the dynamic reader (carrier-correct per #3053 — tag-6 for objects).
```

Consumers (each currently duplicating shape logic): for-of lowering
(`statements.ts` for-of externref arm), array destructuring from `any`,
spread of `any` (`[...x]`, `f(...x)`), `Array.from(x)` (retiring
`__array_from_iter_n` for GC-native carriers), `for await` (via the #2865
carrier), yield\*. Migrate them one consumer per slice; the helper is the
single place the ladder order and TypeError shapes live (same discipline as
#3031's `__chain_lookup`: one walker, refactor consumers onto it).

### Perf discipline

The typed fast paths are UNTOUCHED (the ladder is emitted only on the
externref/`any` arm that today traps or leaks). Arm 2 keeps iteration
allocation-free by reusing a mutable `{vec, i}` state struct; only the
protocol arm (3) pays per-step `__apply_closure`.

## Slices

| #   | Slice                                                                                                                                 | Scope                                             | Gate                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------- |
| S1  | `__get_iterator`/`__iter_step` + arm 2 (vec-family) + arm 6; wire ONLY the for-of externref arm                                       | the probe traps flip; byte-inert for typed for-of | merge_group + floor |
| S2  | `Object.entries`/destructuring consumer (`for (const [k,v] of …)`)                                                                    | entries probe flips                               | same                |
| S3  | Arm 3 protocol dispatch (user iterators; depends #3099 for shorthand `@@iterator`)                                                    | manual-iterator for-of standalone                 | same                |
| S4  | Spread + `Array.from` consumers; retire `__array_from_iter_n` on GC-native carriers                                                   | leak count drop (4,348 files @ stale baseline)    | same                |
| S5  | Proxy arm (1) + IteratorClose on abrupt completion (§7.4.9 — coordinate with #3023's landed abrupt-completion work, do not duplicate) | `iterator-close` rows                             | same                |

## Edge cases

- **IteratorClose** on break/throw/return out of the loop body (§7.4.9) —
  call `return()` when present; the #3023 residual landed this for the
  existing lanes; the new ladder must route through the same close helper.
- `next()` returning a non-object → TypeError (§7.4.6); `done` coercion via
  truthiness; `value` absent → undefined singleton.
- Re-entrant iteration (nested for-of over the same vec) — per-loop state,
  never a shared global.
- Boxed-any vec elements must come back carrier-correct (tag-6 objects keep
  identity — #3037/#3053 contract), NOT re-proxied externref.
- Strings iterate by code point (§22.1.5.1), not code unit — reuse the
  existing native string-iteration arm.

## Dependencies / non-collision

Depends on #3099 (shorthand `@@iterator` visibility) for S3 only. #2864/#2865
own generator/async-generator carriers (arm 5 consumes their public shape;
do not modify). #3053 owns the read-carrier contract used by `__iter_step`'s
protocol arm. #3098 is independent (callback vs iteration) but shares the
`__apply_closure` invoke arm — land S1 of whichever goes first and reuse.

## Acceptance criteria

1. The three probe traps flip to correct results, host-free.
2. Spread/`Array.from` over dynamic GC-native iterables host-free (S4);
   fresh standalone JSONL shows `__array_from_iter_n` reduced to host-shaped
   receivers only.
3. Typed for-of paths byte-identical (WAT-diff a typed `for (x of arr)`).
4. Full merge_group + standalone floor (iteration is broad-impact).

## Effort estimate

L–XL total; S1/S3 are the Fable-grade design slices (ladder + protocol ABI),
S2/S4/S5 Opus-executable from the S1 template.

## Implementation notes (S1, landed 2026-07-09 — fable-3100)

### Verify-first repro (origin/main @ 825ffba1cf8d3)

All three probe traps reproduced exactly as specced (`illegal cast`):
`for (k of Object.keys(o:any))`, `for ([k,v] of Object.entries(o:any))`, and
`for (x of a:any)` where `a` holds `[10,20,30]`. Controls passed. Two spec
updates from the probes: (a) the **user-`@@iterator` probe already passes on
current main** (#3099 landed method-shorthand materialization + the #2038
USER arm covers it) — S3's "protocol dispatch" was already substantially
alive; (b) **spread of `Object.keys(any)` already passes** (the #2904
`__array_from_iter_n` non-vec guard routes indexable sources to
`__extern_length`/`__extern_get_idx`, which have carrier arms).

### Root cause, pinned to the instruction

WAT tracing showed the failing lowering is NOT in for-of consumer codegen —
the consumer correctly routes through the native `__iterator` /
`__iterator_next` runtime (iterator-native.ts, #1320/#2038). The trap is
inside **`__iterator` (GetIterator §7.4.1) itself**: its ladder accepted ONLY
the canonical externref `$Vec` (`ref.test` then arm) and the else-arm
**hard-cast to the same type** (`ref.cast $Vec<externref>` — the documented
Slice-1 "trap loudly" fallback). But:

- `Object.keys/values/entries(<any>)` return a **`$ObjVec`** (object-runtime
  enumeration carrier, structurally `{len i32, data ref $ObjVecArr}` but a
  DISTINCT type outside the `$__vec_base` hierarchy) → cast traps.
- an `any`-held array literal is a typed **`__vec_<elemKind>`** (probe: `const
a:any=[10,20,30]` builds `__vec_f64`, extern-converted) → cast traps.

This is the exact iteration twin of #2190's read-side gap (`__extern_get_idx`
had no typed-vec arms) and it has the same shape of fix.

### What S1 landed

**One normalize-at-GetIterator step; zero changes to IteratorStep.** At
finalize — when every module-local carrier type is registered, the same
reason `fillExternGetIdxVecArms` fills late — the renamed
`fillNativeIteratorLateArms` (was `fillNativeIteratorUserArms`) rebuilds
`__iterator` with **vec-FAMILY arms** between the canonical-vec arm and the
USER/trap tail:

- `$ObjVec` + every `ctx.vecTypeMap` carrier with a proven element-boxing
  recipe (reuses `boxVecElementToExternref` from #2190: f64/i32 →
  `__box_number`, externref → identity, `$AnyString`/`$NativeString` refs →
  `extern.convert_any`; everything else — boolean-tagged i32, non-string GC
  refs, packed `i8`/`i16` — is SKIPPED and keeps the legacy loud trap, never
  silently-wrong iteration). `i32_byte`/`i8_byte`/`i32_elem` byte carriers
  (ArrayBuffer/Uint8Array storage) are filtered out by key.
- Each arm copy+boxes the elements into a **fresh canonical externref
  `$Vec`** and returns the existing `$IterRec{VEC,…}` — so
  `__iterator_next`/`__iterator_rest` and every consumer are untouched. A
  copy (not an aliased rewrap of the carrier's data array) is deliberate:
  cross-type `struct.new` over structurally-identical-but-distinct array
  types would lean on engine iso-recursive canonicalization — the
  #2009/#2158 hazard class. O(n) once per GetIterator; steps stay O(1).
- The USER arm fill is now **independent** of the family arms (previously the
  whole fill bailed when the closed-struct dispatchers were missing; now a
  module with no custom iterable still iterates `Object.keys(<any>)`).
  `__iterator_next` is rebuilt only when USER deps exist (without the USER
  arm the kind is always VEC — family arms normalize INTO the canonical vec).

Why this locus and not the for-of lowering: every dynamic-iteration consumer
(for-of externref arm, `__array_from_iter_n` drain, future spread/`Array.from`
migration) already binds to `__iterator` by name — widening the ladder fixes
all of them at one chokepoint and is the "one walker, refactor consumers onto
it" discipline the Design section asks for. The issue's provisional
`__get_iterator`/`__iter_step` names were NOT introduced: `__iterator`/
`__iterator_next` ARE that ladder; a parallel pair would duplicate the ABI.

Discipline notes: fresh `Instr` objects per arm (factory style — the #2169b
shared-object double-remap hazard); the only baked funcIdx is `__box_number`,
resolved from funcMap at fill time exactly like the landed #2038 USER-arm
dispatcher funcIdxs; three scratch locals (`i`/`len`/`out`) are declared at
registration so the fill never grows the locals list.

### Arm-6 finding (null/undefined TypeError)

Under the current default value regime, `undefined` on the externref plane IS
`ref.null extern`, and the for-of consumer (loops.ts) already null-guards and
throws BEFORE calling `__iterator` — probe `for (x of null)` lands in `catch`
today. So a separate ladder arm would be dead code until the #2106
`undefinedSingleton` regime (flag-gated, default OFF) makes `undefined` a
distinct non-null singleton. Deferred to the #2106 flip lane: when the
singleton activates, add an identity arm (`ref.eq` against the
`$undefined` global) that throws a real TypeError.

### Validation (all measured, branch vs unmodified main)

- **Repro→fixed**: all 3 traps flip (`2`, `11`, `3`), host-free; 15-case edge
  probe (nested/re-entrant, break, empty, mixed elems, string vecs, Map,
  generators, typed arrays, function-returning-any) 14/15 — the 1 failure
  (`const [x,y] = a:any` fixed-arity dstr, "Cannot convert object to
  primitive value") reproduces IDENTICALLY on main: pre-existing, different
  lane (S2/S4 consumer, `__extern_get_idx` boxing), not a regression.
- **`tests/issue-3100.test.ts`**: 15/15 (10 fix cases + 5 regression guards),
  every case asserts ZERO host imports.
- **Byte-identity**: 10-program corpus (host arith/for-of/class/async/spread/
  dstr/`arr.values()`, standalone typed for-of/string for-of/typed
  `Object.keys`) — SHA-256 identical main vs branch. Only modules that
  register the native iterator runtime change bytes (that's the fix).
- **Scoped equivalence**: 30 iterator/spread/generator/dstr test files — the
  only failures (15+5) are byte-for-byte the same pre-existing set on main.
- **test262 clusters via `runTest262File` (standalone lane)**:
  `language/statements/for-of` (182 files: 81P/95F/6CE),
  `built-ins/Array/from` (47: 4P/26F/17CE),
  `language/expressions/assignment/dstr` (368: 228P/140F) — per-file status
  maps IDENTICAL main vs branch, zero flips either way. test262's untyped JS
  mostly presents checker-typed receivers to for-of, so the S1 population
  there is small; the S1 value is the user-code `any` shape (the probes) and
  the substrate for S2–S5 (S4's 4,348-file `__array_from_iter_n` retirement
  is where the JSONL leak-count drop is expected).

### Remaining slices (unchanged plan)

S2 largely subsumed (entries destructuring works via the S1 arm — probe
`[k,v]` sums values correctly); S3 protocol arm alive via #2038+#3099 for
closed-struct iterables (plain-`$Object` `@@iterator` residuals may remain);
S4 (spread/`Array.from` consumer migration onto `__iterator`, retiring
`__array_from_iter_n`'s bypass) and S5 (Proxy arm + IteratorClose §7.4.9
through the ladder) are open. Fixed-arity dstr from `any` (`const [x,y] =
a`) is a distinct pre-existing bug in the read lane — worth its own issue.
