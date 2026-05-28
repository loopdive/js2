---
id: 820n
title: "#820 umbrella status 2026-05-28: residual 868 fails (down from 1318), recommendation to close umbrella post-#820l/#820m"
status: ready
created: 2026-05-28
updated: 2026-05-28
priority: low
feasibility: trivial
reasoning_effort: low
task_type: chore
area: docs
language_feature: meta
goal: planning
sprint: Backlog
parent: 820
---
# #820n — #820 umbrella status 2026-05-28

Triage update (dev-1655-2, 2026-05-28) on the #820 nullish-TypeError /
illegal-cast umbrella, baseline `.test262-cache/test262-current.jsonl` from
2026-05-25 (3 days post-sprint-53 close).

## Current bucket size

| `error_category` | Count |
|------------------|------:|
| `type_error`     | 397 |
| `null_deref`     | 274 |
| `illegal_cast`   | 197 |
| **umbrella total** | **868** |

Down from 1318 (senior-dev 2026-05-21 re-analysis) — a **−450 reduction**
over the sprint-53 wave (#820a, #820b, #820d, #820h, #820j, #820k, #1542,
#1543, #1544, #1568, #779e, #1129, #1525, #1607, #1638, etc).

## New sub-issues carved by this triage

| Sub-issue | Title | Est fails | Status |
|-----------|-------|-----------|--------|
| **#820l** | `arguments` extra-positional args not retained | ~61 | ready |
| **#820m** | NamedEvaluation `fn-name-class` + `__proto__` exclusion | ~12 | ready |

Combined addressable: ~73 fails (~8.4% of current umbrella).

## What remains in the umbrella (not yet ticketed)

After #820l + #820m, the residual fails decompose roughly as:

| Cluster | Count | Disposition |
|---------|------:|-------------|
| dstr-binding `ary-ptrn-elem-id-init-fn-name-class` family (procedurally generated, null_deref) | ~33 | Re-route to #1542 / #1544 dstr-default residual follow-ups; NOT a localized fix |
| `language/statements/for-of/dstr/array-*-iter-close` family | ~27 | Overlaps **#1610** (for-of over non-array iterables, in-progress) + **#1633** (Array.from iterator bridge, ESCALATED). Not a localized fix |
| `language/statements/for-await-of/*-dstr-*` | ~21 | Overlaps **#1347b** (for-await-of async iterator, in-progress). Not a localized fix |
| `language/expressions/assignment/dstr/array-elem-trlg-iter-*` | ~12 | Overlaps **#1620-v2** (`__iterator_next` multi-value, in-progress). Not a localized fix |
| `language/expressions/dynamic-import/usage/*` | ~22 | `_FIXTURE.js` resolution + dynamic-import inside arrow/async. Test-runner gap, not codegen — recommend a separate runner-side issue or skip-filter |
| `language/expressions/class/elements/*private-method/*` | ~12 | Private-method receiver/closure capture; partial overlap with **#1605/#1680/#1681**. Investigate separately |
| `built-ins/DisposableStack/prototype/*` + `AsyncDisposableStack/prototype/*` | ~45 | Distinct protocol gap (**not** the brand-check from #820h). Likely needs follow-up issue |
| `built-ins/Iterator/zip/*` + `Iterator/zipKeyed/*` | ~22 | New Iterator helpers proposal (stage 3). Likely depends on the iterator bridge work; defer |
| `built-ins/Proxy/get/*` + `getOwnPropertyDescriptor/*` + `set/*` + `deleteProperty/*` | ~30 | Proxy invariant family; overlaps **#1640** (already documented as needing #1630/#1631) |
| `language/eval-code/direct/async-meth-*arguments-lex-bind*` | ~14 | Eval + arguments-lex-bind interaction; deep eval-semantics, defer |
| `language/expressions/object/scope-meth-param-*` | ~3 | Scope-leak on method rest-elem; possible overlap with **#779d** |
| `built-ins/Array/prototype/*` (residual after #820l) | ~12 | Mixed; re-bucket post-#820l |
| `built-ins/Function/length/S15.3.5.1_*` | ~9 | `new Function(...)` runtime code compilation — out of scope (no runtime compilation support); recommend skip-filter |
| Misc tail | ~30 | Per-site analysis on next triage cycle |

## Recommendation

Close umbrella once #820l + #820m land. The remaining ~793 fails distribute
across active in-flight issues (#1610, #1633, #1347b, #1620-v2, #1640,
#779d, #1605) and out-of-scope features (`new Function(...)`, dynamic-import
fixtures, Iterator-helpers proposal). The umbrella has served its purpose:
narrowing the residual from 6993 → 868 across sprints 53-54.

## Files touched by this triage

- `plan/issues/820l-arguments-object-extra-positional-args-not-retained.md` (new)
- `plan/issues/820m-namedevaluation-fn-name-class-and-proto-setter.md` (new)
- `plan/issues/820-nullish-typeerror-null-pointer-illegal.md` (umbrella; appended new sub-issue rows below)

## Triage method

1. Baseline JSONL filtered to `scope_official && status=='fail' &&
   error_category ∈ {null_deref, type_error, illegal_cast}` → 868 entries.
2. Bucketed by 3-component file path; sampled 23 files via
   `runTest262File` from `tests/test262-runner.ts` for ground-truth error
   messages.
3. Cross-referenced fail patterns against existing in-progress / done issues
   (#1053, #849, #779e, #1542/#1543/#1544, #1610, #1633, #1640, etc) to
   avoid double-counting.
4. Identified two distinct, untracked sub-buckets with localized-fix
   feasibility (#820l, #820m).
5. Did NOT also produce a fix PR — the strongest candidate (#820l) requires
   touching `arguments` plumbing, which intersects in-flight work on PR #794
   / #1528a (currently ESCALATED at −822 net regression). Safer to land
   #820l after #794 stabilises.

Scratch artefacts left for the next agent in `/home/node/.claude/jobs/8d9a5e7c/`:
`probe-820.mjs` (23-sample probe; reusable).
