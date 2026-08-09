---
id: 3487
title: "String.prototype.valueOf non-generic receiver traps illegal_cast (uncatchable) instead of throwing catchable TypeError"
status: blocked
sprint: Backlog
priority: high
horizon: l
feasibility: hard
task_type: bug
area: test262-conformance
goal: test262-conformance
created: 2026-07-20
blocked_on: closure-value substrate (builtin proto-method stored as an object field, invoked via the generic ToPrimitive `+`/eqref-closure dispatch); needs architect spec — see "Verified root cause (2026-07-21)"
---

## Problem

`test/built-ins/String/prototype/valueOf/non-generic.js` compiles to an
**uncatchable `illegal_cast` trap** on its receiver check, where the spec
requires `String.prototype.valueOf.call(nonString)` to throw a **catchable
`TypeError`**. This raised the main-side #3189 uncatchable-trap ratchet
`illegal_cast` category from **79 → 80**, which the #3335 trap-growth gate in
the baseline promoters (`write-run-cache-bot` / `promote-baseline` in
`test262-sharded.yml`, and `refresh-baseline.yml`) correctly REFUSED to bake in
— hard-failing every push:main baseline promote and **freezing the landing-page
test262 number for ~7h** (2026-07-19 18:21 → 07-20, stuck at 28294/43106 while
the real number had advanced to 28875/43106).

The freeze was cleared operationally by a one-cycle
`BASELINE_TRAP_GROWTH_ALLOW=1` re-anchor (the ratchet base moved to
illegal_cast=80, then the variable was reset to 0). **That override is a
TEMPORARY acknowledgment, NOT permanent acceptance.** This issue tracks fixing
the regression so the ratchet returns to **79** and the default `0` tolerance
stays strict.

## Evidence

Trap-gate log (push run 29713237555, head d0cc9028e, job `write-run-cache-bot` step 9):
```
[trap-growth] previous:  null_deref=166 illegal_cast=79 oob=49 unreachable=55
[trap-growth] candidate: null_deref=166 illegal_cast=80 oob=49 unreachable=55 (tolerance 0)
##[error]trap category "illegal_cast" grew 79 → 80 (+1) — Newly trapping: test/built-ins/String/prototype/valueOf/non-generic.js
```
Scope is exactly **+1, one test** — no other trap category moved, and it stayed
+1 across the whole host-restore wave (verified at the latest test-bearing tip
d0cc9028e).

Historically this test was `compile_error`/`fail` (never passing — months of
local baseline history), so this is a **failure-mode regression (fail/CE →
uncatchable trap), not a pass→fail loss** — but an uncatchable trap is strictly
worse for standalone (it aborts the module) and trips the #3189 ratchet.

> **Superseded hypothesis (2026-07-19):** the original guess — "the receiver
> lowering does a `ref.cast` of `this` to the String struct type; route that
> cast-failure to a TypeError throw" — is **wrong** and was empirically
> disproven. See "Verified root cause (2026-07-21)" below. All seven direct
> `valueOf.call(nonString)` assertions already throw a catchable TypeError
> correctly; the trap comes from the test's **last** assertion, a ToPrimitive
> `+` on an object whose `valueOf` field holds the builtin proto method.

## Verified root cause (2026-07-21, senior-dev; executable spec)

Pinned by local host-lane probes against current `main` (9c6a1f2c). The trap is
**not** in `String.prototype.valueOf`'s receiver check — it is in how a
**builtin proto method stored as an object field value** is invoked through the
generic ToPrimitive `+` / eqref-closure dispatch.

**What actually fails in `valueOf/non-generic.js`.** All seven direct
`valueOf.call(nonString)` assertions (`true`, `-0`, `null`, no-arg, `Symbol`,
`{toString}`, `['s','t','r']`) **already throw a catchable TypeError** — verified
individually, each returns caught=`TypeError`. The single failing line is the
tail:

```js
assert.throws(TypeError, function() { 'str' + {valueOf: valueOf}; });
```

`'str' + {valueOf: String.prototype.valueOf}` → uncatchable `RuntimeError:
illegal cast` (trace `illegal cast [in __cb_15() ← __closure_34 ←
__call_fn_method_3 ← __module_init]`). That one trap fails the file **and** trips
the #3189 ratchet 79→80.

**Controls that localize it (this is the decisive evidence).**

