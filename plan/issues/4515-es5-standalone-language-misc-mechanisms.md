---
id: 4515
title: "ES5 standalone language-misc: 110-row cluster — ToPrimitive in binary ops, `in` on plain objects, arguments-object, completion values, ++/-- ReferenceError (2026-08-16 census)"
status: ready
created: 2026-08-16
sprint: current
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
es_edition: 5
goal: es5
related: [2668, 1888, 3626, 2666]
---

# ES5 standalone `language/` misc — 110 rows, ~7 mechanisms

## Source

2026-08-16 standalone census: ES5 bucket 8,454 / 9,029 pass, 575 nonpasses.
This issue owns the 110 rows under `language/` that are NOT with-statement,
statements/function, identifier-resolution/function-code, or literals/regexp.
Full file list + signatures:
`plan/log/analysis-2026-08-16-es5-standalone-575.md` (§language-misc and the
sub-triage table).

## Mechanism hypotheses (verify per-file before sizing — #3626 method)

| sub-bucket | n | hypothesis |
|---|---|---|
| types/object + expressions/in | 15 | `in` operator on plain `{}` must consult the prototype chain (`"valueOf" in __obj` → true) |
| expressions/assignment | 10 | compound assignment × property descriptors |
| equals/relational/addition | ~12 | ToPrimitive (valueOf/toString) on objects in binary operators; function-to-string in `f + ""` |
| expressions/instanceof | 7 | `[[HasInstance]]`: TypeError for non-Function RHS, prototype-chain walk |
| property-accessors + call | 11 | member access on undefined/null throws TypeError at the right point |
| arguments-object | 7 | `callee` own property + strict descriptor; arguments in nested scopes |
| statements/variable | 5 | var/function-decl shadowing order |
| do-while/while/return/switch | ~11 | completion values / evaluation order |
| ++/-- + types/reference | ~10 | ReferenceError on unresolvable reference; ToNumber ordering |
| singletons | ~19 | diffuse — fix opportunistically, don't chase |

## Acceptance

- Work the sub-buckets top-down; for each, verify the mechanism on 2-3 files
  with the single-file runner BEFORE writing a fix
  (`runTest262File(f, cat, 30000, "standalone")`, see
  `tests/test262-runner.ts:4428`).
- Each landed fix names the sub-bucket and the measured flip count (scoped
  standalone lane run over the sub-bucket paths, denominator stated).
- No host-import regressions: standalone fixes must be Wasm-native
  (CLAUDE.md dual-mode rule).
- Do NOT claim the whole 110 as a flip forecast anywhere.

## Method warnings

- Prebuild the eval provider or eval-shaped rows report manufactured failures
  (#4354): `pnpm run build:compiler-bundle && node scripts/build-quickjs-eval-provider.mjs`.
- An assertion that can throw before the probed value is read measures the
  throw, not the value — run a negative control (#3626 §2.2.1).

## 2026-08-19 re-census + dispatch

Fresh standalone baseline (`test262-standalone-current.jsonl`, 48,735 entries,
fetched 2026-08-19 04:52): standalone ES5 is **8,506 / 9,029 (94.2 %)** with
**523 non-passes** (495 fail, 24 compile_error, 4 compile_timeout). Earlier
figures in this file predate that and should be read as history.

This issue's lane in the 2026-08-19 6-way fan-out: **157 rows — language/ statements, expressions, types (largest lane)**.
Umbrella + full partition: #4163.

The residue is a **long tail** — the largest single error signature across all
523 rows is 13. Expect many small root causes, not one lever.

Local gate for this lane: 551 locally-verified-passing standalone ES5 tests must
stay at 551/551. Reproduce with the `--standalone` flag (without it you measure
the JS-host lane, a different and much worse corpus at 84.8 %).

**eval-rooted rows cannot be validated on the dev Mac** — CI's QuickJS eval tier
needs clang-18 (see #4163 for the full toolchain finding); record them as
blocked rather than chasing them.
