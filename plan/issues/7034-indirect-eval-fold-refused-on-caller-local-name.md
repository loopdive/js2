---
id: 7034
title: "eval: a literal indirect eval whose Script names a caller local is no longer folded, so it falls to __extern_eval / js2wasm:runtime-eval (issue-3632/3633 red)"
status: ready
sprint: Backlog
created: 2026-10-17
updated: 2026-10-17
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: eval
goal: standalone
parent: 7014
related: [3632, 3633, 7029]
---

# #7034 — fold literal indirect eval with global resolution instead of refusing

## Evidence

`eb197445a8` ("preserve established compilation boundaries", 2026-08-03) added
`foldedIndirectEvalReadsCallerBinding` in
`src/codegen/expressions/eval-inline.ts`: inside a function, a literal
`(0, eval)("…")` whose Script mentions any name that is a caller local/capture
is not spliced. That is the correct refusal for the splice as implemented (it
would read the caller's local), but it turns a provably static eval into a
dynamic one:

- `tests/issue-3632-eval-early-errors.test.ts` "preserves valid sloppy names": a
  direct `eval("var public = 1; 3")` makes `public` a caller local, so the later
  `(0, eval)("var public = 2; 4")` is refused → host `__extern_eval` (EvalError
  under the default dynamic-code policy) / standalone `js2wasm:runtime-eval`
  import. Pairwise probe: only the (direct var X, indirect var X) pair refuses.
- `tests/issue-3633-eval-annexb-bindings.test.ts` `indirectScope`
  (`const shared = 7; (0, eval)("… shared;")`) → same, all 4 red.

## Plan

Compile the indirect-eval splice with caller locals hidden rather than refusing:
enter a scope that masks `fctx.localMap`/`boxedCaptures` entries named by the
Script (the mirror of `enterFoldedEvalLexicalScope`), so identifiers resolve to
module globals / the global object exactly as §19.2.1.1 PerformEval with
`direct = false` requires; `var` declarations go to the global var
environment. Keep the refusal only where the global binding itself cannot be
expressed statically. Verify with the two files plus scoped test262
`built-ins/eval`, `language/eval-code/indirect` base vs fix, both lanes.

## Acceptance criteria

- [ ] 3632 and 3633 green on host and standalone, no `__extern_eval` / runtime-eval import for these sources
- [ ] no test262 regression in the scoped eval dirs