| Snippet | Result |
|---|---|
| `'str' + {valueOf: () => 'hello'}` | `"strhello"` ✅ (user closure, string result) |
| `'str' + {valueOf: () => 42}` | `"str42"` ✅ (user closure, number result) |
| `'str' + {valueOf: String.prototype.valueOf}` | **illegal_cast trap** ❌ |
| `valueOf.call(nonString)` (direct `.call`) | catchable `TypeError` ✅ |

So **user-defined** valueOf closures flow through `+`/ToPrimitive correctly. The
trap fires **only** when the field holds a reflective **builtin proto method**
(`String.prototype.valueOf`). The identical builtin throws a catchable TypeError
via direct `.call` but `ref.cast`-traps when the ToPrimitive dispatch invokes it.

**Why the obvious guard does NOT work.** Narrowing the over-eager static
ToPrimitive reduction — dropping the untracked closure-ref fallback in
`structHasStaticNumericToPrimitive` (`src/codegen/binary-ops.ts` ~L1937-1939),
which fires because `{valueOf: String.prototype.valueOf}` is **untracked**
(a reflective proto read emits no `struct.new` closure, so `valueOfClosureTypes`
is never populated for it) — was tried and the trap **persisted**: the operand
then flows to the **dynamic** `__to_primitive` eqref-closure dispatch, which
traps the same way. The bug is in the dispatch/closure-value path, not the
static-reduction trigger.

**Root cause (substrate).** A builtin proto method read reflectively
(`String.prototype.valueOf` / `toString`) and stored as an object field is a
closure value whose ABI/receiver handling differs from a user closure. When the
generic ToPrimitive `+` (and `.concat`) dispatch does `call_ref` on that field,
the receiver reaches the builtin body as a non-externref ref that gets
`ref.cast`-ed → uncatchable trap, instead of the catchable-TypeError path the
direct `.call` machinery takes. This is the **closure-value / builtin-proto-
method-as-first-class-value** substrate (host-fail triage cluster #5 family),
not a localized codegen guard.

## Fix approach (for the architect)

Make the generic ToPrimitive/eqref-closure dispatch handle a field-stored
builtin proto method the same way direct `.call` does. Two candidate directions
(architect to choose / spec exactly):

1. **Box the receiver to externref before `call_ref`** in the ToPrimitive
   eqref-closure dispatch, so the builtin body's `RequireObjectCoercible`/brand
   check runs (which already produces a catchable TypeError), instead of the
   receiver reaching the body as a raw struct ref that `ref.cast`-traps.
2. **Route a non-matching receiver to a catchable TypeError at the dispatch
   site** (a `ref.test` + throw, not a bare `ref.cast`).

Both must hold in **host and standalone** lanes (the ratchet is the standalone
uncatchable-trap metric). Verify with the four control snippets above plus the
two test262 files; watch the #1917 coercion-engine byte-diff neutrality gate
(the fix should be byte-neutral by construction — it only changes a shape that
currently traps).

## Flip value

- `valueOf/non-generic.js`: **+1** host file (this issue's acceptance).
- `toString/non-generic.js`: **+1** more with the follow-up **#3524** (toString
  also needs the non-generic `thisStringValue` check — its first assertion
  `toString.call(nonString)` returns a generic ToString instead of throwing —
  AND shares this exact concat-tail trap via `''.concat({toString: toString})`).
- Returns the `illegal_cast` ratchet **80→79** and removes a standalone
  module-abort.

## Acceptance

- The ToPrimitive `+`/`.concat` dispatch invoking a field-stored builtin proto
  method (`String.prototype.valueOf`) on a non-String receiver throws a
  **catchable TypeError** (not an `illegal_cast` trap) in both host and
  standalone lanes. Verified by all four control snippets above.
- `test/built-ins/String/prototype/valueOf/non-generic.js` passes in the host
  lane.
- Baseline `illegal_cast` category returns to **79** (or lower) on the next
  promote, and the repo Actions variable `BASELINE_TRAP_GROWTH_ALLOW` stays at
  the default `0`.

## Context / incident

Landing-page freeze root-caused to this trap-growth gate refusal (NOT the
summary-sync, which was healthy). A low-velocity freeze (~4–6 merges) stayed
under the 25-commit `baseline-floor-staleness-alert` threshold, so it went
unnoticed for hours — see the companion observability change (loud ntfy at the
trap-gate refusal point) that surfaces a future occurrence within one push.
