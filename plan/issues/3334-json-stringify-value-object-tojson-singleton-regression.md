---
id: 3334
title: 'standalone JSON.stringify serialises every object as "null" through any/closure paths — toJSON miss-guard vs $undefined singleton'
horizon: s
status: done
completed: 2026-07-17
assignee: ttraenkler/fable-gamma
created: 2026-07-17
updated: 2026-07-17
priority: high
feasibility: medium
task_type: bug
area: runtime
language_feature: json
goal: spec-completeness
sprint: current
related: [2933, 2106, 3008, 2166]
# The fix must live at the toJSON guard inside the codec builder.
loc-budget-allow:
  - src/codegen/json-codec-native.ts
---

# #3334 — standalone JSON.stringify object arg serialises "null" (toJSON miss-guard vs $undefined singleton)

> Renumbered from #3328 — that id collided with a different, already-merged
> issue (`3328-capturing-closure-toprimitive-dispatch.md`, landed via #3178).
> Both PRs raced `claim-issue.mjs --allocate` concurrently; #3178 merged
> first and won the id, so this file (opened as PR #3177) is the loser and
> renumbers per the documented collision-recovery flow
> (`reference_cross_session_issue_id_collision_renumber_loser`).

## Problem

`tests/issue-2933-json-stringify-value.test.ts` failed 3/9 on main (silently —
issue tests are not uniformly wired into required CI, the #3008 class): every
OBJECT passed to `JSON.stringify` through a reified value (`const f: any =
JSON.stringify; f({a:1})`) — or ANY `JSON.stringify(x)` inside a closure with
an `any`-typed argument — returned the string `"null"`. Scalars (numbers,
strings) were unaffected; the direct inline call `JSON.stringify({a:1})` also
worked (masking the bug).

## Root cause (bisected + verified)

Bisect (probe: reified-value object arg, standalone) → first bad commit
`6f7f93c856` — the #2106 **`$undefined`-singleton default-ON flip** (Jul 4).
Under that regime, `__extern_get`'s MISS value is the tag-1 `$AnyValue`
singleton box — **non-null** — but the §25.5.2 SerializeJSONProperty toJSON
lookup in `src/codegen/json-codec-native.ts` guarded callability with a plain
`ref.is_null; i32.eqz`. So a MISSING `toJSON` read as "callable":
`__call_to_json → __call_fn_method_1` ref-tested the singleton as a closure,
failed, returned null → the "toJSON returned null/undefined ⇒ JSON null" arm
emitted `"null"` for EVERY object. (The code comment even specified the
intended closure ref-test; it was never implemented.) The inline direct-call
path dodges it only when the checker's static object type routes property
reads off `__extern_get`.

`JS2WASM_UNDEF_SINGLETON=0` (legacy regime) reproduces the pre-Jul-4
behaviour — the A/B lever that confirmed the root cause on current main.

## Fix

Extend the toJSON guard: a `$AnyValue` box is never a callable closure, so
additionally require `!(any.convert_extern(m) is $AnyValue)` — tag-agnostic,
regime-gated (`undefinedSingletonActive`), so legacy modules stay
byte-identical. Genuine `toJSON` methods (via closure struct) still fire —
verified both regimes, both call shapes.

## Not in scope (pre-existing, both regimes)

`const o = {a:1}; f(o)` with a TYPED (non-any) object literal still serialises
"null" through the reified value — a nominal-struct → dynamic-call boundary
gap that predates #2106 (fails identically with the legacy lever). Tracked as
a residual note here; candidates for an S2 follow-up slice.

## Test Results

- `tests/issue-2933-json-stringify-value.test.ts`: 3/9 fail → **9/9 pass**
- probes: valObj/valAnyVarObj/userClosureObj 4 ("null") → 7; realToJson +
  realToJsonViaValue → 1 in BOTH regimes; legacy lane byte-identical
