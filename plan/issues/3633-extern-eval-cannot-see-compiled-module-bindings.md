---
id: 3633
title: "__extern_eval evaluates in a scope containing none of the compiled module's bindings"
status: done
assignee: ttraenkler/codex-es5-eval-bindings
created: 2026-07-25
updated: 2026-07-30
completed: 2026-07-28
sprint: 77
goal: es5
priority: high
horizon: l
feasibility: hard
---

# The dynamic eval path cannot see the enclosing module's bindings

## Problem

When `tryStaticEvalInline` declines a constant eval body — most often on the
deliberate `funcDeclNeedsDynamicEvalPath` guard (a nested `FunctionDeclaration`,
i.e. AnnexB B.3.3 territory, see the #2923 park note in
`src/codegen/expressions/eval-inline.ts`) — the call routes to the
`__extern_eval` host import.

`__extern_eval` (`src/runtime.ts` ~L8040) **compiles the eval string as a fresh,
standalone js2wasm module** and instantiates it, with a `(0, eval)` host
fallback. Neither route can see the _calling_ module's bindings: the fresh
module is compiled from the string alone, and the host fallback runs in the JS
global scope, where functions compiled into the Wasm module simply do not exist.

Any identifier the eval body inherits from its enclosing program is therefore
unresolvable. In test262 that identifier is almost always the harness itself.

## Probe (current HEAD, host mode, `tests/probe-eval-mvp.test.ts` — gitignored)

```ts
function helper(): number {
  return 5;
}
// direct:   eval("if (true) { function f() { return 1; } } helper();")
// indirect: (0, eval)("if (true) { function f() { return 1; } } helper();")
```

| probe                            | got               | spec      | verdict  |
| -------------------------------- | ----------------- | --------- | -------- |
| direct eval, non-foldable body   | `value=undefined` | `value=5` | **FAIL** |
| indirect eval, non-foldable body | `value=undefined` | `value=5` | **FAIL** |

Mechanism confirmed (the body does not see `helper`). **Symptom differs from
test262**: locally the call yields `undefined` without throwing; in test262 the
body does `assert.sameValue(...)`, so the property read on the unresolved
`assert` throws and is reported as `assert is not defined`. Both are the same
root cause — the binding is not in scope — but the local repro does _not_
reproduce the throw, and that discrepancy is itself worth understanding before
implementing.

## Measured denominator — and why the flip count is NOT 184

Baseline: `test262-current.jsonl` fetched 2026-07-25 18:21. Population =
ES5-classified (post-#3626 classifier), `eval`-dependent, host lane: 775 tests,
**484 not passing**.

- **184** of the 484 report literally `assert is not defined`.
- All 184 are `annexB/language/eval-code/*` — procedurally generated AnnexB
  B.3.3 tests. That family comes in two shapes: the `assert` call is either
  **inside** the eval string or **outside** it.

| shape (ES5, `annexB/language/eval-code`, host lane) | pass    | rate       |
| --------------------------------------------------- | ------- | ---------- |
| `assert` **inside** the eval string (masked)        | 0 / 144 | **0 %**    |
| `assert` **outside** the eval string (unmasked)     | 89 /325 | **27.4 %** |

So fixing scope visibility **unmasks** ~184 tests; the remainder then fail on
AnnexB B.3.3 semantics, which is #2200 / #2552's work, not this issue's.

**27.4 % is an UPPER BOUND on the post-unmasking flip rate, not a point
estimate.** The two shapes are not equivalent populations: the masked variants
put the `assert` call _inside_ the eval body, so after unmasking they exercise
strictly more machinery inside the splice (harness property access, call
dispatch, and the B.3.3 binding under test, all within the eval Script) than the
unmasked variants do, where the assert runs in ordinary compiled code. The true
rate is lower than 27.4 %; how much lower is only knowable from a post-fix
re-run.

**Do not quote 184 as a flip count** — it is a gate count. Do not quote 27.4 %
as a flip count either; quote it as a ceiling.

## Why this is `hard`

Making module bindings visible to `__extern_eval` means exporting a live
binding view (read _and_ write — B.3.3 requires the eval body to create bindings
the caller then observes) across the Wasm/host boundary. #1073 (`done`) injects
_caller locals_; this is the module/global-scope half, and it has to work for
the fresh-module compile route as well as the host-eval fallback. The
alternative framing — teach the folded path to handle nested function
declarations correctly so these bodies never reach `__extern_eval` — is
tracked by #2200 / #2552 and would resolve the same 184 from the other side.

## Acceptance criteria

- [x] The probe above returns `value=5` for both direct and indirect eval.
- [x] The unresolved-harness gate is bypassed in the lifted `annexB/language/eval-code`
      bucket (the tests then pass or fail on B.3.3 assertions, which is the correct next gate).
- [x] Standalone lane behaviour is unchanged or improved — `__extern_eval` is absent
      there, so this must not introduce a host import into a standalone module.

## Not covered here

AnnexB B.3.3 hoisting semantics (#2200 / #2552), eval in standalone mode
(#1066), direct eval with a runtime string (#3630).

## Resolution (2026-07-28)

The implementation takes the alternative route identified above: constant
sloppy eval Scripts containing block/if/switch-level function declarations now
reuse #2200/#2552's compiled Annex B B.3.3 lifecycle instead of crossing the
`__extern_eval` boundary. Direct eval keeps the caller binding view; indirect
eval uses an isolated view so caller locals cannot shadow compiled
module/global bindings.

Foreign eval nodes are not part of the TypeScript Program. A shared
`isForeignEvalNode` sentinel now prevents checker-only signature/type queries in
function hoisting, call classification, and open object-literal lowering. This
keeps descriptor/harness calls compiled in the original module.

The lift stays conservative. Duplicate same-name Annex B declarations and
same-name lexical declarations remain on the runtime path because they require
the full EvalDeclarationInstantiation conflict algorithm. Permanent tests cover
both successful lifting and these clean fallback boundaries.

### Same-SHA local A/B

Base: `108c41ecf166b195741a6f2509539471868156b7`. The control and branch used
the same local in-process runner, timeout, corpus, and lane settings.

| affected family                                                             | lane       | control |  branch | fail→pass | pass regressions | new compile errors |
| --------------------------------------------------------------------------- | ---------- | ------: | ------: | --------: | ---------------: | -----------------: |
| all 469 `annexB/language/eval-code` files                                   | host       |  89/469 | 155/469 |    **66** |                0 |                  0 |
| all 469 `annexB/language/eval-code` files                                   | standalone |   1/469 |  67/469 |    **66** |                0 |                  0 |
| 271 `es5id:` files in `language/eval-code` + `language/statements/function` | host       | 192/271 | 192/271 |         0 |                0 |                  0 |
| same 271-file ES5 corpus                                                    | standalone | 166/271 | 166/271 |         0 |                0 |                  0 |

The 271-file family was also identical at the error/reason-signature level.
Within the Annex B family, the 66 flips split into 45 direct and 21 indirect
files in each lane. Remaining failures progress to later B.3.3 assertions or
stay on the deliberately guarded fallback.

The historical baseline's literal `assert is not defined` count was not
reproduced by the current same-SHA local runner, so **184 is not claimed as a
flip count or as a current local gate count**. The exact measured result is
66/469 fail→pass per lane.
