---
id: 3948
title: "Standalone: object-literal methods never register optional-param metadata, so `__argc` stays at the -1 sentinel and every parameter default is skipped — the #2581 generator bail was a workaround for it (98 leak rows)"
status: done
completed: 2026-08-01
sprint: 78
created: 2026-08-01
updated: 2026-08-18
priority: high
horizon: m
complexity: M
feasibility: medium
task_type: bugfix
area: codegen
language_feature: generators, default-parameters, object-literals
es_edition: multi
goal: standalone-mode
umbrella: 3178
assignee: ttraenkler/dev-objlit-gen-dflt
related: [3178, 2581, 3893, 3896, 3945, 3949, 2938, 1557]
loc-budget-allow:
  # (#3102) Both grants are for THIS change-set. `literals.ts` gains the
  # optional-param registration block the class path has always had; the rest of
  # the growth in both files is the recorded correction of #2581's stated
  # justification, which is deliberately kept at the decision point — a wrong
  # justification left standing at the gate is how the bail survived review once
  # already. The full argument lives in this issue; the gate keeps the summary.
  - src/codegen/literals.ts
  - src/codegen/generators-native.ts
func-budget-allow:
  # (#3400) The registration has to sit inside the object-literal member loop,
  # next to the `funcUsesArguments` registration it mirrors and after
  # `methodParams` is built (it reads `methodParams[i + 1]` for the param's
  # ValType). Hoisting it out would mean re-deriving that array at a second site
  # — the exact divergence #2938 was caused by. +30 lines, ~20 of them the
  # comment recording why the map was empty.
  - src/codegen/literals.ts::compileObjectLiteralForStruct
origin: "2026-08-01: #3893's SCOPE table left 102 `object/*` whole-param-default rows with no owner. Instrumenting the gate showed the object-literal bail is not a generator defect at all — object-literal methods are the one method form that never registers `funcOptionalParams`."
---

# #3948 — object-literal methods never register optional-param metadata

## Root cause — instrumented, not inferred

`maybeSetArgcForKnownCall` (`src/codegen/statements/nested-declarations.ts:2174`)
opens with

```ts
if (!ctx.funcUsesArguments.has(funcName) && !ctx.funcOptionalParams.has(funcName)) return;
```

Class bodies populate that map at collection time
(`class-bodies.ts:1152` → `registerClassOptionalParams`), free functions do it in
`declarations.ts:553`. **Object-literal methods never did** — `literals.ts` only
ever registered `funcUsesArguments`. A probe printing the map at the decision
point:

| receiver                      | trace at the `o.m()` / `new C().m()` call site                                       |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `const o = { *m(a = 5) {…} }` | `[argc] maybeSet name=__anon_0_m paramCount=1 usesArgs=false optional=false keys=[]` |
| `class C { *m(a = 5) {…} }`   | `[argc] maybeSet name=C_m paramCount=1 usesArgs=false optional=true keys=[C_m]`      |

So the object-literal call site returned early, never emitted its
`global.set $__argc`, and the global kept its `-1` **"unknown host/module-init
caller"** init value. The callee's prologue
(`cacheParamDefaultArgc` + `emitParamDefaultArgMissingCheck`) evaluates
`argc != -1 && argc <= argIndex`, which is **false** for `-1` — read as "no
argument is missing" — so the default was never applied and the body used the
raw incoming slot (`0` for f64).

That is the whole defect. The generator bail was a workaround for it.

## The controlled experiment

Same tree, same commit (`d3854438366f` = `origin/main`), one token between arms,
`target: "standalone"`, host-import names from `result.imports`:

| arm                                   | source                        | result                                                                                                                          |
| ------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| CONTROL — objlit gen, no params       | `{ *m() { yield 1 } }`        | host-free                                                                                                                       |
| CONTROL2 — objlit gen, pattern        | `{ *m({x}) { yield x } }`     | host-free                                                                                                                       |
| CONTROL3 — objlit gen, elem dflt      | `{ *m({x = 5}) { yield x } }` | host-free                                                                                                                       |
| **SUBJECT — whole-param default**     | `{ *m({x} = {…}) {…} }`       | **leaks `__gen_create_buffer, __gen_push_f64, __create_generator, __gen_next, __gen_result_value_f64, __get_caught_exception`** |
| **SUBJECT2 — identifier default**     | `{ *m(a = 1) {…} }`           | **same six imports**                                                                                                            |
| CONTRAST — the identical CLASS method | `class { *m({x} = {…}) {…} }` | host-free                                                                                                                       |

