---
id: 4309
title: "A sloppy direct `eval` in a `let`/`const` loop scope is lowered to the INDIRECT provider entry (and the #4308 'top-level eval traps' finding is this predicate, not a trap)"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
completed: 2026-08-09
assignee: ttraenkler/senior-dev
priority: medium
horizon: m
feasibility: medium
model: opus
reasoning_effort: max
task_type: bug
area: codegen
language_feature: eval
goal: runtime-eval
related: [2929, 4238, 4305, 4308]
# The predicate + its helper MOVED out of the calls.ts god-file into
# src/codegen/direct-eval-environment.ts (its subject-matter module) rather than
# buying a loc-budget allowance for the god-file — calls.ts shrinks, the leaf
# module grows. No allowance keys are needed; loc/func/oracle gates are green
# as-is.
#
# Id provenance: allocated with `claim-issue.mjs --allocate` (#2531). The
# open-PR scan was DEGRADED (no `gh` in this container; the env token 401s on
# the REST API), so `--allow-unscanned` was required and the id is verified
# against upstream `main` + the assignment ref only. The reservation initially
# landed on the FORK's book — `pickAssignRemote()` picks `upstream` only when a
# remote is literally NAMED `upstream`, and in this checkout the upstream remote
# is named `loopdive` — so it was re-claimed with
# `CLAIM_ASSIGN_REMOTE=loopdive CLAIM_ASSIGN_LEGACY_REMOTES=origin`, which
# migrated the record forward:
#   "claim #4309 verified on loopdive/issue-assignments".
---

# #4309 — direct eval in a `let`/`const` loop scope routes to indirect eval

## Where this came from, and what it is NOT

#4308's P4 probe recorded an **incidental finding**: an `eval` used as a direct
top-level statement of a module body "traps — uncaught `WebAssembly.Exception`",
while the identical statement inside any `{ }` block works. It was reported
catch-free, so it was correctly ruled out as a duplicate of #4305.

**There is no trap.** The reported symptom is an artifact of the probe's own
instrumented adapter, and the mechanism underneath it is a **lowering** choice:

- The probe's adapter recognised a sentinel source (`@@P4N`) **only in
  `__runtime_direct_eval`**.
- Every "trapping" row is a row the compiler lowers to
  **`__runtime_indirect_eval`**; every "working" row is one it lowers to
  `__runtime_direct_eval`.
- On the indirect entry the sentinel was never intercepted, so `@@P4N` was
  handed to the real engine as JavaScript, threw, and — with no `try`/`catch`
  in the catch-free re-run — propagated out as an uncaught
  `WebAssembly.Exception`.

Reproduced with a js2wasm-compiled stub provider (no engine at all), the two
entries answering distinguishable values:

| module body (Script goal, sloppy) | entry reached |
| --- | --- |
| `slot = eval(src);` (bare top-level statement) | `__runtime_indirect_eval` |
| `(0, eval)(src)` | `__runtime_indirect_eval` |
| `{ slot = eval(src); }` | `__runtime_direct_eval` |
| `if (c) { slot = eval(src); }` | `__runtime_direct_eval` |
| inside any function / arrow | `__runtime_direct_eval` |

**The bisected boundary is not "top level vs. block".** It is
`directEvalRunsAtScriptGlobal()` and, decisively, the compile option
`inferModuleStrictArguments`. With the default (`true`, Module goal ⇒ strict)
the bare top-level statement lowers **direct**; with `false` (the Script goal
every `language/eval-code/` test compiles under, and what the probe passed) the
same statement lowers **indirect**. The `isStrictContext` line at the top of the
predicate is the switch. Anyone bisecting on source shape alone will get the
wrong answer.

## Root cause

`src/codegen/direct-eval-environment.ts::directEvalRunsAtScriptGlobal`
(introduced by #2929, previously in `src/codegen/expressions/calls.ts:3270`,
moved here by this change).

A sloppy direct eval whose LexicalEnvironment already **is** the realm global
record is deliberately lowered to the indirect entry: at global scope there is
no AOT activation record to hand over, and manufacturing an empty one would
bury a B.3.3 global publication in a provider-private declarative record. That
much is intentional and correct.

The predicate answers the question by walking from the call to the source file
and stopping at every node that installs a LexicalEnvironment. **That stopping
set is incomplete.** It lists `Block`/`CaseClause`/`DefaultClause`/`CatchClause`/
`WithStatement`/function/class — but not the **per-iteration declarative record**
of a `let`/`const` loop. §14.7.4.2 (`CreatePerIterationEnvironment`) and
§14.7.5.6 (`ForIn/OfBodyEvaluation`) install that record around the **whole
statement** — head, test, increment and body — and the body is inside it whether
or not it is braced. So:

```js
for (let i = 0; i < 1; i += 1) eval(src);          // walked past a real record
for (const v of xs) eval(src);                     // ditto
for (let i = eval(src); …; …) …                    // ditto (lexical head)
for (let i = 0; i < 1; i += 1) { eval(src); }      // correct — only via ts.isBlock
```

