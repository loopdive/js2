---
id: 5310
title: "for-in over a closed-struct receiver enumerates nothing in JS-host mode"
status: ready
created: 2026-09-03
updated: 2026-09-04
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
language_feature: for-in, enumeration
goal: npm-library-support
sprint: current
horizon: m
related: [1243, 1271, 2572, 2575, 5311]
# Reverting PR #5557 restores `loops.ts` to its ORIGINAL 4437 lines. The fix had
# left it at 4436 (one line under, from trimming a comment to fit the gate), and
# main's post-merge baseline refresh reset the ceiling to that lower number. So
# undoing the change now reads as +1 growth. The allowance is for the revert, not
# for new code — the file returns byte-for-byte to its pre-#5557 state.
loc-budget-allow:
  - src/codegen/statements/loops.ts
---

# #5310 — for-in over a closed-struct receiver enumerates nothing in JS-host mode

## Problem

```ts
export function keys(): string {
  const o = { a: 1, b: 2 };
  let out = "";
  for (const k in o) out += k + ",";
  return out;
}
```

Host mode returns `""`. Standalone returns `"a,b,"`. Same source, same compiler,
opposite answers — and the host answer is the wrong one.

`compileForInStatement` chooses its enumeration strategy by asking whether the
`__for_in_*` host imports are **registered**, not by asking what the receiver
**lowers to**. In host mode they exist, so the closed WasmGC struct is wrapped
with `extern.convert_any` and handed to a JS function that sees an opaque value
and returns zero keys. The failure is silent: zero iterations is
indistinguishable from an object with no keys.

Emitted host WAT — `struct.new 6`, then straight into the dynamic enumerators:

```wat
(local $o (ref null 6))
f64.const 1
f64.const 2
struct.new 6
local.set 0
...
local.get 0
extern.convert_any   ;; opaque to JS from here on
call 1               ;; __for_in_keys -> 0 keys
```

## FIRST ATTEMPT REVERTED — the obvious fix is wrong (2026-09-04)

PR #5557 made both targets decide from the lowered representation: a receiver
that is neither open (`isOpenForInReceiver`) nor dynamic
(`forInReceiverIsDynamic`) skipped the primitives and fell through to the
static unroll, the way standalone already did. The five focused tests passed,
111 tests across the for-in and enumeration suites stayed green, and both
budget gates were clean.

It still cost **net −6 test262 in the merge_group** (7 regressions, 1
improvement, wasm-hash changed on all 7, baseline content-current), and was
reverted. PR-level checks cannot see this — the shard matrix is
`merge_group`-only.

**The lesson is in the comment the fix was built on:** the static unroll is
exact for a *non-mutated closed shape*, and "neither open nor dynamic" is NOT
that predicate. The 7 regressions are three distinct ways a receiver can fail
it:

| class | test | what the unroll misses |
| --- | --- | --- |
| runtime-added keys | `test/language/types/object/S8.6_A4_T1.js` | `obj_ = {bar:true}; obj_.some = 1; obj_.foo = "a"` → counted **1**, expected **3**. Plain dot-writes add keys and do NOT mark the var in `growableObjectLiteralVars`. |
| inherited keys | `test/language/statements/for-in/order-property-on-prototype.js` | got `[p1, p2, p3]`, expected `[p1, p2, p3, p4]` — the unroll is own-shape only, with no `$proto` walk. |
| the global object | `built-ins/global/S10.2.3_A2.1_T1`/`_T2`, `built-ins/{NaN,Infinity,undefined}/…_A4.js` | `DontEnum` attributes on global properties; globalThis is not "dynamic" by the predicate but is certainly not a closed literal. |

Failing merge_group run: <https://github.com/loopdive/js2/actions/runs/33819963015>
(bucket signature `8cda47892f07d93d`, first occurrence — not cross-PR drift).

## What a correct fix has to establish

Static unroll may only be selected when ALL of these hold, and each needs a
real analysis, not a type-shape guess:

1. **No key is added or deleted at runtime** anywhere the receiver is reachable
   — including plain `o.newProp = …` dot-writes, which the current widening
   pre-pass does not treat as growth.
2. **No enumerable inherited key** — the receiver's prototype chain contributes
   nothing, or the unroll grows a `$proto` walk with shadow-skip (what
   `__object_keys_forin` does for the dynamic path, #2964).
3. **The receiver is not the global object** or any other host-backed carrier.

Anything short of that must keep the dynamic path in host mode, even though it
returns zero keys there today — a wrong-but-known-wrong answer is not improved
by replacing it with a differently-wrong one.

The alternative worth pricing first is making the host path *work* rather than
avoiding it: give the closed struct a runtime shape descriptor the JS
enumerators can read. That also fixes [#5311](5311-closed-struct-crossing-into-any-is-opaque.md),
which the representation gate did not touch.

## Measured package impact of the reverted attempt: none

jest 299/356 before and after; marked unchanged at 0/30. The packages that walk
an options bag reach it through an `any` parameter — see
[#5311](5311-closed-struct-crossing-into-any-is-opaque.md), which is the actual
blocker.

## Repro

The snippet at the top, via `compileAndRunHost`. The reverted test file
`tests/issue-5310-forin-closed-struct-host.test.ts` (5 cases) is in PR #5557
and can be restored verbatim by a follow-up that satisfies the three conditions
above — but it must be validated in a `merge_group`, not on PR checks.
