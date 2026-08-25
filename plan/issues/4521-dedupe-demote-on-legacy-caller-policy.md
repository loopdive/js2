---
id: 4521
title: "demoteOnLegacyCaller mode policy is duplicated in select.ts and select-identity.ts — hoist to one shared module"
status: done
sprint: current
created: 2026-08-16
updated: 2026-08-21
completed: 2026-08-21
updated: 2026-08-21
completed: 2026-08-21
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: refactor
area: ir
language_feature: compiler-internals
goal: ir-full-coverage
parent: 3518
related: [3518, 4514]
origin: "tech-lead IR design review 2026-08-16"
files:
  - src/ir/select.ts
  - src/ir/select-identity.ts
---

# #4521 — one definition for the caller-direction demotion policy

## Problem

`const demoteOnLegacyCaller = options.jsHostExterns !== true;` is computed
independently in `src/ir/select.ts` (~line 1014) and
`src/ir/select-identity.ts` (~line 982), with mirrored consult sites in each.
The predicate machinery is properly shared (select-identity imports
`configureIrStructuralSelectorPredicates` etc. from select.ts), but the
mode-keyed POLICY line and its guard sites are copy-pairs. #3518's 2026-08-15
work had to patch both files in lockstep, and its notes call them out as "two
mirrored places". A future edit that touches only one silently forks
selection behavior between the structural and identity paths — a class of
drift no current gate detects (the two paths are never diffed against each
other).

## Acceptance criteria

- [x] The policy (`jsHostExterns !== true`, plus the
      `legacyCallerAbiIsProjected` consult contract around it) lives in ONE
      exported helper; both select.ts and select-identity.ts call it. Grep
      for `jsHostExterns !== true` finds exactly one hit under `src/ir/`.
- [x] Pure refactor: `check:ir-only` (both lanes), `check:ir-fallbacks`, and
      the equivalence gate are byte-for-byte unchanged.
- [x] Bonus if cheap: a comment or micro-test asserting the structural and
      identity paths consult the same policy object, so the next mirrored
      policy addition has an obvious home.

## Resolution (2026-08-21)

`src/ir/legacy-caller-policy.ts` is the single home: `demoteOnLegacyCallerPolicy`
(the caller-direction policy, carrying the one `jsHostExterns !== true`
comparison under `src/ir/`) and `jsHostExternsEnabled` (used by the two other
former literal sites in select.ts — `armHostGlobalResolvers` and
`certifiedHostIndirectEval` — so the grep criterion holds repo-wide, not just
at the two policy sites). Both select.ts and select-identity.ts consult the
shared helper; the consult contract (pairing with `legacyCallerAbiIsProjected`)
is documented in the module header.

`tests/issue-4521-legacy-caller-policy.test.ts` pins all three ACs: policy
semantics, single-hit grep over `src/ir/`, and both selector paths consulting
`demoteOnLegacyCallerPolicy(options)`.

Validation: ts7 typecheck clean; `check:ir-fallbacks` OK (no increases);
`check:ir-only` READY (both lanes, 37/37 + 38 standalone bodies unchanged);
`check:linear-ir` OK at the refreshed #4558 baseline. The transform is
mechanically identity-preserving (`!(x === true)` ≡ `x !== true`); the merge
queue's equivalence gate is the final byte-parity check.

## Resolution (2026-08-21)

`src/ir/legacy-caller-policy.ts` is the single home: `demoteOnLegacyCallerPolicy`
(the caller-direction policy, carrying the one `jsHostExterns !== true`
comparison under `src/ir/`) and `jsHostExternsEnabled` (used by the two other
former literal sites in select.ts — `armHostGlobalResolvers` and
`certifiedHostIndirectEval` — so the grep criterion holds across the tree, not
just at the two policy sites). Both select.ts and select-identity.ts consult
the shared helper; the consult contract (pairing with
`legacyCallerAbiIsProjected`) is documented in the module header.

`tests/issue-4521-legacy-caller-policy.test.ts` pins all three ACs: policy
semantics, single-hit grep over `src/ir/`, and both selector paths consulting
`demoteOnLegacyCallerPolicy(options)`.

Validation: ts7 typecheck clean; `check:ir-fallbacks` OK (no increases);
`check:ir-only` READY; `check:linear-ir` OK at the refreshed #4558 baseline;
LOC-budget OK (select.ts net 0 — the import line is offset by compressing the
superseded mirrored-places comment). The transform is mechanically
identity-preserving (`!(x === true)` ≡ `x !== true`); the merge queue's
equivalence gate is the final byte-parity check.
