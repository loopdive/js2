---
id: 6789
title: "codegen: calling an extracted object-literal method (`const m = obj.m; m()`) traps with an uncatchable null dereference — regression of #2025"
status: done
assignee: "ttraenkler/claude-dev-6789"
branch: "claude/issue-6789-trampoline-null-this"
sprint: Backlog
created: 2026-09-30
updated: 2026-10-02
completed: 2026-10-02
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: this-binding
goal: crash-free
related: [2025, 1671, 1669, 1672]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H7"
---

# #6789 — `#2025` regressed: the trampoline's null-`this` branch has no throw arm

## Problem

```ts
const obj = { x: 1, m() { return this.x; } };
const m = obj.m;
try { m(); } catch (e) { log("caught " + (e instanceof TypeError)); }
```

wasm: `RuntimeError: dereferencing a null pointer` in
`__obj_meth_tramp___anon_0_m_1`, escaping the `try/catch` and killing the
instance. JS: `TypeError` (strict) or `undefined` (sloppy `this` → global),
either way catchable. #2025 (done) fixed exactly this shape; the review's
probe on `e303c5c7` reproduces it again.

## Root cause

`src/codegen/closures/method-trampolines.ts:254`:

```ts
if (currentThisGlobalIdx < 0) return nullThis;
```

returns the null receiver straight into the method body, which dereferences
it. The catchable-`TypeError` arm at `:236-282` covers the other trampoline
paths but not this early return.

## Correction

At `:254`, instead of returning `nullThis`, emit the same catchable
`__new_TypeError("Cannot read properties of undefined")` throw the sibling
arm uses (or, when the module is compiled in sloppy mode and the method does
not touch `this`, the sloppy-global receiver). Add a guard test to
`tests/guard-suite.json` so the next regression is caught by a required
check — #2025's own test evidently is not in the pinned/guard sets (see
#6783).

## Acceptance

- The probe logs `caught true`; the instance survives and later exports still
  work.
- Class methods extracted the same way (`const f = inst.method; f()`) behave
  identically (they may already; assert it).
- The regression test is added to `tests/guard-suite.json`.

## Implementation Plan

The issue's named cause was wrong. `currentThisGlobalIdx < 0` never fires
for the repro (the module has `__current_this`). The trampoline's `else` arm
was plain `ref.null` because **`methodUsesThis` was `false`**:

1. `emitObjectMethodAsClosure` captures receiver use at registration with
   `methodBodyReadsThis`. An object-literal method is normally compiled AFTER
   the function that first reads it as a value, so its body is still `[]`.
   The scan of an empty body answers "never touches `this`".