The class/object-literal asymmetry on a one-token-identical body is what ruled
out both the #2571 name-kind exclusion and #3893's fn-expression fix, and pointed
at a per-emit-site registration difference rather than anything in the generator
machinery.

## #2581's stated justification was wrong twice over — recorded, not deleted

The lifted bail (`generators-native.ts`, `isNativeGeneratorCandidate`) read:

> Object-literal methods are invoked through the closure trampoline
> (`emitObjectMethodAsClosure`), which forwards args but does NOT set the
> `__argc_default` global the param-default check reads … The eager-buffer host
> path applies defaults correctly for the object-literal case, so route there.

Both halves are false:

1. **Not the trampoline.** A plain `o.m()` is a _direct_ call
   (`call-receiver-method.ts:1544`) and **does** reach
   `maybeSetArgcForKnownCall`. The trampoline is only for method _extraction_
   (`const f = o.m`). What the direct call found was the empty map above.
2. **The host path does not apply the default either.** Measured on the **default
   (JS-host) target**, instantiated with `result.importObject`:
   `{ *m(a = 5) }.m().next().value` → **0**, `imports=7`. So the bail bought no
   correctness — only a `__gen_*` leak in standalone.

## The wider defect this exposed → #3949

Because the missing registration is not generator-specific, the same `-1`
sentinel breaks **ordinary object-literal methods in the default target**:

| source                                        |  JS | js2wasm host lane (pre-fix) | js2wasm standalone (pre-fix) |
| --------------------------------------------- | --: | --------------------------: | ---------------------------: |
| `{ m(a = 5) { return a } }.m()`               |   5 |                       **0** |                        **0** |
| `{ m(a, b = 5) { return a+b } }.m(1)`         |   6 |                       **1** |                        **1** |
| `{ m(a?) { return a===undefined?42:a } }.m()` |  42 |                       **0** |                        **0** |

Filed as **#3949** so a host-lane default-parameter bug is not buried in a
standalone-generator issue. This PR fixes rows 1 and 2 in both lanes as a
consequence of the same one-place change; row 3 (`?`) is a value-representation
gap and stays open there.

## The fix — two guards, each independently load-bearing

**(A) `src/codegen/literals.ts`** — register `ctx.funcOptionalParams` for
object-literal methods, mirroring `registerClassOptionalParams` (constant vs
expression default classification included). `methodParams` leads with the
receiver `this`, so source parameter `i` takes its ValType from
`methodParams[i + 1]` — the same `paramTypeOffset = 1` the class path uses for
instance methods.

**(B) `src/codegen/generators-native.ts`** — lift the object-literal
`param.initializer` bail in `isNativeGeneratorCandidate`. `param.questionToken`
**still bails**, measured rather than inherited: even with (A) in place,
`{ *m(a?: number) { yield a === undefined ? 42 : a } }.m()` yields 0, because
`a?: number` lowers to a bare `f64` with no `undefined` inhabitant, so the
missing-arg branch has nothing to bind. Admitting it would trade a leak for a
wrong value. The corrected reasoning is written into the gate itself, not just
deleted.

## Acceptance

- [x] Object-literal generator methods with a parameter default emit **zero**
      `env::` imports in the standalone lane (bare compile, `result.imports`).
- [x] **Value** assertions, not just the import set — including a **read after a
      suspension** (`yield a; yield a + 1` → 6), proving the defaulted binding
      round-trips the generator state rather than only loading correctly.
- [x] The default stays a **call-time** observable (§27.5 EvaluateGeneratorBody +
      §10.2.11): after `o.m()` and before any `next()`, the initializer has run
      exactly once and the body not at all.
