---
id: 4613
title: "5 stale assertions in #2949's own suites fail on current main (bucket expectations moved by later work)"
status: done
sprint: current
created: 2026-08-21
completed: 2026-08-22
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: hardening
area: tests
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [2949, 4730, 3520, 3536, 4615]
origin: "#2949 census re-measurement (PR #4730): 5 assertions across issue-2949-slice3b-any-dynamic and issue-2949-slice2-dynamic-producers fail with byte-identical messages on main and on the PR branch"
# id 4613 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-21 (gh CLI offline in this container; pr_scan=degraded). MCP
# open-PR scan at reservation: open PRs 4732/4733 introduce no issue files
# with ids near 4613.
---

# #4613 — re-ground the 5 rotted #2949 suite assertions

## Problem

`tests/issue-2949-slice3b-any-dynamic.test.ts` and
`tests/issue-2949-slice2-dynamic-producers.test.ts` carry **5 assertions
that fail on current main**, byte-identically with and without any recent
change — bucket expectations that other landed work moved (e.g. a case now
reporting `call-resolution-unsupported` where the test pins
`param-type-not-resolvable`). Rotted assertions mask real regressions in
exactly the suites meant to defend #2949's claims — same pathology as the
17 red #3520 census files (PR #4733's de-pinning rationale applies).

## Implementation Plan (Fable, 2026-08-21)

