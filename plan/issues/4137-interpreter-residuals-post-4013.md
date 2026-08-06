---
id: 4137
title: "standalone interpreter residuals after #4013: `SyntaxError: NaN` (36), a null-deref in setEvalVariableEnvironmentBinding (16), Phase-1 emitter gaps (22)"
status: ready
sprint: current
created: 2026-08-03
updated: 2026-08-03
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: eval
goal: standalone-mode
related: [1781, 2928, 2929, 4013, 4131]
origin: "2026-08-03 delta /harvest-errors, baselines 2090e7bfd342 (gitHash b65d2f5a, 13:19Z standalone); oracle v12/honest"
---

# #4137 — the residual tail of the newly-linked standalone interpreter

## TL;DR

PR #4013 made CI's standalone shards link the **real** runtime-eval provider
(previously the refusal provider), which retired the entire
`dynamic code evaluation is not supported` / `dynamic eval is not supported in
standalone mode` refusal family — **559 records → 0** — and turned **343 of
those 559 into passes**. Of the 216 that still fail, three signatures are
**new**, produced by the interpreter itself rather than by the code under test.
They total **74 records** and did not exist at any earlier baseline.

| signature | records | category |
| --- | ---: | --- |
| `SyntaxError: NaN` | 36 (24 annexB, 12 standard) | `syntax_error` |
| `dereferencing a null pointer [in setEvalVariableEnvironmentBinding() ← callBuiltin ← run ← interpEnter]` | 16 | `null_deref` |
| `Error: interp/emitter: unsupported in Phase 1: …` | 22 | `other` |

**Prior art — read before starting.** Two of the three are already recorded
somewhere; this issue exists to give them a **published-baseline count** and an
owner, not to claim discovery:

- `SyntaxError: NaN` is recorded in **#2928** (line ~593) as an
  "error-message rendering defect in the thrown path", measured at **8** files in
  a local interpreter run. It is **36** in the published CI lane now that #4013
  links the real provider.
- The null-deref arm overlaps **#4131**'s recorded residual and **open PR #4077**
  (`codex/2929-annexb-init-update`, "five `existing-var-update` files became null
  dereferences"). **The frame differs**: #4131/#4077 cite
  `dereferencing a null pointer in __module_init()`, these 16 cite
  `setEvalVariableEnvironmentBinding() ← callBuiltin ← run ← interpEnter`.
  Confirm whether #4077 closes them before doing any work here.

## 1. `SyntaxError: NaN` — 36 records

The message is the *number* `NaN`, not a diagnostic. Whatever formats this error
is interpolating an unresolved position/offset instead of a message. Two things
are wrong and they are separable:

- **The text is unusable.** No test, triager or bucketing script can act on it,
  and it collapses 36 distinct causes into one opaque bucket.
- **It is thrown on `skip-early-err` tests**, i.e. tests whose whole point is
  that an early error must *not* be raised at that point. Samples:
  - `test/annexB/language/eval-code/indirect/global-if-decl-else-stmt-eval-global-skip-early-err-try.js`
  - `test/annexB/language/eval-code/direct/func-if-decl-else-decl-a-eval-func-skip-early-err-try.js`
  - `test/language/expressions/class/elements/arrow-body-derived-cls-direct-eval-contains-superproperty-1.js`

Fix the message first — the second half cannot be diagnosed while the diagnostic
is `NaN`.

## 2. Null-deref in `setEvalVariableEnvironmentBinding()` — 16 records

A hard crash inside the interpreter's var-environment binding path, all on
annexB eval-code:

- `test/annexB/language/eval-code/direct/global-if-decl-else-decl-b-eval-global-init.js`

This overlaps the residuals already recorded on **#4131** (annexB
existing-var-update). #4131 is merged; confirm whether this crash is one of its
two recorded residuals or a third, distinct one before starting.

## 3. `interp/emitter: unsupported in Phase 1` — 22 records

Honest refusals, listed for the Phase-2 scope of #2928:

| unsupported construct | records |
| --- | ---: |
| regex literal | 13 |
| class method key `PrivateIdentifier` | 4 |
| class element `PropertyDefinition` | 3 |
| expression `TaggedTemplateExpression` | 1 |
| binary operator `\|` | 1 |

`binary operator '|'` is the odd one out — a single missing bitwise op in an
otherwise-complete expression emitter is a one-line gap, not a phase boundary.

## Context: what the interpreter bought

Disposition of the 559 previously-refused records at the new baseline:

| | records |
| --- | ---: |
| now `pass` | 343 (61.4 %) |
| still failing | 216 (38.6 %) |

Restricted to the **ES5+untagged goal scope** (8,648 files, `scope_official` ∧
(`es5id` ∨ no edition id), intersected across both lanes): the dynamic-code
exclusion set was **147** files, of which **74 now pass and 73 still fail**.

## Acceptance criteria

- [ ] `SyntaxError: NaN` never reaches a test result — the interpreter's
      SyntaxError carries a real message and position.
- [ ] The `setEvalVariableEnvironmentBinding` null-deref is either fixed or
      confirmed as a recorded #4131 residual and closed against it.
- [ ] Each `interp/emitter` Phase-1 gap is either implemented or listed in
      #2928's Phase-2 scope with a count.
- [ ] Re-measured against a promotion later than `b65d2f5a`, with counts.