- [x] Sibling object literals sharing a method name keep **distinct** defaults
      (the #2938/#1557 dedup class): `{*m(v=1)}` → 1, `{*m(v=2)}` → 2.
- [x] Non-generator object-literal defaults correct in **both** lanes.
- [x] Kill-switch **each guard independently** (see below).
- [x] Host lane not silently perturbed — `prove-emit-identity` IDENTICAL.

## Kill-switch — both halves, separately

A test never seen failing is not a test, and a guard never seen to matter alone
is not load-bearing.

| reverted            | `tests/issue-3948.test.ts`                                                                                    | what it proves                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **(B) alone**       | **12 of 19 fail**, all with `WebAssembly.instantiate(): Import #0 "env": module is not an object or function` | the bail is what causes the leak                                                    |
| **(A) alone**       | **10 of 19 fail** — and the two **import-set assertions still PASS**                                          | the modules are host-free, instantiate with `{}`, and silently return the inert `0` |
| both restored (fix) | **19 of 19 pass**                                                                                             | —                                                                                   |

**The (A)-alone row is the point.** A fix validated on the import set alone would
have been green while returning the wrong number — exactly the failure mode
#3178's "Validation (applies to every slice)" section warns about. Only the value
assertions catch it. (Note the whole-param _pattern_ arms still pass under (A)-alone:
those defaults are applied by the destructuring lane, not by argc — so (A) and (B)
are load-bearing for genuinely different subsets, not redundant.)

## Measured effect — construct-sampled, and read the denominators

Population, re-measured on the **2026-08-01 00:51** standalone baseline
(48,088 records, oracle_version 12): object-literal, non-async, whole/param-default
generator rows carrying a host-import leak = **98**. (#3893's SCOPE table said 102
against the 2026-07-31 promote; 98 is today's count on the same predicate.)

- **All 98 are `compile_error` today.** They have never run. The prize is
  **host-free instantiation, not a pass delta — do not quote 98 as a pass count.**
- Shape split: 81 whole-param binding-pattern defaults · 9 identifier param
  defaults · 6 pattern-with-init · 2 misc.

Construct-sampled flip (`.tmp/cohort.mts`): each of the 98 real test262 files'
**actual** `*method(<params>)` signature was extracted from the source and
re-compiled as a minimal object-literal generator in the standalone lane; the
measured quantity is the import set of a bare compile.

| run                 | probes compiled | host-free | still leaking |
| ------------------- | --------------: | --------: | ------------: |
| **pre-fix control** |              97 |     **0** |            97 |
| **post-fix**        |              97 |    **89** |         **8** |

(1 of 98 had no extractable signature.) The pre-fix control run is what makes the
post-fix number meaningful — an instrument that cannot return the other answer
proves nothing.

The **8 residual** are one family: `gen-meth-dflt-{ary,obj}-ptrn-*-init-fn-name-{arrow,fn,gen,class}.js`,
where the _element_ default is a function/arrow/class/generator **expression**
(`{ arrow = () => {} } = {}`). Those bail in the plan builder
(`generators-native.ts`, the `el.initializer && isFunctionExpression | isArrowFunction | isClassExpression`
check), a different mechanism — not attributed here, not claimed here.

## Scoped-out residuals (probed, so they are stated rather than discovered later)

- **`?`-optional params** keep the host path — value-rep gap, see (B) above and
  #3949.
- **Method extraction** `const f = o.m; f()` still does not set `__argc`: the
  trampoline path has no call-site arity to record. Post-fix it is host-free but
  throws a `WebAssembly.Exception` from the null-`this` guard; pre-fix it leaked.
  Neither lane was correct before or after, so this is unchanged, not regressed.
- **Sibling literals in the HOST lane** still cross-talk (`{*m(v=1)}` reads 2) —
  the pre-existing #1557/#2938 struct-dedup class, wrong before (0) and wrong
  after (2). The standalone lane is correct post-fix.

## Test Results

- `tests/issue-3948.test.ts` — 19/19 pass; both kill-switches verified red.
- `tests/issue-2581-objlit-method-generators.test.ts` — the assertion that
  encoded the old (wrong) bail is **corrected in place** with the measurement
  that falsifies it, and a new assertion pins the surviving `?` bail. 13/13 pass.
- Adjacent suites green: `issue-2571-native-method-generators`, `issue-3893`,
  `generators`, `generator-method-destructuring` — 44/44 with #3948's file.
- `node scripts/equivalence-gate.mjs` — exit 0, **no new regressions**
  (32 failing / 1,611 passing against 36 baseline known-failures; the 4
  now-passing baseline entries are unrelated pre-existing drift and were **not**
  ratcheted here).
- `npx tsx scripts/prove-emit-identity.mjs check` — **IDENTICAL, all 60
  (file,target) emits.** Modules without an object-literal method carrying a
  default emit byte-identical bytes in every lane.
- `default-params` / `class-methods` / `arguments-object` / `anon-struct` /
  `issue-1672` show 28 failures — **identical, test-for-test, on unmodified
  `origin/main`** (A/B run). Pre-existing, not this PR.
