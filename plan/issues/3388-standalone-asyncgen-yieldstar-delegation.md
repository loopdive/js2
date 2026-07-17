---
id: 3388
title: "standalone: async-gen `yield*` over non-literal sources in NESTED/method producers — runtime delegation with §27.6.3.7 GetIterator error semantics (~600 rows)"
status: ready
sprint: current
created: 2026-07-17
updated: 2026-07-17
priority: high
horizon: l
feasibility: hard
model: opus
reasoning_effort: high
task_type: feature
area: codegen, standalone
language_feature: async-generators, yield-star, iterator-protocol
goal: standalone-mode
umbrella: 3178
related: [3132, 3387, 3389, 2906, 2865, 3075]
origin: "2026-07-17 fable-3178 umbrella decomposition — the yield-star cohort of the standalone host_import_leak baseline (#3132 S3, re-grounded with the nesting-seam finding)."
---

# #3388 — async-gen `yield*` delegation for nested + method producers

## Problem

~600 official-scope `host_import_leak` rows carry `__gen_yield_star`
(917 total across combos; the pure combo
`__create_async_generator,__gen_create_buffer,__gen_next,__gen_yield_star,__get_caught_exception`
alone is 544). Concentrated in:

- `{expressions,statements}/class/elements` — `yield-star-getiter-*`,
  `yield-star-next-*` private/RS async-gen METHOD files (200-row combo),
- `{expressions,statements}/class/async-gen-method[-static]` (~262 across
  combos — `yield-star-getiter-sync-not-callable-*-throw`, abrupt-path tests),
- `expressions/object/method-definition` (~65).

These are the #3132 S3 banked slice, re-grounded: #3132 closed after S1
(array-literal unroll) + S2 (methods receiver-threading); general `yield*`
never landed for the shapes below.

## Probe matrix (2026-07-17, current main, `--target standalone`)

| shape                                                    | module scope | wrapped / method    |
| -------------------------------------------------------- | ------------ | ------------------- |
| `async function* g() { yield* arr; }` (array ident)      | HOST-FREE    | **LEAKS** (wrapped) |
| `async function* g() { yield* customAsyncIterableObj; }` | HOST-FREE    | **LEAKS** (wrapped) |
| class `async *m() { yield* … }` (the corpus files)       | —            | **LEAKS**           |

Same seam as #3387: `analyzeAsyncGen` (`src/codegen/async-cps.ts:2240`)
returns null for any `yield*` whose operand is not an ARRAY LITERAL
(the S1 gate at ~2266: `if (!ts.isArrayLiteralExpression(src)) return null`),
and the nested-declaration / class-method / object-literal lanes
(`nested-declarations.ts:678/:1104`, `class-bodies.ts:2354` region,
`literals.ts:2974-2982`) all consult that analyzer via
`isAsyncGenDriveCandidate` (async-frame.ts:2073). At module scope some OTHER
arm admits these host-free — #3387 step 1 locates and validates that arm;
coordinate with whoever lands #3387 first and reuse the documented finding
from umbrella #3178.

## Implementation Plan

### Slice 1 — runtime delegation loop (the #3132 S3 design, now actionable)

Extend `analyzeAsyncGen` with a DELEGATION segment kind for `yield* <expr>`
over an arbitrary operand (identifier, call, member, string), lowered as a
runtime CFG loop — the producer-side DUAL of the `planForAwaitAsyncCfg`
consumer (async-cps.ts:1907):

- **head state**: evaluate operand once; GetIterator per §27.6.3.7 —
  try `Symbol.asyncIterator`, fall back to `Symbol.iterator` wrapped in the
  AsyncFromSync equivalent (reuse the existing consumer machinery in
  `iterator-native.ts` — the ITER_KIND dispatch — rather than a parallel
  GetIterator).
- **loop**: `inner.next()` → await (carrier `$Promise` assimilation, #2865) →
  read `{done, value}` from the `$IteratorResult` struct → if `done` exit with
  the result VALUE as the yield\*'s completion value → else `settleYield value`
  (the outer's pending `next()` promise fulfills `{value, done:false}`) →
  back-edge on outer resume.
- Slice 1 forwards `next()` only. Outer `.return()`/`.throw()` forwarding into
  the delegate (§27.6.3.7 steps 7.b/7.c) is #3389's completion machinery —
  keep those legacy where they cannot be expressed (correct-or-legacy), but
  note that many corpus files here only need the GetIterator ERROR paths (see
  edge cases), which slice 1 fully covers.

### Slice 2 — the method lanes

The class-method (`class-bodies.ts`, after the #3132 S2 receiver-threading
gate) and object-literal (`literals.ts:2974`) lanes admit the widened bodies
automatically once `analyzeAsyncGen` accepts them — the gate is shared. Verify
the S2 exclusions (super/arguments/static-this, `methodBodyRefsShadowedOuterLocal`
#3312 guard, stem dedup) still bail correctly, and run the private-name RS
file family (`same-line-async-gen-rs-*`) — several are already host-free on
main, so measure-first to avoid re-fixing landed rows (the promoted baseline
lags; see #3380).

## Edge cases (these ARE the corpus tests)

- `GetMethod(obj, @@asyncIterator)` returns null/undefined → fall to sync;
  both absent → TypeError at delegation start (getiter-\*-not-callable files:
  boolean/number/string/symbol/object variants).
- `@@asyncIterator` getter throws → propagate (getiter-\*-get-abrupt).
- iterator object not an object / `next` not callable → TypeError
  (yield-star-next-not-callable-\*).
- `next()` result not an object / `done`/`value` getter throws → propagate
  (next-call-{done,value}-get-abrupt, next-call-returns-abrupt).
- All of these must surface through the OUTER driven `next()` promise
  REJECTION (the native `__exn` tag path, `ensureExnTag` in
  `src/codegen/registry/imports.ts`) — never a trap.
- The implicit-await distinction (#3120): delegation does NOT re-await inner
  values on the modeled lane — keep the S1 mode routing
  (`yieldOperandIsPromiseTyped`) consistent.

## Test plan

- Executed probes (wrapped shape) for: value forwarding order, done-value as
  completion value, each abrupt GetIterator path asserting TypeError delivery
  via rejection.
- Construct-sample the `yield-star-*` file family across
  class/elements + async-gen-method dirs; zero pass→fail on the #3132 S1/S2
  suites (`tests/issue-3132*.test.ts`) and the driven-consumer scans.
- Mix-safety: module with one delegating gen + one legacy-only gen keeps
  carrier off coherently (pre-pass ⊆ emit).

## Regression risks

- The delegation loop shares frame/state numbering with #3387's for-await
  states — if both land concurrently, coordinate the CFG segment-kind
  enum/state-allocation in `analyzeAsyncGen` (same function, guaranteed
  conflict; sequence the PRs, second re-merges first).
- `__gen_yield_star` import retirement must not orphan the HOST-lane eager
  buffer which still uses it (host lane byte-identical — SHA probe).
