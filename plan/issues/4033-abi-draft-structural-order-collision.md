---
horizon: m
id: 4033
title: "ESLint frontier: two entry-source support drafts collide on one structural order"
status: done
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-02
assignee: ttraenkler/claude
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: multi-module-compilation
goal: npm-library-support
sprint: 78
required_by: [1282, 1400, 2693]
es_edition: n/a
related: [1282, 3520, 4001, 4018, 4019, 4027, 4028]
---

# #4033 — `intrinsic-provider` and `legacy-module-init-pass` share a structural order

## Problem

The current single hard error on the ESLint `linter.js` graph, reachable only
after #4001, #4018, #4019, #4027 and #4028:

```text
Codegen error: ABI drafts
  ir-binding:v1:callable:ir-source:v1:0000000000000118:entry:linter.js:intrinsic-provider:0000000000000000
and
  ir-binding:v1:support:ir-source:v1:0000000000000118:entry:linter.js:legacy-module-init-pass:0000000000000000
share structural order 118:0:0:5:0
```

Thrown as `duplicate-draft-order` from `ProgramAbiSession` (see
`src/codegen/program-abi-session.ts`, the `draftOrderOwners` collision check).

## Analysis

Two structurally distinct support drafts on the **entry source** —
`intrinsic-provider` and `legacy-module-init-pass` — are assigned the identical
structural order tuple `118:0:0:5:0`:

- `118` — the entry source's order
- `0` — declaration ordinal
- `0` — domain ordinal
- `5` — role ordinal
- `0` — derived ordinal

Both carry `derivedOrdinal: 0` and the same role ordinal, so the tuple cannot
distinguish them. The collision is in how these two support kinds derive their
ordinals, not (apparently) in the drafts themselves being duplicates: their ids
differ and their `intent.kind` differs (`callable` vs `support`).

Worth checking first, and **not yet ruled out**: whether #4001 (which changed
the accumulated `__module_init` from being compiled and injected once per source
to once per graph) altered the ordinal that `legacy-module-init-pass` derives.
The name appears directly in the colliding id. Against that reading, #4001
strictly *reduces* the number of module-init passes, and the equivalence suite
plus the multi-source behavioural A/B showed no change — but the interaction has
not been directly tested, and the ESLint graph never reached this code on any
earlier state, so there is no before/after comparison available.

## Acceptance criteria

- A reduced fixture reproduces the collision without ESLint.
- The #4001 interaction above is explicitly confirmed or ruled out, with
  evidence, before any ordinal-assignment change is designed.
- Distinct support kinds on one source get distinct structural orders.
- ESLint `linter.js` advances past this diagnostic.

## Root cause (2026-08-02) — a duplicated role ordinal, and #4001 is RULED OUT

Two constants independently claimed role ordinal **5**:

- `PROGRAM_ABI_CALLABLE_ROLE.moduleInit = 5` in the shared role table
  (`src/codegen/program-abi-planning.ts`), used by `legacy-module-init-pass`.
- `PROGRAM_ABI_PROVIDER_ROLE_ORDINAL = 5`, a **bare literal** in
  `src/codegen/program-abi-provider-planning.ts`, used by every
  `runtime-provider` / `intrinsic-provider` callable.

The provider constant was not derived from the shared table, so nothing kept the
two distinct. Structural order is `(source, declaration, domain, role, derived)`;
both drafts anchor to the entry source with declaration 0, domain 0, role 5 and
derived 0, giving the identical key `118:0:0:5:0`, and
`ProgramAbiSession.ensurePlan` rejected the second as `duplicate-draft-order`.

### The #4001 interaction is ruled out — by reading the code, not by an A/B

The original write-up flagged that `legacy-module-init-pass` appears in the
colliding id and that #4001 changed module-init emission. Resolved from
`ProgramAbiModuleInitCallableRegistry.planRetained`:

- The last live observation becomes the **exact unit** (`planExactUnit`); every
  other observation gets a `legacy-module-init-pass` support draft with
  `derivedOrdinal: observation.ordinal`.
- **Before #4001** the multi-source pipeline injected one `__module_init` per
  source, so observations `0 … n-1` existed and ordinals `0 … n-2` all became
  support drafts — **including derived ordinal 0**, the colliding one.
- **After #4001** there is a single observation. If it is the exact unit it
  produces **no** support draft at all; only when it is not does one appear at
  ordinal 0.

So #4001 strictly **reduces** the number of drafts that can occupy ordinal 0. It
cannot have introduced the collision, and if anything narrows the window for it.
The collision needs only a provider draft plus any `legacy-module-init-pass`
draft at derived ordinal 0 on the entry source — a condition that predates
#4001. A direct A/B on ESLint was not possible (without #4001 the graph does not
finish), which is why this was settled by reading the ordinal arithmetic.

## Fix

`callableProvider: 12` added to `PROGRAM_ABI_CALLABLE_ROLE`, and
`PROGRAM_ABI_PROVIDER_ROLE_ORDINAL` now reads from that table instead of being a
local literal. Every callable role ordinal is defined in exactly one place.

## Result

The ESLint package entry now reports **zero hard codegen errors** — the abort
chain that ran #4018 → #4019 → #4027 → #4028 → #4033 is fully cleared. It still
emits no binary; what blocks it is now a **set of independent gaps** rather than
a single abort:

- `Dynamic new K(...x) … $ObjVecArr … not reserved` ×3 — **#4037**
- `Internal error compiling expression: Cannot read properties of undefined
  (reading 'kind')` ×2 — **#4038**
- `Module '"eslint"' declares 'Linter' locally, but it is not exported` — CJS
  interop, #3654 follow-up
- ~13 IR-fallback warnings (type resolution), which do not block emission

Separately: `'node:fs' call to 'readFileSync' requires the --allow-fs flag` is
**not a defect** — it is the #1491 policy gate, and ESLint legitimately reads
files. Passing `allowFs: true` clears it, and the tier1 entry should use it.

## Verification

`tests/issue-4033-callable-role-ordinals-distinct.test.ts` — 3 passed.

The assertion is at the **unit** level, deliberately. Twelve small multi-source
graphs (Math intrinsics, string runtime calls, 2- and 4-source chains, each under
`plain` / `experimentalIR` / `trackIrOutcomes` / both) all compiled **clean** —
the collision only arose on a 146-source real graph. Pinning the invariant
directly is faster, stronger, and catches the *next* duplicated ordinal rather
than only this one.

Non-vacuity could not be shown against the base commit (the `callableProvider`
key does not exist there, so the test cannot even compile). It was shown instead
by re-introducing the defect — setting `callableProvider: 5` — which turns the
suite red with `expected [ '5: moduleInit + callableProvider' ] to deeply equal []`,
naming the colliding pair exactly.
