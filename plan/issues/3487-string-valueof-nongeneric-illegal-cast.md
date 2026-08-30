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
updated: 2026-08-27
assignee: ttraenkler/codex-es6-string-valueof
related: [1917, 3189, 3335, 3524]
blocked_on: "host-only builtin-prototype closure carrier/receiver ABI; standalone row is already passing"
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

## Current-main checkpoint — 2026-08-27 (standalone complete; host residual)

The maintained original-harness runner was rerun from `c821dab8e`
(`codex/3487-string-valueof`) with the pinned QuickJS/LLVM18 toolchain and a
fresh isolated process for the row. The exact one-row results are:

| Row | Host | `--target standalone` |
|---|---|---|
| `test/built-ins/String/prototype/valueOf/non-generic.js` | `fail`, `RuntimeError: illegal cast in __cb_15()` via `__closure_46 ← __call_fn_method_3`, assertion source L21 | `pass` |

The raw one-row records are retained at
`/private/tmp/js2-3487-before-host.jsonl` and
`/private/tmp/js2-3487-before-standalone.jsonl`.

The host row used the maintained isolated-row command (with
`TASK_NODE=/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`
and
`TASK_BIN=/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback`)
`PATH="$TASK_NODE/..:$TASK_BIN:$PATH" "$TASK_NODE" --import tsx
scripts/run-test262-paths.mts --isolate .tmp/3487-row.txt`; the standalone row
and all controls used the same `tests/test262-runner.ts` entry point via
`runTest262File(absolutePath, category, 30000, "standalone")` (or an omitted
fourth argument for host). The temporary row/control inputs were deleted after
the measurement; the raw row records and signatures above are the retained
evidence.

The four controls were run separately through `runTest262File` in both lanes
(absolute fixture paths, timeout 30s). Their exact current outcomes are:

| Control | Host | `--target standalone` |
|---|---|---|
| `{ valueOf: () => "hello" }` → string | `pass` (`8c530cf17a05`) | `pass` (`e0ee3d48d08b`) |
| `{ valueOf: () => 42 }` → number | `pass` (`9445c6723144`) | `pass` (`9be69ae5af16`) |
| `{ valueOf: String.prototype.valueOf }` | `fail`, same `illegal_cast` family (`__cb_1 ← __closure_45 ← __call_fn_method_3`) (`df123c52f42f`) | `pass` (`177d55187fee`) |
| `String.prototype.valueOf.call(true)` | `pass` (`62893a3ed7a7`) | `pass` (`aadeddfc5ac6`) |

This reclassifies the open work precisely: standalone has no remaining #3487
row or control failure at current main; the residual is host-only. The ABI
trace is unchanged from the July proof: reflective `String.prototype.valueOf`
is carried through `__get_builtin`/`__extern_get`, stored as an eqref closure,
and then invoked by generic ToPrimitive through `__call_fn_method_3`. A user
closure takes the ordinary closure ABI, and direct `.call` reaches the existing
catchable builtin receiver-check path. The field-stored builtin instead reaches
`__cb_15` with the raw object receiver and its String-wrapper `ref.cast`, which
is the uncatchable `illegal_cast`. Standalone's native ToPrimitive path already
handles this shape and passes; no host-only receiver/closure ABI change is safe
to claim from this standalone task.

**No-gain proof / handoff:** no compiler or runtime source change was made in
this checkpoint. The standalone baseline is already `1/1`, while the only
remaining failure is the host field-stored-builtin case. The earlier narrow
static-ToPrimitive reduction experiment is retained above as a measured no-gain
proof: removing that reduction leaves the same trap on the dynamic
`__call_fn_method_3` path. The temporary control probes were removed after the
measurement. Reopen this issue only with an architect-approved host
builtin-prototype carrier/receiver ABI fix; keep #5052 draft until that
host-lane acceptance is independently satisfied.

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

## Resume implementation plan — 2026-08-27

The July root-cause proof remains the starting hypothesis, but the compiler's
closure-value, dynamic-call, ToPrimitive, and standalone exception machinery
has changed substantially since that measurement. Reopen the one-row cluster
for a bounded verify-first implementation rather than carrying the old
substrate block forward untested.

1. Run `built-ins/String/prototype/valueOf/non-generic.js` alone in standalone
   and host modes through the maintained original-harness runner. Separately
   run the four recorded controls and capture exact status, error category,
   signature, trap/catch behavior, and emitted call path on current main.
2. Trace the field-stored `String.prototype.valueOf` carrier from reflective
   property read through object-field storage and dynamic ToPrimitive dispatch.
   Compare its receiver/argument ABI with the already-correct direct `.call`
   path and a user-defined `valueOf` closure; identify the first representation
   or dispatch divergence before editing shared coercion machinery.
3. Implement the narrow shared fix at that divergence: preserve a callable
   builtin method value and route a non-matching receiver to the existing
   catchable `TypeError` path. Do not mask a raw `ref.cast` trap in the runner,
   special-case this fixture, or weaken receiver-brand semantics.
4. Add focused host/standalone controls for the direct `.call`, field-stored
   builtin, user closure string/number results, valid String receiver, null and
   ordinary-object receivers, and one neighboring `toString`/ToPrimitive case
   that proves the fix does not steal #3524's distinct semantics.
5. Rerun the exact row and controls in both lanes, the relevant ToPrimitive and
   String prototype regression suites, trap-category comparison, mandatory
   gates, and same-base pass/non-pass diff. Record artifacts, counts, residuals,
   commit SHA, and handoff in this issue.

The PR must use the repository Description/CLA template and remain draft until
the scoped row and controls are 100% passing in both lanes, no trap or pass
regression is introduced, current-main reconciliation is complete, and CI is
green and mergeable.

## Context / incident

Landing-page freeze root-caused to this trap-growth gate refusal (NOT the
summary-sync, which was healthy). A low-velocity freeze (~4–6 merges) stayed
under the 25-commit `baseline-floor-staleness-alert` threshold, so it went
unnoticed for hours — see the companion observability change (loud ntfy at the
trap-gate refusal point) that surfaces a future occurrence within one push.