The first three were classified as "runs at the script global" and lowered to
indirect eval. `ts.isBlock` was masking the defect for the braced form only —
which is exactly why the probe's block/no-block table looked like the boundary.

## What is NOT wrong

For a statement that is genuinely a direct child of the `SourceFile`, the
short-circuit is sound, and this issue does **not** change it. Measured against
the real interpreter provider, the two entries are indistinguishable there:
`this` (`object` both), reading a top-level `let`/`var`, writing back to a
top-level `let`, and eval-introduced `var`/`function` declarations all behave
identically on either route.

The routing change is also **safe for B.3.3**: the two entries share one realm
global environment record. Measured cross-route — declare through one, read
through the other:

| declared via | read via | result |
| --- | --- | --- |
| block (direct) `function ha(){}` | bare (indirect) `typeof ha` | `function` |
| bare (indirect) `function hb(){}` | block (direct) `typeof hb` | `function` |
| block (direct) `var wa = 55` | bare (indirect) `wa` | `55` |
| `for (let …) { var wb = 66 }` (direct) | bare (indirect) `wb` | `66` |
| `for (let …) { function hc(){} }` (direct) | bare (indirect) `typeof hc` | `function` |

`var`-headed loops are therefore still excluded on purpose: they install no
record, so re-routing them would be a pointless move of a working B.3.3
publication onto the private-record path.

## Why the fix has a measured delta of ZERO today

The mis-routing is a **latent** wrong answer, and it is worth saying plainly:
fixing it changes no test result today, because a second gap masks it. At Script
global scope **no** enclosing lexical binding is reified for direct eval at all —
`collectDirectEvalBindingNames` / `functionMayReachDirectEval`
(`src/codegen/direct-eval-environment.ts`) take a `ts.FunctionLikeDeclaration`,
so `__module_init` never gets a binding set. Measured against the real
interpreter provider:

| shape | `eval("i")` / `eval("bl")` |
| --- | --- |
| function-local `let` | **9** (works) |
| global `{ let bl = 5; eval("bl") }` (direct route) | `ReferenceError` |
| global `for (let i = 42; …) { eval("i") }` (direct route) | `ReferenceError` |
| global `for (let i = 42; …) eval("i")` (indirect route) | `ReferenceError` |

Both routes lose the binding, so the predicate's wrong answer is currently
invisible. It stops being invisible the moment #4308's EDI work reifies global
lexicals — at which point the braced form would start working and the unbraced
one would silently keep failing, which is the worst possible way to discover
this. That is the reason to fix the predicate now and lock it with a routing
test rather than wait for the behavioural symptom.

## Measured corpus delta

Scoped run, `TEST262_PATH_FILTER='language/eval-code/'`, `TEST262_TARGET=standalone`:

| tier | before | after | flipped either way |
| --- | --- | --- | --- |
| interpreter (`TEST262_FULL_RUNTIME_EVAL=1`) | 779 / 816 | 779 / 816 | **0 / 0** |
| refusal (default tier) | 279 / 816 | 279 / 816 | **0 / 0** |

**Zero delta on both tiers, as predicted by the masking above** — and zero
per-test flips in *either* direction, not merely an unchanged total. The 37
interpreter-tier failures are the known #4308 EDI/B.3.3 buckets (16 ×
`f is not a function`, the `existing-block-fn-update` family, etc.), none of
them attributable to eval-call routing. A zero delta is the honest result: this
change buys correctness of the predicate, not conformance.

The **quickjs** engine tier was deliberately not run as a third measurement: on
this base #4238 slice 3 is unmerged, so direct eval is a typed refusal under
that engine and the direct/indirect distinction this issue is about is not
observable there. Measuring it would have produced a number that looks like
evidence and is not.

## The fix

`src/codegen/direct-eval-environment.ts` — add
`iterationStatementDeclaresLexicalHead()` to the stopping set of
`directEvalRunsAtScriptGlobal()`, and move both out of the `calls.ts` god-file
into the module that owns direct-eval scope reasoning. `calls.ts` imports the
predicate; nothing else changes at the call site.

## Test

`tests/issue-4309-direct-eval-script-global-routing.test.ts` — ten cases against
a js2wasm-compiled stub provider over the frozen 4-import seam, with the direct
and indirect entries answering distinguishable values. **4 fail before the fix,
all 10 pass after.** Each case asserts both the module's import list (exactly
one of the two entries) and the answer that came back, so a case cannot pass by
folding the eval away — every eval source is composed at runtime, since
`tryStaticEvalInline` folds a literal argument and never consults a provider.

Four of the ten are deliberately **negative** controls that lock the #2929 shim
against being widened: the bare top-level statement, an unbraced `if`
consequent, and a `var`-headed loop must all stay indirect.

## Non-goals

- Reifying global-scope lexical bindings for direct eval (the masking gap) —
  that is #4308's EDI work, not a routing fix.
- The `language/eval-code/` EDI/B.3.3 failure buckets — #4308.
