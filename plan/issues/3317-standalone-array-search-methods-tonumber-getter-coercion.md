---
id: 3317
title: "standalone: Array.prototype.{indexOf,lastIndexOf,includes} — ToNumber-of-object length/fromIndex + includes abrupt-getter length reads"
status: done
assignee: ttraenkler/fable-3317
completed: 2026-07-16
sprint: current
created: 2026-07-16
priority: medium
feasibility: hard
horizon: m
task_type: bug
area: codegen
goal: standalone-mode
umbrella: 2860
related: [3170, 2860]
origin: "PO re-scope split of #3170 (2026-07-16) — buckets 3 and 5 of the verified 42-test residual, the two judged most tractable"
# (#3102) Genuine growth: the #3317 fixes live exactly in these two files —
# the closed-struct __extern_length arm (object-runtime.ts) and the borrow
# routing/narrowing (array-prototype-borrow.ts). +89/+69 lines, mostly
# rationale comments per house style.
loc-budget-allow:
  - src/codegen/array-prototype-borrow.ts
  - src/codegen/object-runtime.ts
# (#2108) The new closed-struct object-length arm FUNNELS through the
# canonical `__to_primitive` native (no hand-rolled ToPrimitive matrix) —
# the +1 is the sanctioned-direction call site inside the object runtime's
# own helper emission, not a fresh inline coercion copy.
coercion-sites-allow:
  - src/codegen/object-runtime.ts
---

# #3317 — array search methods: object-valued length/fromIndex ToNumber + includes abrupt getters

## Context

Split from #3170 after its verify-first measurement showed the original
`≥90 flips` acceptance criteria is unreachable post-#3169 (only 42 total gap
tests remain, most infrastructure-blocked). This issue carries the two
buckets #3170 judged most tractable as standalone next steps. See #3170's
"Verify-first findings" section for the full residual-42 breakdown and how
these buckets were isolated.

## Scope

**Bucket 3 — ToNumber of an object-valued `length`/`fromIndex` (~6 tests)**:
`-3-19`/`-3-20` (object `length` with `toString`/`valueOf`),
`lastIndexOf/-5-21` (object `fromIndex`). No single ToNumber-of-externref
helper exists today for this path; needs `__to_primitive`→ToNumber wired into
the closed-struct `__extern_length` arm / the fromIndex coercion path, WITH
correct spec side-effect ordering (`-3-21`) and abrupt-throw propagation
(`-3-22`).

**Bucket 5 — `includes` return-abrupt getters (4 tests)**:
`includes.call({get length(){throw}}, …)` inside `assert_throws` currently
traps "illegal cast in `__closure`" instead of propagating the thrown value —
accessor-getter invocation from `__extern_length` needs the same abrupt-throw
plumbing as bucket 3's ToNumber path (they likely share a fix site).

## Explicitly out of scope (do not drive-by fix here)

- Exotic host-object receivers, primitive receivers, real-array
  null/undefined identity — see #3170's buckets 1/2/4, tracked separately
  (bucket 4 is substrate-blocked on the undefined-singleton work, #2106).
- The CE crash (`Cannot create property 'declaredType' on number`) — split
  to #3318, unrelated mechanism.
- The 2 harness/vacuity-artifact gap rows (`-9-5`/`-8-5`) — not a real gap,
  flag to whoever owns the #3086 honest-vacuity oracle instead of fixing here.

## Acceptance criteria

- Buckets 3 and 5 (~10 tests total) flip to host-free standalone passes,
  OR are shown to require infrastructure beyond this issue's reasonable
  scope (in which case, re-split further rather than force a fix).
- Zero host-mode regressions; zero standalone high-water regressions.
- No changes outside the search-method dispatch / length-read coercion path.

## Root cause + fix (2026-07-16, fable-3317)

Three cooperating gaps, all standalone-gated fixes:

1. **Object-valued `length` on a closed-struct receiver read as 0** — the
   #3169 `fillExternArrayLikeStructArms` `__extern_length` arm only accepted
   f64/i32/externref/string-ref `length` fields, so `{1:true, length:
{toString(){…}}}` was not a candidate at all (length → 0 → scan never ran,
   the `-3-19/-3-20/-3-21/-3-22` "returned 2" signature). Fix
   (`src/codegen/object-runtime.ts`): accept ref/ref_null `length` fields and
   run §7.1.20 ToLength(ToNumber(ToPrimitive(v, number))) — `__to_primitive`
   with a null-extern hint (= number/default; valueOf→toString ordering,
   both-objects TypeError via the #2638 class driver), then `__str_to_number`
   (string result) / `__unbox_number` (other primitives), then the shared
   clamp. Abrupt completions propagate as Wasm throws.
2. **`[].includes.call(obj, …)` trapped "illegal cast"** — the corpus spelling
   of the borrow took the generic member path, which cast the borrowed
   receiver to the literal's own vec type. Fix
   (`src/codegen/array-prototype-borrow.ts` `compileArrayPrototypeCall`):
   under standalone/wasi, an EMPTY array-literal method borrow (with
   paren/`as`-cast unwrap) routes through the same compiler as
   `Array.prototype.<m>.call(…)`.
3. **assert_throws bailout + no-search-arg bail routed the observable length
   coercion to the host bridge** — the swallow hazard that bailout guards is
   a HOST-import property; standalone-native reads propagate throws. Fix:
   skip the bailout for search methods under standalone/wasi, and let the
   no-arg form (`indexOf.call(obj)` — §23.1.3 reads length before anything)
   proceed with `searchElement = undefined`.

## Test Results (2026-07-16)

Direct `runTest262File(…, "standalone")` on the scoped corpus — all 10
scoped tests flip fail→pass on the branch:

- `indexOf/15.4.4.14-3-{19,20,21,22}.js` — pass (were "returned 2/3")
- `lastIndexOf/15.4.4.15-3-{19,20,21,22}.js` — pass (were "returned 2/3")
- `includes/return-abrupt-get-length.js` — pass (was "illegal cast in \_\_closure_3")
- `includes/return-abrupt-tonumber-length.js` — pass (was "illegal cast")

Out of scope, verified unchanged/expected: `includes/tolength-length.js` now
progresses past the trap but needs closed-struct property EXPANDO writes
(`obj.length = 0.1` on a literal without a length field — #3177 family);
`-5-21` already passed pre-fix.

Unit tests: `tests/issue-3317.test.ts` (11/11, non-vacuous direct
compile+run). Related suites re-run green: issue-3170-fromindex (21),
issue-1360, issue-3169 (16), issue-1461-standalone-{search,reduce}-arraylike,
issue-2583-any-array-method-brand — 113 tests total. issue-2036.test.ts has
7 pre-existing failures IDENTICAL on pristine main (verified side-by-side;
its "refuses loudly" expectations were retired by #3169's refusal-set
emptying — flagged to the tech lead, not caused here).

Full includes/indexOf/lastIndexOf dir sweep, branch vs pristine main
(same-methodology standalone runs, 422 comparable files): **+11 fail→pass,
0 regressions** (pass 265 → 276). An earlier blanket assert_throws-bail skip
regressed `-9-b-i-31`/`-8-b-i-31` (element-accessor throws behind a plain
closed-struct length, passing on main via the legacy bail's coincidental
"not yet callable" TypeError) — recovered by the
`receiverHasPlainClosedStructLength` narrowing.
