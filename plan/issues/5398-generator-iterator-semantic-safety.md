---
id: 5398
title: "Reject unsupported generator resumption and live array iterator semantics"
status: in-progress
sprint: current
created: 2026-09-08
updated: 2026-09-08
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: compiler
goal: correctness
parent: 5393
assignee: "ttraenkler/codex-generator-safety"
---

## Measured defect

The JavaScript audit baseline at f816631c2ee108 records divergence for generator sent values, consumed yield-star completion values, escaped closure generator state, and array mutation during explicit iterator traversal. The host lane throws for generators/04-sent-values.js, loses the inner return for 05-yield-star.js, and reports 1000002 for 06-closure-state.js. Both targets mishandle general/iterator-generator/yield-star-return. An array iterator observes a host snapshot and throws in standalone when the source array grows after iterator creation.

## Plan

Minimize each mechanism against safe controls. Add source-located compile diagnostics for demonstrated unsupported shapes while retaining supported generator and iterator programs. Do not treat all generators or unknown shapes as a proven mismatch. Parent issue #5393 owns the immutable baseline and candidate audit artifacts.

## Minimized evidence and implementation

All measurements use the production import object, deferred module initialization,
and export wiring before executing `__module_init`. Node 24.4.1 requires
`--experimental-wasm-exnref` for the standalone generator resume functions.

| Shape | JavaScript | Host baseline | Standalone baseline | Decision |
| --- | --- | --- | --- | --- |
| `var x=yield 1; yield x`, resumed with 2 | 1,2 | 1,null | existing compile refusal | Refuse host untyped sent binding |
| `var x=yield 1; yield x+1`, resumed with 2 | 1,3 | 1,1 | existing compile refusal | Same sent-binding limitation |
| `return yield* inner()` with yield1/return7 | 1,7 | 1,null | 0,NaN | Refuse consumed return delegation |
| `var x=yield* inner(); yield x` with numeric completion7 | 1,7 | 1,0 | 1,7 | Refuse host only |
| Capturing generator expression interleaving two iterators | 1,2,3 | 1,3,2 | 1,2,3 | Refuse host captured writes only |
| Explicit array `Symbol.iterator`, no mutation | 1,2 | 1,2 | runtime exception | Refuse standalone explicit array cursor |
| Append3 after creating cursor over [1,2] | 1,2,3 | 1,2,undefined | runtime exception | Refuse host mutation before subsequent next |

`src/compiler/generator-semantic-safety.ts` returns source-anchored diagnostics
for these shapes. Generator body scans stop at nested functions. Captures, source
arrays, iterator bindings, and the global Symbol constructor use symbol identity;
unrelated/shadowed bindings are controls. Host live-array mutation detection is
currently limited to direct push/pop/shift/unshift/splice calls before a subsequent
same-scope next call. Other aliases and invisible mutations remain unclassified.
This is not a general generator correctness certificate.

## Validation

- 23 diagnostic unit tests pass, covering source locations, target differences,
  unrelated and shadowed bindings, mutation before creation/after consumption,
  and uncalled nested functions.
- With temporary integration in the shared source-safety collector, all seven
  newly guarded target/case pairs from the five assigned corpus/general cases
  produce the expected source diagnostic. Two standalone complex-generator
  cases retain their existing compile refusal; the supported standalone closure
  case still compiles.
- With the same temporary integration, 20 adjacent generator tests pass plus
  one pre-existing todo (issue-2157 and issue-2662 suites). The test worker needs
  `--experimental-wasm-exnref` on this local Node version; without it nine
  standalone tests fail before execution with the unsupported-opcode message.
- Eight runtime controls (typed sent binding, basic sequential yields, ignored
  numeric yield-star completion, readonly captured expression on both targets)
  preserve their baseline JavaScript outputs.
- Repository TS7 typecheck and targeted Biome lint pass.

## Integration

The general JavaScript audit integration uses `collectUnsafeGeneratorSemantics(checker, file,
{ standalone })` into the shared collector and registers the new frontend module
in the compiler inventory. The final complete manifest verifies the integrated collector. This detector
does not change the generator backend or expand any failure baseline.

## PR5748 bounded repair handoff (2026-09-15)

The held PR head `9b36161f94ab1108b1ed0e1917a828ee3d3dad58` rejects
`language/expressions/dynamic-import/assignment-expression/yield-star.js`.
That upstream test defines an uncalled generator and tests syntax only; it
does not observe a delegation completion. With the delegation diagnostic
filtered in a temporary probe, its original harness and strict rerun pass
(local Wasm fingerprint `7227dc4f41c8`, Node v22.23.2).

An array-operand exception would be unsound. The executed control
`function* g(){var x=yield* [1,2];yield x;}var it=g();`
followed by four `next()` observations produces `1 2 0 true`, where Node
produces `1 2 undefined true`. String array delegation has the same wrong
completion. The original numeric generator control still prints `1 0`
instead of `1 7`. These are raw defects, not diagnostic-only expectations.

No generator guard relaxation is included in the bounded repair. A tentative
file-local unreferenced-declaration check was removed: the collector visits
one file at a time, so it cannot establish whole-program non-execution.
Moreover, the original harness installs `$262` helpers and global aliases
including an `eval(sourceText)` path. Ignoring those helpers or exempting an
import operand by syntax would not establish a safe execution boundary.
Existing negative expectations are unchanged; additional tests retain
refusals for executed/escaping/exported/dynamically referenced import
generators and executed array completion.

Amended proposal, requiring a separately authorized write set: provide a
frontend-owned, whole-program unreachable-function fact to the semantic
collector (`src/compiler/semantic-safety.ts` and its pipeline caller in
`src/compiler.ts`, in addition to this guard and focused tests). The fact
must account for other input files, exports, alias/callback escapes and
dynamic evaluation, and must decline when reachability is unknown. Only a
proven unexecuted declaration may bypass this runtime limitation. If the
existing frontend cannot supply that fact, repairing actual delegation
completion is a generator-backend semantics change and needs separate
ownership. Do not weaken the six-case CI regression expectation or remove
the PR hold on the strength of the other five repairs.
