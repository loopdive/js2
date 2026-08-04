---
id: 4148
title: "Host lane: `typeof` a bare builtin identifier through a parameter answers \"object\" — 31 rows, a different mechanism from the standalone carrier brand"
status: ready
sprint: current
created: 2026-08-04
updated: 2026-08-04
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: core-semantics
related: [4120, 4119, 3571]
---

# Host lane: `typeof` a bare builtin identifier through a parameter answers `"object"`

Split out of **#4120** on 2026-08-04, at that issue's own request: *"the honest
scoped host bucket is 31, not 43, and it needs its own issue."* The analysis
below is #4120's, not re-derived — see its `## Host-arm triage (the 43)` section
(landed on `main`; PR **#4090** is the standalone counterpart,
`fix(#4120): typeof of a reified builtin constructor answers "function"`,
merged 2026-08-03).

## The bucket is 31, not 43 — the split is load-bearing

#4120 measured **43** failing official tests in the default/host lane
(denominator 43,488 official host files) under the signature
`typeof <builtin> !== "function"`. Probing the named builtin's existence in the
JS host itself split them:

- **12 of 43 — out of scope.** The builtin does not exist in the JS host either,
  so `typeof undefined !== "function"` is the **correct** answer and the row
  fails for a legitimate missing-builtin reason:
  `ArrayBuffer.prototype.{sliceToImmutable,transferToImmutable}`,
  `Iterator.prototype.join`, `Map.prototype.{getOrInsert,getOrInsertComputed}`,
  `WeakMap.prototype.{getOrInsert,getOrInsertComputed}`, `Math.sumPrecise`,
  `Promise.{allKeyed,allSettledKeyed}`, `Error.prototype.stack` getter+setter.
- **31 of 43 — this issue.** A real gap, and a **different mechanism** from the
  one #4120 fixed.

Quoting 43 for this fix overstates it by ~39 %. #4120's file states the rule
directly: *"Do not treat the host 43 as one bucket."*

## Mechanism — a bare-identifier value read, not a carrier brand

Measured host-mode `typeof` through a **one-parameter indirection**:

| identifier | host `typeof` |
| --- | --- |
| `Set` | `"function"` ✓ |
| `Array` | `"function"` ✓ |
| `AggregateError` | `"object"` ✗ |
| `BigInt` | `"object"` ✗ |
| `WeakRef` | `"object"` ✗ |
| `escape` | `"object"` ✗ |
| `eval` | `"object"` ✗ |
| `parseInt` | `"object"` ✗ |

`Set`/`Array` are the controls that matter: some bare builtin identifiers **do**
read back as callable in the host lane, so this is not "the host lane has no
builtin identity" — it is a per-identifier value-read gap.

**The #4120 fix cannot touch it.** That brand is applied at
`pushBuiltinCtorOwnPropSeed` and is **`ctx.standalone`-gated**; #4120 states the
host emit is **byte-identical** before and after, and made no host-side change.
So this needs its own mechanism, not a widening of the gate — widening it
blindly would change host emit that is currently correct for `Set`/`Array`.

## Why the indirection is mandatory in any probe

`typeof <Builtin>` written in place is **constant-folded** and never touches the
value carrier — it will answer `"function"` regardless of whether the underlying
read is broken. #4120 records this trap explicitly and asserts the in-place
spelling only as a CONTROL that must keep working. Any probe or test for this
issue must route the identifier through a parameter hop, or it measures the
static path and reports success that is not there. See
[[reference_constant_folded_probe_tests_the_static_path]].

## Relationship to the neighbouring buckets — do not merge them

- **#4120 / PR #4090** — reified builtin **constructor** carriers, standalone
  lane. Landed. This issue is its host-lane counterpart *in symptom only*; the
  mechanism differs.
- **#4119 / #3571** — `typeof Array.prototype.map` answers `"undefined"`
  because the **member read** does not resolve (69 prototype methods, #4120's
  "mode 1"). #4119 additionally measured that `Array.prototype.slice` — whose
  member body **is** implemented — still answers `"undefined"`, so implementing
  a member body does not by itself produce a callable value. Different defect,
  different lane, already owned.

## Acceptance

- [ ] Host-lane `typeof` **through a parameter hop** answers `"function"` for
      `AggregateError`, `BigInt`, `WeakRef`, `escape`, `eval`, `parseInt`.
- [ ] `Set` and `Array` — the identifiers that already answer correctly —
      still answer `"function"`. They are the regression control; a fix that
      makes the six work by changing how all bare builtin identifiers read must
      prove it did not disturb these.
- [ ] Every assertion routes through a parameter; the in-place spelling appears
      only as a control (it is constant-folded — see above).
- [ ] Report flips against the **31**-row scoped population with its
      denominator (43,488 official host files), and state explicitly that the
      12 missing-builtin rows are excluded and why.
- [ ] Standalone emit is unchanged, or any change is measured on the standalone
      lane too — #4120's brand is `ctx.standalone`-gated and correct today.

## Reproduction

```bash
node scripts/fetch-baseline-jsonl.mjs --force
# filter test262-current.jsonl (HOST lane) on scope_official && status != pass
#   signature: typeof <builtin> !== "function"   -> 43
#   minus the 12 not-in-host-either rows listed above -> 31
```
