---
id: 3170
title: "standalone: Array.prototype.indexOf/lastIndexOf/includes — method-as-value + array-like receivers (125 gap tests)"
status: done
assignee: ttraenkler/opus-3170
created: 2026-07-12
updated: 2026-07-19
completed: 2026-07-16
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: array-methods
goal: standalone
umbrella: 2860
sprint: 72
horizon: m
related: [2860, 2670, 3169, 2861, 2175, 3317, 3318]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff"
---

# #3170 — standalone: Array.prototype search methods as values + over array-likes

## Problem

**125 host-pass tests are not host-free-standalone passes** under
`built-ins/Array/prototype/{indexOf,lastIndexOf,includes}` (indexOf 63,
lastIndexOf 54, includes 8; measured 2026-07-12 lane-baseline diff, method in
#3169). Two measured signatures:

1. `TypeError: Array.prototype.lastIndexOf is not yet callable as a value in
standalone mode` — the prototype-method **value read** (S6-b refusal
   lineage, #1907/#1888): `var f = Array.prototype.indexOf; f.call(obj, 7)`.
   Across ALL of `Array.prototype` this signature accounts for 76 gap rows,
   most of them in this family.
2. `fail: returned 2 — assert #1 … Array.prototype.indexOf.call(obj, …)` —
   array-like receivers with `fromIndex` coercion (`ToIntegerOrInfinity`),
   negative-index clamping, sparse holes, and `length` read via `ToLength`.

## ANTI-BLOAT directive

- Signature 1 is exactly what the **native-proto glue** exists for:
  `src/codegen/native-proto.ts` / `native-proto-value-read.ts`
  (`getNativeProtoBuiltinGlue`, the #2861 pattern) mint callable closures for
  prototype members. Add these three members to the EXISTING glue member CSV +
  memberKind tables — do NOT invent a new value-read path. #2175's
  native-method-closure dispatch spec is the architectural reference.
- Signature 2 rides the SAME generic `$Object`-receiver arm #3169 builds in
  `src/codegen/closed-method-dispatch.ts`. If #3169 lands first, this issue is
  mostly the value-read + `fromIndex`/SameValueZero edge semantics; sequence
  after or alongside #3169 with that boundary agreed (receiver ladder = #3169,
  value-read + search-specific coercion = #3170).

## Acceptance criteria

- ≥90 of the 125 measured gap tests flip to host-free standalone passes.
- Sample tests:
  - `test/built-ins/Array/prototype/indexOf/15.4.4.14-1-6.js`
  - `test/built-ins/Array/prototype/lastIndexOf/15.4.4.15-5-21.js`
  - a `…is not yet callable as a value` repro:
    `var f = Array.prototype.indexOf;` used via `.call` must run host-free.
- Zero host-mode regressions; zero standalone high-water regressions.
- One PR, one method family — no drive-by fixes to other Array methods.

## Verify-first findings (2026-07-13, opus-3170)

**The "125 gap / ≥90 flips" headline is OBSOLETE.** #3169 (array-like receiver
ladder for the callback HOFs) landed the SAME day this was groomed and
pre-closed ~83 of the 125. Process-isolated (`runTest262File`) branch-vs-main
measurement of all three dirs on current `main` gives the REAL residual:

| dir         | host-pass | std-pass | gap    |
| ----------- | --------- | -------- | ------ |
| indexOf     | 110       | 94       | **16** |
| lastIndexOf | 106       | 85       | **21** |
| includes    | 17        | 12       | **5**  |
| **total**   |           |          | **42** |

(An earlier shared-process loop under-counted this to 16 via cross-test state
contamination — the per-dir numbers above are each measured in an isolated
process, per the measurement-integrity mandate.)

### Residual-42 bucket breakdown (all verified by direct compile+run)

1. **Exotic host-object receivers (~10)** — `Array.prototype.indexOf.call(o, …)`
   where `o` is `new Date` / `new RegExp` / `new String` / `new SyntaxError`
   with `.length` + `[k]` added. `__extern_length` answers 0 for these host
   brands → `-1`. Needs host-object dynamic-property length/index reads
   (broad, not bounded).
2. **Primitive receivers (~11)** — `.call(true, …)` / `.call(5, …)` /
   `.call("abc", …)`. Reflective closure body (`emitArrayProtoMemberBody`,
   array-object-proto.ts) still refuses everything but `slice` (the "is not yet
   callable as a value" signature). Needs ToObject(primitive) + prototype-chain
   reads (`Boolean.prototype[1]` …) — very hard.
3. **ToNumber of an object-valued `length`/`fromIndex` (~6)** — `-3-19/-3-20`
   (object `length` with `toString`/`valueOf`), `lastIndexOf/-5-21` (object
   `fromIndex`). Needs `__to_primitive`→ToNumber wired into the closed-struct
   `__extern_length` arm / the fromIndex path, WITH spec side-effect ordering
   (`-3-21`) and abrupt-throw (`-3-22`). No single ToNumber-of-externref helper
   exists today; medium complexity + touches a broadly-used helper.
4. **Real-array heterogeneous null/undefined (~4: `-9-4/-9-6`, `-8-4/-8-6`)** —
   `[…,null,…,undefined,…].indexOf(undefined)`. BLOCKED by value-rep substrate:
   `null` and `undefined` both store as `ref.null.extern`, so
   `__extern_strict_eq(null, undefined) === true` and the information needed to
   distinguish them is already lost at storage. Not fixable in this lane without
   the undefined-singleton substrate work.
5. **`includes` return-abrupt getters (4)** — `includes.call({get length(){throw}}, …)`
   inside `assert_throws`. "illegal cast in `__closure`" — accessor-getter
   invocation from `__extern_length` (broad).
6. **CE crash (2: `-9-a-14`, `-8-a-14`)** — `Cannot create property
'declaredType' on number '1'` (prototype-delete pattern). Compiler crash.
7. **Object-identity / `new Array` gap rows (`-9-5`, `-8-5`)** — direct
   compile+run of these returns the CORRECT value (`ref.eq` preserves object
   identity even in heterogeneous `new Array(...)`); the corpus rows fail for a
   HARNESS/vacuity reason, not indexOf logic.

### What this PR does (the bounded, safe slice actually landed)

**`fromIndex` for the standalone `$__vec_base` search arm** (indexOf /
lastIndexOf / includes), in `closed-method-dispatch.ts`. The #2583 arm
linear-scanned the WHOLE array and IGNORED the 2nd arg, so `a.indexOf(x, n)` /
`a.lastIndexOf(x, n)` / `a.includes(x, n)` over an any-array returned the
no-fromIndex answer (verified wrong: `[10,20,30,20].indexOf(20,2)` → `1`;
`[10,20,30].includes(10,1)` → `true`). The fix computes the scan START from
`ToIntegerOrInfinity(fromIndex)` with the §23.1.3.14/.20/.15 clamp. Active only
for arity ≥ 2 search dispatchers; arity-1 is byte-identical (emit-identity
safe). +21 non-vacuous unit assertions (`tests/issue-3170-fromindex.test.ts`).

### Genuine-vs-vacuous yield (measured, process-isolated)

- **0 net test262 delta, 0 regressions.** Branch gaps == main gaps
  (indexOf 16 / lastIndexOf 21 / includes 5 — identical file sets).
- The fromIndex fix is a **genuine correctness fix with ZERO corpus yield**
  because the corpus's fromIndex tests (`using-fromindex.js`, the `-5-*` series,
  …) are **VACUOUS standalone passes** — they already count as `pass` despite
  the pre-fix wrong answers. Flagged separately per the measurement mandate; the
  correctness win converts to genuine flips once the honest-vacuity oracle
  (#3086) removes the masking. The +21 direct compile+run assertions are the
  non-vacuous proof (fail on main, pass on branch).

### Recommendation (for PO re-scope)

`#3170` cannot meet its `≥90` acceptance as scoped. Suggest splitting the
residual 42 into targeted follow-ups by bucket above — several (4 substrate,
1 primitive-receiver, 2 exotic-host-receiver) depend on infrastructure outside
this method family and are NOT bounded single-PR work. Buckets 3 (ToNumber-of-
object) and 5 (includes abrupt getters) are the next most tractable.

## Re-scope decision (tech lead, 2026-07-16)

Closing `#3170` as `done` against a re-scoped acceptance: the original
`≥90 flips` target was set from a pre-#3169 gap count (125) that #3169 landing
the same day pre-closed to 42 — unreachable as originally scoped, not a
shortfall in execution. What actually shipped is real: a genuine `fromIndex`
correctness fix (§23.1.3.14/.20/.15 clamp) with zero regressions, +21
non-vacuous unit assertions, and an honest 0-net-corpus-yield explanation
(the corpus's own fromIndex tests were already vacuous passes pre-fix — this
converts to a genuine flip once #3086's honest-vacuity oracle lands, not
before).

Residual 42 split by bucket:

- **Buckets 3 + 5** (ToNumber-of-object length/fromIndex, `includes` abrupt
  getters — ~10 tests, judged most tractable) → **#3317**.
- **Bucket 6** (CE crash, `'declaredType' on number` — 2 tests, a compiler
  crash unrelated to search-method semantics) → **#3318**, split on its own
  merits per the no-drive-by-fixes convention.
- **Bucket 4** (real-array null/undefined identity, ~4 tests) — already
  tracked as substrate-blocked on the undefined-singleton work; no new issue,
  cross-referenced to #2106.
- **Buckets 1 + 2** (exotic host-object receivers ~10, primitive receivers
  ~11) — broad, not bounded single-PR work; left as known-blocked residual
  under the #2860 umbrella, no new issue until someone scopes the underlying
  host-object/ToObject(primitive) infrastructure work itself.
- **Bucket 7** (`-9-5`/`-8-5`, harness/vacuity-artifact rows, not a real
  indexOf gap) — flagged to whoever owns the #3086 honest-vacuity oracle;
  not this issue's or #3317's concern.

## Residual still live — re-confirmed 2026-08-03 (from #4119)

Buckets 1 + 2 above are **still open and still correctly attributed here.**
#4119 (the `array-object-proto.ts` refusal ladder) found 24 rows —
`indexOf` 11, `lastIndexOf` 12, `includes` 1 — carrying the same
`… is not yet callable as a value in --target standalone` string, and asked
whether this issue's fix was partial or a second site had been missed.

Verified from the test files themselves (standalone baseline
`2026-08-03 19:17`): **neither.** Every one of the 24 is a primitive or exotic
receiver — `applied to boolean primitive`, `to number primitive`,
`to string primitive`, `to Function object`, `call-with-boolean.js` — i.e.
exactly buckets 2 and 1 as written above. They were left deliberately, needing
`ToObject(primitive)` / host-object dynamic length+index reads, and #4119 has
**dropped** them from its scope rather than double-fixing.

No action here; recorded so the next reader does not re-derive it.
