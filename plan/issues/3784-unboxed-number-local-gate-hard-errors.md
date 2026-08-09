---
id: 3784
title: "#2782/#2790's no-box number-local gate threw a PLAIN Error, so its documented demote-to-legacy became a HARD compile error — latent until #3783 claimed function-local `var`s, then ordinary untyped JS stopped compiling on every target"
status: done
completed: 2026-07-29
sprint: 77
created: 2026-07-29
updated: 2026-07-30
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: correctness
area: codegen
language_feature: variables
goal: backend-agnostic-ir
depends_on: []
related: [2782, 2790, 3341, 3519, 3565, 3783, 3795]
# `from-ast.ts` +4: the two extra `IrUnsupportedError` constructor arguments
# (code + stage) and a two-line comment recording why the throw must be typed.
# The throw has to stay at the gate — it IS the gate's verdict — so this cannot
# move to a subsystem module. Trimmed from an initial +11 by moving the full
# rationale into `outcomes.ts` (next to the #3565 siblings) and this file; the
# residual 4 lines are the fix itself.
loc-budget-allow:
  - src/ir/from-ast.ts
---

# #3784 — a documented demotion that was really a hard error

## Summary

`function g(s) { var c = s.charCodeAt(0); return f(c); }` — an untyped
parameter, i.e. ordinary JavaScript — **did not compile at all** on current
`main`. Not a fallback, not a warning: `success: false`, **zero-byte binary**,
on `standalone`, `gc` and the default JS-host target alike.

```
Codegen error: IR path failed for g: ir/from-ast: local 'c' is bound as an
unboxed f64 but its TS type is not provably a pure number — ... demote to the
SAFE boxed legacy lowering in g (#2782/#2790) [IR-FALLBACK]
```

Read the message: it _asks for a demotion_ and then fails the build.

## Root cause — the throw was untyped

`lowerVarDecl`'s #2782/#2790 no-box NUMBER-local proof gate
(`src/ir/from-ast.ts`) states its own contract:

> anything unprovable — `any` / `unknown` / a MIXED `number | string` union —
> demotes to the SAFE boxed legacy lowering (which carries the dynamic tag)

But it raised a **plain `new Error(...)`**. `classifyIrFailure`
(`src/ir/outcomes.ts`) buckets any untyped throw as
`{ kind: "invariant", code: "unexpected-internal-throw" }`, and
`formatIrPathFallbackDiagnostic` (`src/codegen/index.ts:1602`) makes
`kind === "invariant"` a **hard** `Codegen error`. So the demotion channel was
never entered; the gate's documented safe path was unreachable by construction.

**This is a known class, and this is its fifth site.** #3565 already retyped
"DESIGNED demote-to-legacy sites that #3341/#3519 silently promoted to hard
`invariant` compile errors, contradicting their own documented contracts" —
four codes: `element-store-unsupported`, `element-access-unsupported`,
`return-type-legacy-coupling`, `compound-assign-unsupported`. This gate is the
same mistake once more.

## Why it surfaced now — #3783

The bug is older than #3783, but **latent**: before it, the IR selector did not
claim functions containing function-local `var` declarations, so the gate was
not reached for them. `89015a58d` _"feat(ir): adopt function-local var
declarations"_ (#3783, merged as PR #3802) made the selector claim them — and a
claimed function that throws fails **post-claim**, where there is no fallback.

Bisected, `git bisect run` over 67 revisions:

| commit                                           | result                   |
| ------------------------------------------------ | ------------------------ |
| `3cb92d271` (parent)                             | compiles (682 KB WAT)    |
| **`89015a58d`** _adopt function-local var decls_ | **`wat=0`, build fails** |

`let` was affected identically — the gate is per-binding, not per-keyword, so
"function-local `var`" names the _trigger_, not the blast radius.

## Blast radius, measured on `main` before the fix

| source shape                                      | before   | after |
| ------------------------------------------------- | -------- | ----- |
| `var c = s.charCodeAt(0)` → passed to a helper    | **FAIL** | OK    |
| `var c = s.charCodeAt(0)` used inline             | **FAIL** | OK    |
| `var c = s` (parameter is `any`)                  | **FAIL** | OK    |
| `let c = s.charCodeAt(0)` → helper (same shape)   | **FAIL** | OK    |
| `var n = s.length`                                | **FAIL** | OK    |
| `var c = 5` (in-range literal — provably numeric) | OK       | OK    |

Five of six. The surviving case is the one where the TS type _is_ provably a
pure number, which is exactly the gate working as intended.

## Why CI was green anyway

No test covered the shape. It was caught only because **PR #3795** added a test
asserting a grounded numeric-local proof reaches an untyped helper parameter
(`tests/issue-3765-numeric-locals.test.ts`) — that test failed, and the failure
was initially read as #3795's own. It is not: the repro reproduces on `main`
with #3795 nowhere in the tree.

This is the load-bearing lesson. A gate whose safe path is unreachable is
invisible to a green suite; only a test that exercises the _unprovable_ branch
can see it. The three #3565 sites had the same profile.

## Fix

Throw the typed `IrUnsupportedError` the demotion channel expects, under a new
`IrUnsupportedCode`:

- `src/ir/outcomes.ts` — add `"unboxed-number-local-unprovable"` to
  `IrUnsupportedCode`, documented alongside the #3565 siblings.
- `src/ir/from-ast.ts` — the gate throws
  `new IrUnsupportedError("unboxed-number-local-unprovable", "build", …)`
  instead of `new Error(…)`. Message text unchanged.

`kind: "unsupported"` is not hard, so the function demotes to the boxed legacy
body — the behaviour the comment promised since #2782. A genuine builder desync
still raises `invariant` and still hard-fails; nothing widens.

## Validation

- **The six shapes above** compile, and **five run correctly against real JS**
  (compiled → instantiated → compared: `charCodeAt`→helper, inline, `any` param,
  `.length`, `let`). Compiling is not the bar; the demoted body must be right.
- `tests/issue-3765-numeric-locals.test.ts` + `tests/issue-3783-ir-function-local-var.test.ts`
  — 20/20 pass (#3783's own adoption suite is unaffected).
- `scripts/equivalence-gate.mjs` — no new regressions.
- `tsc --noEmit` clean.

## Follow-up

`classifyIrFailure`'s untyped-throw default is `invariant`, i.e. **fail hard**.
That is the right default for a real desync, but it means every future
demote-to-legacy site is one forgotten error class away from becoming a build
failure — five sites have now made exactly this mistake (#3341/#3519 ×3, plus
this one). Worth a gate: no `throw new Error` in `src/ir/from-ast.ts`, forcing
an explicit choice between `IrUnsupportedError` and `IrInvariantError`. Filed
as a note here rather than scope-creeping this fix.
