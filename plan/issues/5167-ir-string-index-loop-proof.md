---
id: 5167
title: "IR: extend the #2972 string-index charAt delegation to counted-loop-proven reads (`for (i=0; i<s.length; i++) … s[i]`)"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: adoption
area: ir
language_feature: strings
goal: ir-full-coverage
related: [2972, 3931, 3518]
origin: "2026-08-28 IR-takeover session — scout probes .tmp/stridx-*.ts"
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/capability.ts
---

# #5167 — counted-loop proof for string `s[i]` reads

## Problem

`s[i]` on a string PARAM claims at select then demotes at BUILD
(`element-access-unsupported`, "index Identifier not in slice 12" —
from-ast.ts:5919-5923) in all three lanes. Constant index doesn't help (the
#2972 arm needs a statically-known receiver LENGTH, which a param never has).
Meanwhile `s.charAt(i)` / `s.charCodeAt(i)` CLAIM AND EMIT in all three lanes
(measured), and the literal-bound `const hex="0123…"; hex[n & 0xf]` shape
(#2972) claims everywhere. Measured 2026-08-28, probes `.tmp/stridx-*.ts`.

Legacy OOB behavior, MEASURED (host/gc lane, experimentalIR:false): `s[5]`
returns real JS undefined across the boundary; `s[5] === ""` and
`s[5] + "!"` TRAP (illegal cast); `typeof s[5]` statically folds to "string"
(itself wrong vs JS). Standalone returns the undefined singleton (#4232).
So OOB is per-lane divergent and trap-prone — NOT worth reproducing; the
unproven residual stays demoted (and `element-access-unsupported` is on the
documented NEVER-PROMOTE list, codegen/index.ts:2125-2127).

### Key sites

- from-ast.ts:5877-5885 — the #2972 string-receiver claim arm
  (`recvType.kind === "string" && ts.isIdentifier(expr.expression)` +
  stringLiteralLens + stringIndexProvenBelow → delegates to
  `lowerStringMethodCall("charAt", …)`).
- from-ast.ts:5545-5549, 9424-9461, installed at 9845-9872 —
  `isProvenInBoundsIr` / `detectCountedLoopSafeIndex`: SYNTACTIC counted-loop
  proof (`for (let i=<k≥0>; i < X.length; i++/+=k)` + body-non-mutation); it
  already records `"s:i"` for string receivers today (no receiver type check).
- capability.ts:258-357 — the #2972 single-source predicates
  (stringIndexProvenBelow, collectStringLiteralLens,
  stringElementReadLowerable). NOTE: capability.ts:284's claim that "gate 5"
  consumes stringElementReadLowerable is STALE (gate retired by the #3143
  allowlist rewrite; ir-first-gate.ts:10-16) — tests/issue-2972.test.ts is the
  live consumer; keep it so check:dead-exports stays quiet.
- from-ast.ts:10960 — the SEPARATE string-`+=` encoding-evidence gate that
  still demotes loop-builders (`out += s[i]`) AFTER this fix; that is S2,
  a follow-up issue, not this one.

## Implementation Plan

**Fable lane, 2026-08-28.** One slice.

In lowerElementAccess's string arm (from-ast.ts:5877), extend the condition:
`recvType.kind === "string" && ts.isIdentifier(expr.expression) &&
(litLen-proof-as-today || isProvenInBoundsIr(expr, cx))` → the same
`lowerStringMethodCall("charAt", …)` delegation. In-bounds `s[i]` ≡
`s.charAt(i)` exactly (§10.4.3.5 vs §22.1.3.1); charAt claims+emits in all
three lanes, so: no new read primitive, no per-lane work, no OOB decision
(OOB is unreachable under the proof). Keep the :5919 tail demote for
everything unproven. Update `stringElementReadLowerable` (capability.ts:348)
to accept a loop-proof witness so the predicate and tests stay in sync, and
verify the #2972 declarations.ts element-access arm pre-registers charAt for
the identifier-index case.

Scope cuts: receiver must be checker-derived `string` AND an identifier; index
must be the proven induction variable (lowerStringMethodCall's
proveAdditiveOperand demotes non-numeric indexes cleanly at 8382-8388).

Known limits (state in the PR, don't fight them):
- `out += s[i]` loop-builders still demote at the :10960 `+=` evidence gate —
  the element-access bucket shrinks but affected FUNCTIONS may move buckets,
  not flip to claimed. Follow-up (separate issue): mark charAt's result
  encoding wtf16 (encoding.ts:184's exclusion is about UTF-8 preservation,
  not absence of encoding).
- loopBodyMutatesIndexOrArray (9459) voids the proof if the body calls ANY
  method on the receiver — loops mixing s[i] with s.charCodeAt(i) stay
  demoted (over-conservative for immutable strings; relaxing is separate).

## Acceptance criteria

1. Claim+emit (trackIrOutcomes kind:emitted, irBodyEmitted:true) for counted
   loops reading `s[i]` on a string PARAM in all three lanes (default,
   nativeStrings:true, target:"standalone"); runtime parity vs legacy
   (experimentalIR:false) on the same inputs including the length-1 boundary.
2. Residual preservation: bare `s[i]`, `s[0]`, `s[i] === "a"`, `s[i];` shapes
   still demote with element-access-unsupported; proof-voiding shapes (body
   reassigns s or i, or calls a method on s) stay demoted.
3. `pnpm run check:ir-fallbacks` — element-access-unsupported must not grow;
   zero new postClaim entries.
4. Tests beside tests/issue-2972.test.ts; scoped equivalence for
   string-indexing; ratchet gates chained bare; new IR code checker-free.
