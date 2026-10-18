---
id: 7003
title: "ir: `closure.call` trusts the TS callable annotation as the exact Wasm func type — `apply(f: (x: number) => number)` called with `function h(x: number, y: number = 5)` / `(x, y?) => …` (legal TS assignments) hits `ref.cast` → `RuntimeError: illegal cast`; legacy is correct; verify skips `closure.call`"
status: in-progress
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
  # 2026-10-18 (impl): +16 lines — the `closure-signature-mismatch` refusal in
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
