---
id: 6982
title: "Native regime in a JS environment: Symbol.toPrimitive, indexOf(undefined), await-settled yield, import.meta.url"
status: in-progress
sprint: current
created: 2026-10-14
updated: 2026-10-14
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
goal: architecture
parent: 5385
related: [6708, 6979]
assignee: ttraenkler/opus-6982-values
---

# Native regime in a JS environment: four value-semantics defects

Slice A of #6708 flips the default `semanticProviders` to `native-first`. In a
JavaScript environment (exports read through `wrapCompiledExports`), the
equivalence gate goes red on these 8 rows, all reproducible on main with an
explicit `{ semanticProviders: "native-first" }`:

| File | Row | Symptom |
| --- | --- | --- |
| symbol-toPrimitive | arithmetic | `a + b` on `[Symbol.toPrimitive]` instances → NaN |
| symbol-toPrimitive | comparison operators | `a > b` → false |
| array-indexof-no-arg | finds an element that IS undefined | `indexOf(undefined)` → -1 |
| array-indexof-no-arg | finds the LAST element that is undefined | `lastIndexOf(undefined)` → -1 |
| await-settled-operand-yields | `await null` in an async arrow returns to the caller first | runs synchronously |
| await-settled-operand-yields | sibling async functions interleave like JS | no interleave |
| import-meta | import.meta.url reflects the loader-injected value | not a string |
| import-meta | import.meta.url stored in a variable | null |

## Acceptance criteria

- All 8 rows pass under `native-first` in a JS environment.
- Standalone output unchanged or improved.
- `tests/issue-6982-regime-value-semantics.test.ts` covers each construct under
  both `native-first` (JS environment) and `target: "standalone"`.