2. That `false` was stored in `pendingMethodTrampolines[].methodUsesThis`.
   `finalizeMethodTrampolines` reuses a stored value instead of rescanning, so
   the stale answer survived. It dropped the #2025 TypeError arm, and
   `local.get 0; struct.get` trapped on the null receiver.
   `tests/issue-2025.test.ts` ("object-literal extracted method reading `this`
   throws catchably") was red on main for this reason. That file is in no
   gating lane (#6783).

Changes:

- `src/codegen/closures/method-trampolines.ts`. Both registration sites
  (`emitObjectMethodAsClosure` and `ensureMethodClosureSingleton`) record the
  tri-state `compiledBodyReadsThis(…, true)`, which is `undefined` while the
  body is empty, so finalize rescans the compiled body. The emit-time body
  keeps the old answer, and finalize replaces it.
- `src/codegen/method-receiver-this.ts`, `bodyReadsReceiver`. The trampoline
  scan no longer counts receiver reads that cannot trap:
  - a `local.get 0` that `ref.is_null` tests, together with the `else` arm of
    the `if` that test feeds. This is the #6651 A11 guarded value read
    (`thisValue = this` → global/undefined).
  - a `local.get 0` that goes straight into `return`.

  The #5318 static sidecar still calls `compiledBodyReadsThis` with the
  default `guardedReadsAreSafe = false`, so its plain scan is unchanged.
- `src/codegen/method-receiver-this.ts`, `objectLiteralMethodDefersReceiver`.
  For an object-literal **async or generator** method, registration records
  `false` from the declaration. In standalone, its compiled body only stores
  the receiver into the frame its resume reads it from. Without this rule the
  rescan threw for 5 `method-definition/async-gen-meth-*` rows that pass on
  main.
- `src/codegen/context/types.ts`: doc of `methodUsesThis` updated
  (`undefined` = rescan).
- `tests/issue-6789-trampoline-null-this.test.ts`, added to
  `tests/guard-suite.json`.

## Resolution

Probes (JS-host lane, `.tmp/probe.mts`, wasm vs Node on the same TS):

| Shape | before | after |
| --- | --- | --- |
| issue repro (`const m = obj.m; m()` in a function) | uncatchable `RuntimeError: dereferencing a null pointer` in `__obj_meth_tramp___anon_0_m_1` | `caught true`, later export still answers |
| module-scope literal `top.n` with a param | same trap | `caught true` |
| class `const f = inst.method; f()` | `caught true` | `caught true` (unchanged) |
| method not reading `this` / empty method | `7` / `undefined` | unchanged |
| `m.call(obj)`, `obj.m()` | correct | unchanged |
| value read `seen = this` (plain + generator) | `undefined` | unchanged |
| `return this` | `null` | `null` (JS: `undefined`; unchanged) |

Tests:

- `tests/issue-6789-trampoline-null-this.test.ts`, 6 cases. 2 fail on the
  base sources and all 6 pass after.
- `tests/issue-2025.test.ts`: 5/6 before, 6/6 after.
- Also green: `tests/issue-6651-a11-gen-values.test.ts` (23),
  `issue-2015`, `issue-1118`, `issue-1602*`, `issue-1636s1`, `issue-1669`,
  `issue-1671`, `issue-4469` and `issue-5383-class-value-dynamic-call`.
- Unchanged from base: `issue-1672` has the same 5 failures (they need the
  test262 harness), and `issue-1671` raises the same unhandled
  `__call_fn_1` rejection.
- `pnpm run test:guard`: 21 files, 261 tests, exit 0.

test262 A/B (`scripts/run-test262-paths.mts --isolate`, base vs this branch
at the same main merge):

- JS-host lane, 347 rows (`language/expressions/object/method-definition/`,
  plus files that extract a member value, filtered to `this`/`super` users):
  304 pass, 42 fail before and after, with the same failing set.
- Standalone lane, the 110 `method-definition` rows: 102 pass, 2 fail,
  6 compile_error before and after, with the same failing set. (The
  scan-only intermediate version lost 5 of these rows; see above.)

Gates, all exit 0: `check-loc-budget` and `check-func-budget` (both plain
and with `LOC_GATE_BASE=origin/main`), `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`, `typecheck`, `format:check`,
`check-compiler-boundaries --mode inventory` (no unclassified modules),
`check:ir-fallbacks`, and every gate in the `quality` loop (`ir-dialect`
through `verdict-oracle`, plus `lint`). No budget allowance was needed:
`method-trampolines.ts` ends at 1499 lines (the god-file threshold is 1500).

Deliberately left out:

- In the JS-host lane, an extracted object-literal **generator or async**
  method that dereferences `this` (`{ *g() { yield this.x } }.g()`,
  `{ async m() { return this.x } }.m()`) still traps, exactly as on main.
  The host lane runs those bodies eagerly in the trampoline's call, so the
  trap is real there. They keep main's passthrough because the standalone
  frame machine needs it. A precise fix needs a per-lane answer
  (frame-machine vs eager body), which is follow-up work.
- `this?.x` on an absent receiver now throws a catchable TypeError. On main
  it returned `0`. JS answers `undefined`, so both are wrong.
