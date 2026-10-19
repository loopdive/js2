---
id: 7003
title: "ir: `closure.call` trusts the TS callable annotation as the exact Wasm func type — `apply(f: (x: number) => number)` called with `function h(x: number, y: number = 5)` / `(x, y?) => …` (legal TS assignments) hits `ref.cast` → `RuntimeError: illegal cast`; legacy is correct; verify skips `closure.call`"
status: done
completed: 2026-10-18
sprint: current
created: 2026-10-15
updated: 2026-10-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
language_feature: closures, function-types, arity
goal: ir-full-coverage
related: [7000, 7001]
loc-budget-allow:
  # 2026-10-18 (impl): +13 lines — the `closure-signature-mismatch` refusal in
  # the parameter loop and the selector-owned hooks object; the scan itself
  # lives in the new src/ir/closure-signature-flow.ts.
  - src/ir/select.ts
func-budget-allow:
  # 2026-10-18 (impl): +3 lines — the refusal sits beside the existing
  # function-typed-parameter arm of the parameter loop.
  - src/ir/select.ts::whyNotIrClaimable
---

# IR closure call casts to the annotation's func type

Reported by the 2026-10-15 audit (IR typing lane, CONFIRMED on gc with IR on; on standalone `apply` is not claimed today). Not re-run by the lead — reproduce first.

## Repro (node → wasm, gc, IR on)

```ts
function apply(f: (x: number) => number): number { return f(1); }
function h(x: number, y: number = 5): number { return x + y; }
export function test(): number { return apply(h); }   // node 6, IR RuntimeError: illegal cast, legacy 6
```
Also `h2(x: number, y?: number)` and an inline `(x, y?) => …`.

## Root cause

- `src/ir/lower-generic.ts:2038-2084`: `closure.call` extracts the funcref and `emitDowncast({ typeIdx: cl.funcTypeIdx })` (`ref.cast`) before `call_ref`, where `funcTypeIdx` is derived from the TS callable annotation. A callee with a different Wasm arity/signature is a legal TS assignment but a different func type.
- `src/ir/runtime/verify.ts:1879` skips `closure.call` as resolver-typed.

## Implementation Plan

1. Make the selector refuse the claim when a closure-typed parameter can receive a function whose Wasm signature differs from the annotation: at the call sites that pass a function value into a closure-typed slot (`apply(h)`), compare `h`'s lowered signature with the slot's; if they differ, reject with a typed reason (`closure-signature-mismatch`) — demote is correct and cheap.
2. Longer term (note, don't build here unless small): the legacy lane handles this via its uniform closure calling convention (grep `closures.ts` for the arity-adapting thunk); the IR should use the same convention or emit adapter thunks at the `apply(h)` site.
3. Tests: the three repros through an IR-claimed `apply`, asserting both correctness and (via `irOutcomes`) that the function demoted or lowered correctly.

## Acceptance

- Repros match node on gc and standalone with IR on; no `illegal cast` traps.

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-7003-ir-closure-call-exact-func-type-cast.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.

## Implementation notes (2026-10-18)

**Reproduced on `origin/main` 2cc1516657** (gc lane, IR on): `apply` is
IR-emitted and all three repros trap `RuntimeError: illegal cast` (node: 6).
On standalone `apply` was not claimed (`call-graph-closure`), so the IR was
never involved there.

**Fix (plan step 1).** New typed selector reason `closure-signature-mismatch`,
returned from the parameter loop of `whyNotIrClaimable` when a function-typed
parameter may receive a function of another Wasm signature. The scan is
`src/ir/closure-signature-flow.ts` (pure TS-AST, conservative): a slot is
*exactly fed* only when every reference to its owner (function, method by
`.name`, constructor via `new`) is a direct call and every argument in that
position is a same-signature top-level function declaration, an arrow/function
expression whose arity and annotations match, a `const` bound to one, or a
same-signature callable parameter that is itself exactly fed (transitive, so
`outer(h)` → `inner(f)` refuses both). Anything else — a `let`, a property
read, a call result, a value reference to the owner (`const a = apply`), a
spread before the slot — counts as "may differ". Arrow results: a
value-returning literal in a `void` slot and a value-less block in a valued
slot are foreign.

After the fix all three repros return 6 on gc (`apply` refused, legacy body).
Extra shapes pinned in `tests/equivalence/issue-7003-ir-closure-call-signature.test.ts`:
one-parameter function in a two-parameter slot (was `illegal cast`, now 10),
value-returning function in a `void` slot (was `illegal cast`, now 2), and a
mismatch forwarded through a same-signature callable parameter. Negative
control: an exactly-fed `apply` (`h`, a `const` arrow, an inline `(x) => …`)
stays `emitted`.

**Measured:** 0 refusals across `tests/equivalence` (232 files, logged via a
temporary hook, removed before commit) and 0 on the `check:ir-fallbacks`
playground corpus; equivalence gate green (22 failing = the 22 known
failures). A/B of the closure/class IR unit tests (`tests/issue-3214-*`,
`tests/issue-3522-*`, `tests/issue-1169o`): the same 37 failures with and
without the change (pre-existing on main); one extra timing failure
(`does not grow the optimized binary`, 35 s under load) passed on re-run.

**Not covered (known limits).** A method invoked through an element access
(`obj["m"](h)`, `obj[k](h)`) is not attributed to its slot. An exported
function's callable parameter filled by the JS host is not considered (a host
function is not a closure struct at all — a separate, pre-existing gap). There
is no builder-side backstop: the builder has no call-site view.

**Acceptance gap — standalone, legacy path (not fixed here, frozen).** With
`apply` now legacy on both lanes, three standalone combinations still differ
from node because the standalone LEGACY closure call has no fallback when the
closure's arity exceeds the call's: the default-parameter repro, the inline
`(x, y?) => …` repro and the forwarded mismatch throw a `WebAssembly.Exception`
(they did before this change too; IR was never involved on standalone). They
are `it.fails` in the test file so they flip loudly when fixed. Fixing them
needs plan step 2 on the IR side (an arity-adapting `closure.call` or adapter
thunks at the call site, then claiming `apply` on standalone) — a follow-up
issue, not this one.

Also noticed (legacy, gc): `apply((x: number, y?: number) => x + (y ?? 5))`
and the `y === undefined ? 5 : y` form return NaN instead of 6 — an
*annotated* optional parameter of an arrow called with fewer arguments reads
as NaN, not `undefined`. The unannotated `(x, y?)` form is correct. Same with
IR off; legacy direct-AST path, so recorded only.

**Step 2 (note).** Legacy's convention is visible in the WAT of the repro: the
call site in `apply` reads the closure's `func` field and `ref.test`s it
against each registered wrapper func type (arity 1, 2, … with result
adapters), falling back to a host `__call_fn_N` on gc. An IR equivalent would
be a `closure.call` lowering that dispatches on the wrapper's `$arity` field
(or `ref.test` per known signature) and pads missing arguments with the
`undefined` sentinel of each parameter type. **verify.ts** still skips
`closure.call` (`resolver-typed`); with the selector refusal in place a check
there could only compare the annotation with itself, so it was left alone.

