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
loc-budget-allow:
  # 2026-08-19 accessor-pair fix: for an accessor PAIR, TypeScript takes the
  # property type from the GETTER's return and requires the setter's parameter
  # to match, so `set foo(v)` beside a string-returning getter infers `v: string`
  # and __call_fn_method_1 casts the incoming externref with an UNGUARDED
  # ref.cast — `o.foo = 1` traps. Predicate + rationale live in the new leaf
  # module src/codegen/closures/set-accessor-param.ts; the god-file grows by the
  # IMPORT LINE ONLY (+1).
  - src/codegen/closures.ts
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

## 2026-08-19 lane findings (in progress)

### Fixed — `f.length` counts a SYNTHESIZED parameter

`function f(x, y) { return arguments; }` reported `f.length === 3`. TypeScript's
JS inference **synthesizes a trailing `args` parameter** on any function that
mentions `arguments`, and `expectedArgumentCountOfSignature`
(`src/codegen/function-expected-argument-count.ts:84`) counted it because it has
no `valueDeclaration`. Now reads `sig.declaration.parameters` — the actual
FormalsList, which is what §15.1.5 counts.

Verified: `language/expressions/call/S11.2.4_A1.{1,2}_T2` both flip to PASS, and
the #4436 controls (`language/{statements,expressions}/function/length-dflt.js`)
still PASS.

### Not fixed — a get/set PAIR on the same key is a hard trap in standalone

```js
var o = { set foo(v) {}, get foo() { return "G"; } };
o.foo = 1;
// RuntimeError: illegal cast in __call_fn_method_1
//   (via __call_accessor_set ← __extern_set)
```

Decisive controls: a setter **alone** works, and get+set on **different** names
works — so the setter slot ends up holding the arity-0 getter. Emission order in
`literals.ts` (~line 1090) is getter-then-setter and looks correct, so the defect
is below that, in `compileArrowAsClosure` or the `$PropEntry` store.

Gates 3 lane rows
(`language/reserved-words/ident-name-{keyword,global-property-accessor,reserved-word-literal}-accessor.js`)
plus anything else using an accessor pair.

### Two corrections to this issue's own census

- **The 4 `timeout (10s)` rows are NOT compiler hangs.**
  `language/comments/S7.4_A{5,6}` run **65,536 `eval()` calls** each, and
  `language/statements/for/S12.6.3_A10{,.1}_T1` are 9-deep nested loops. They are
  genuinely slow tests, so they should not be triaged as a hang cluster.
- **5 of the 6 `Scope chain disturbed` rows need `with`** (owned by #4206); only
  `S10.2.2_A1_T3` is plain var-hoisting and reachable here.

That removes ~9 rows from this lane's reachable pool.