Per the #4733 pattern: for each of the 5, decide whether the moved bucket
is (a) correct evolution — re-ground the assertion on the invariant it
defends (claimed vs not-claimed; the family's terminal outcome class)
rather than the literal bucket string; or (b) a real regression — file it.
Do NOT blanket-update strings to whatever main currently reports without
the (a)/(b) verdict per assertion; that would launder a regression. Record
the per-assertion verdict in this file.

## Per-assertion verdicts (opus-4613, 2026-08-22, base `3d1de92f0`)

All five were re-measured directly on this base before any edit. **Verdict:
5 of 5 legitimate evolution, 0 regressions** — but A5's evolution is a
*safety guard catching a real, still-unfixed ABI divergence*, so the
divergence itself is filed as **#4615** rather than papered over.

| #      | Suite / assertion                                                    | Pinned (was)                                              | Main today                                                        | Verdict                                | Invariant now pinned                                                                                                   |
| ------ | -------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **A1** | slice2 · "truthiness test of dyn param → param-type-not-resolvable"  | not claimed + `param-type-not-resolvable`                 | **claimed**, builds with 0 post-claim demotions                    | **evolved** — #2949 S5.1 (`dyn.truthy`) | outcome CLASS `claim`: claimed pre-build **and** zero post-claim demotions                                              |
| **A2** | slice2 · "dyn arg into a concrete (annotated) param → …"             | not claimed + `param-type-not-resolvable`                 | **claimed**; `x` call-site narrowed to `g`'s f64 ABI (`$f (type 1)`) | **evolved** — call-site param narrowing | same `claim` class; the shape is no longer a *dynamic* use at all                                                       |
| **A3** | slice2 · "calling the dyn value itself → param-type-not-resolvable"  | `param-type-not-resolvable`                               | not claimed, `call-resolution-unsupported` (`expr-local-call-target`) | **evolved** — bucket refined            | outcome CLASS `reject`: not claimed, a **pre-claim** fallback recorded, bucket **not** in the deferred/wont-fix set     |
| **A4** | slice3b · "non-move any uses now reject PRE-claim"                   | `isSame(a: any, b: any)` with `a === b` not claimed       | **claimed**, builds clean, runtime correct incl. `null === undefined` | **evolved** — #2949 S5.2 (`dyn.eq`)     | the *channel* 3b removed: any-annotated shapes never claim-then-demote (asserted over both a claiming and two declining shapes) |
| **A5** | slice3b · "any[] … fast zero-demotion compile"                       | `irPostClaimErrors == []` in fast mode                    | soft `abi-signature-parity` withdrawal (`IR=41, legacy=40`)         | **evolved guard, real underlying gap → filed #4615** | the guard's SAFETY property: divergence caught, withdrawal soft, legacy ABI ships, module valid                          |

### Evidence

**A1 / A2 / A4 — claim flips, measured on `3d1de92f0`.** All three claim,
carry no fallback record, build with `irPostClaimErrors == []`, and their
host-mode `func` header is byte-identical to the `experimentalIR: false`
compile. Runtime spot-checks: A1 `f(42)=42 f(0)=0 f("a")="a" f(null)=null`;
A2 `f(42)=42` with `$f` interned on `$g`'s own `(param f64) (result f64)`
type; A4 `isSame(1,1)=1 (1,2)=0 ("a","a")=1 (null,undefined)=0`. Each flip
is already pinned positively elsewhere — `tests/issue-2949-s5-1-truthiness.test.ts`
and `s5-p-claim-flip` (`truth`) for A1, `s5-p-claim-flip` (`hexToInt`) for
A2, `tests/issue-2949-s5-2-eq.test.ts` and `s5-p-claim-flip` (`isModifier`)
for A4 — so re-grounding here removes a *duplicate, rotted* pin, not the
only coverage.

**A3 — lateral bucket refinement, not laundering.** `x()` on a dyn param is
now declined by the phase-1 call-target scan (`knownCallableArity` cannot
resolve a parameter as a callee) before the move-only scan is consulted.
`scripts/gen-ir-adoption.mjs` classifies **both** the old
`param-type-not-resolvable` and the new `call-resolution-unsupported` as
**unintended** — so the rejection did not move into a deferred/wont-fix
bucket, which is the only move that would have hidden a producer gap. The
new bucket names the actual gap (call resolution), the old one did not.

**A5 — the one that needed a filed issue.** `git bisect` over
`c97b8511e..HEAD` (14 steps; probe = `irPostClaimErrors.length === 0` on
`export function count(xs: any[]): number { return xs.length; }` with
`{fast:true}`) names the first bad commit as **`7ecb4ee3a`
`fix(#3536): standalone declared-fn object-literal arguments cross the call
boundary intact`**, which extended the patch-time typeIdx-parity guard from
class-member/module-init units to **top-level FunctionDeclarations**, with a
*soft* `abi-signature-parity` withdrawal.

The guard did not create a defect. Measured at `a017055f4` (the last
pre-#3536 commit):

| lane        | header (pre-#3536)                                | post-claim |
| ----------- | -------------------------------------------------- | ---------- |
| IR fast     | `(func $count (param (ref null 2)) (result f64)`   | `[]`       |
| legacy fast | `(func $count (param (ref null 36)) (result i32)`  | `[]`       |
| IR host     | `(func $count (param (ref null 2)) (result f64)`   | `[]`       |
| legacy host | `(func $count (param (ref null 2)) (result f64)`   | `[]`       |

i.e. the IR was **shipping** a fast-mode signature that disagreed with legacy
on both the vec type and the result type, and reporting zero demotions while
doing it. #2949's own slice-3b notes recorded the divergence in prose
("PRE-EXISTING on main, probe-verified side-by-side") but asserted zero
demotions anyway, because at the time it cost nothing. #3536 made it cost a
withdrawal. Filed as **#4615**; the slice-3b test now pins the guard's
safety property with a pointer to it, written so that fixing #4615 turns the
pin red and forces it back to a zero-demotion assertion.

## What changed

- `tests/issue-2949-slice2-dynamic-producers.test.ts` — the bucket-string
  table becomes an **outcome-class** table (`claim` / `reject`). `claim`
  ⇒ claimed pre-build **and** `irPostClaimErrors == []` **and** the function
  present in `irCompiledFuncs`. `reject` ⇒ not claimed, a pre-claim fallback
  reason **recorded**, that reason **not** in a new `DEFERRED_BUCKETS` set,
  and the legacy compile clean. The forbidden middle — claim-then-demote —
  is what the section defends; bucket names may keep moving, that shape may
  not. The still-separate "destructured dynamic param" case folds into the
  same table.
- `tests/issue-2949-slice3b-any-dynamic.test.ts` — the `===`-on-any
  assertion is re-grounded onto the claim-then-demote *channel*, asserted
  over both sides of the family (the now-claiming `===` shape plus two that
  still decline pre-claim: `a()` and `new a()`). The `any[]` case splits into
  a host-lane test (unchanged semantics, plus `irCompiledFuncs` now asserted)
  and a fast-lane test that pins the #4615 gap explicitly.
- `plan/issues/4615-fast-any-array-param-abi-parity-withdrawal.md` — new.

## Results

- All **15** `tests/issue-2949-*` suites green on this base: **121 tests, 0
  failures** (50 in the first batch of 8 files, 71 in the second batch of 7).
  Before: 5 failures across the two suites named above.
- No `src/` change — the diff is tests plus two plan files, so no other suite
  can be affected by it.

## Acceptance criteria

- [x] All #2949 suites green on main.
- [x] Per-assertion verdict table recorded here (evolved vs regression).
- [x] Assertions re-grounded on invariants, not fresh literals, wherever
      the bucket move was legitimate evolution.
