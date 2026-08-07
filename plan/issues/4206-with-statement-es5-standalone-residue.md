---
id: 4206
title: "`with` statement: the closed-object-literal-shape gate hard-refuses 39 ES5 standalone files and 11 more mis-resolve — 68 further files are blocked behind #4205, not behind `with`"
status: ready
sprint: current
created: 2026-08-07
updated: 2026-08-07
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: with-statement
goal: es5
related: [671, 1387, 3025, 4179, 4205, 1472]
origin: "2026-08-07 W23 census of the ES5 standalone failing residue (published standalone baseline 20260807, oracle v13). Supersedes the 2026-03 stub #671."
---

# #4206 — the `with` statement residue, correctly sized

## The lever, and the correction to it

118 of the 1,365 failing ES5 standalone files use `with`. **That number is not
the lever.** Splitting by what actually fails first:

| | files | evidence |
| --- | --- | --- |
| Compiler hard-refuses at the gate | **39** | error text is literally `#1387: with statement requires a proven closed object-literal shape before codegen` |
| Runtime scope-chain misresolution, no `this.x=` contamination | **11** | `Scope chain disturbed`, `with(null) x = 2 must throw TypeError`, `o.foo` wrong |
| Also carry a script top-level `this.x = …` — **first failure is #4205, not `with`** | **68** | e.g. `S12.10_A1.1_T1.js` dies on line 61 (`p1 === 1. Actual: null`), `with` block is on line 42 |
| total | 118 | |

Only **12 of the 118 pass in the host lane**, so this is a general semantics
gap, not a standalone-lowering gap.

**Do not quote 118 as this issue's yield.** The honest expectation is 39 + 11 =
**50**, plus up to 68 more *after* #4205 lands. Per
`[[reference_error_signature_is_not_a_bucket_boundary]]`, a masked file counts
toward neither fix until both land — and when #4205 lands first, those 68 will
surface as *fresh* `with` failures, which reads as a regression to anyone who
did not write this down.

## Root cause

`src/codegen/with-scope.ts` implements only the Tier-1 closed-shape path: the
`with` target must be a syntactically closed object literal whose complete key
set is provable locally. `proveObjectLiteralWithTarget` rejects — and
`reportWithStatementDiagnostic` (line 838) raises the hard error — for any of:

- target is not an object-literal expression at all;
- the literal contains a spread (key set not local);
- the literal contains a getter/setter (needs dynamic property semantics);
- the literal contains a method (method-value routing deferred);
- the literal has a computed key.

The dominant rejection reason in the 39 is *"body contains a nested function or
class"*. The dynamic fallback is deferred to #1472.

## Sub-buckets inside the 39 CE files

| rejection reason | files |
| --- | --- |
| body contains a nested function/class | ~33 |
| other proof failures (spread / accessor / computed key / non-literal target) | ~6 |

Representative: `language/statements/with/S12.10_A1.12_T1.js`,
`S12.10_A3.8_T3.js`, `S12.10_A1.12_T5.js`, `language/statements/function/S13.2.2_A19_T8.js`.

## Sub-buckets inside the 11 runtime failures

- `language/identifier-resolution/S10.2.2_A1_T{5,6,7,8,9}.js` — 5 files,
  `Scope chain disturbed`: an identifier that the object environment record
  should shadow resolves to the outer binding.
- `language/statements/with/12.10-2-5.js` — `with(null)` must throw TypeError.
- `language/statements/with/12.10-0-8.js` — a setter on the `with` target is not
  invoked.
- `language/statements/try/S12.14_A14.js`, `built-ins/String/S15.5.5.1_A4_T1.js`,
  `language/reserved-words/ident-name-keyword-accessor.js`,
  `language/statements/function/S13.2.2_A18_T1.js`.

## Predecessors

- **#671** ("with statement support") is a 2026-03 backlog stub with no sizing.
  Close it as superseded by this issue.
- **#1387** (done) built the Tier-1 closed-shape path this issue extends.
- **#3025** (done) closed an earlier residual of the same gate.
- **#4179** (in-review) fixes top-level `with` bodies being dropped from
  `__module_init` — a different defect on the same statement. Re-measure after
  it lands.

## Acceptance criteria

- [ ] The 39 gate-refusal files either compile or the gate's rejection reason
      set is reduced with a measured count per reason.
- [ ] The 5 `S10.2.2_A1_T*` scope-chain files resolve identifiers through the
      object environment record.
- [ ] `with(null)` / `with(undefined)` throw TypeError.
- [ ] A/B reports the 50-file cohort and the 68 #4205-masked files **separately**.

## Measurement provenance

Same as #4205: `classifyEdition() === 5` over the standalone baseline
(48,619 rows, oracle v13, 2026-08-07), 8,931 files / 7,566 pass / 1,365 fail.
