---
id: 4178
title: "Mixed-type ternary: the IR path BAILS on differing arm types, and the legacy fallback then miscompiles string-concat of the result (§13.15.3) — sometimes it fails to compile at all"
status: in-progress
assignee: ttraenkler/W3-runtime-eval-ternary
sprint: current
created: 2026-08-06
updated: 2026-08-06
loc-budget-allow:
  # +35 lines in `coerceType`'s `ref -> ref_null` arm: the missing `$AnyValue`
  # UNBOX case, which its three sibling arms (`ref_null->ref_null`,
  # `ref_null->ref`, `ref->ref`) all already carry IN THIS SAME FUNCTION. The
  # arm is a `coerceType` branch selected by `from.kind`/`to.kind`; there is no
  # subsystem module it could live in without splitting one four-way dispatch
  # across two files, which is what let the fourth arm silently diverge in the
  # first place. Most of the +35 is the comment recording why.
  - src/codegen/type-coercion.ts
# Same +35 lines, same reason: they are all inside `coerceType`, so the file
# gate and the function gate are measuring one change, not two. Splitting the
# function to satisfy R-FUNC would mean splitting the four-way `from.kind` /
# `to.kind` dispatch across two units — the precise structure whose fourth arm
# silently diverged and caused this bug.
func-budget-allow:
  - src/codegen/type-coercion.ts::coerceType
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: ir, codegen, coercion
language_feature: conditional-expression
goal: core-semantics
related: [2949, 2855, 3144, 1820, 3251, 1917, 2108]
origin: "Isolated 2026-08-06 while chasing the '#3251 RESIDUAL BLOCKER' runtime-eval ternary report; that report's framing is REFUTED below."
---

# #4178 — mixed-type ternary: IR bails, legacy fallback miscompiles concat

## The framing this REFUTES

This was handed over as *"runtime-eval-consumer mode miscompiles mixed-type
ternaries into an incoherent box"* — four readers disagreeing (`typeof` says
`"string"`, `Number()` gives NaN, concat gives `"[object Object]"`, `String()`
correct), flipped on by one line of `Function.prototype.call.bind(...)`, and
recorded as such in `plan/issues/3251-array-descriptor-overlay-substrate.md`
under `## RESIDUAL BLOCKER`.

**Measured on `main` @ `f31a1c3e3e`, `--target standalone`, literal-JS
`allowJs` lane. Almost none of that survives:**

| claim | measured |
| --- | --- |
| runtime-eval-consumer only | **false** — reproduces with NO eval boundary at all |
| `Function.prototype.call.bind(...)` flips the mode | **false** — that line does not set the eval-consumer flag; `evalConsumer=false` both with and without it, so the reported "control" and "trigger" were the same compile |
| `typeof v` wrong | **false** — returns `"number"`, correct |
| `Number(v)` NaN | **false** — returns the right number |
| `String(v)` correct | true |
| concat `"" + v` wrong | **TRUE — this is the whole bug** |

A bare `var F = Function;` *does* set the eval-consumer flag (the module then
imports `js2wasm:runtime-eval`), which is probably how eval-mode got implicated:
the reporter was working inside propertyHelper-including tests, which are all
eval consumers for an unrelated reason (#4162).

## What actually breaks

Only **string-concatenation of a mixed-type ternary result**:

```js
var n = 42;
var v = true ? n : "s";     // arms: f64 vs string
"" + v                      // WRONG
String(v)                   // "42"  correct
Number(v)                   // 42    correct
typeof v                    // "number" correct
```

Measured matrix (1 = correct):

| probe | result |
| --- | --- |
| `true ? num : "s"` then `"" + v` | **FAIL** |
| `false ? num : "str"` then `"" + v` | **FAIL** (not branch-dependent) |
| `v + ""` (operand order reversed) | **FAIL** |
| `true ? str : "s"` — arms SAME type | pass |
| `any` number + `""` with no ternary | pass |
| plain local number + `""` | pass |
| `String(v)` / `Number(v)` / `typeof v` on the mixed ternary | pass |

So the corruption is specific to the **concat lowering reading a value produced
by a demoted mixed-type ternary** — not to the ternary's value in general, and
not to `any`-operand concat in general.

## Root cause

`lowerConditional` (`src/ir/from-ast.ts:8600`, throw at **:8647**):

```ts
if (!irTypeEquals(ttype, ftype)) {
  throw new Error(`ir/from-ast: ternary branches have different types (…) in ${cx.funcName}`);
}
```

#3144 already relaxed this for non-scalar arms of the *same* IrType. Genuinely
mismatched arms still throw, which demotes the whole function to the legacy
AST→Wasm path — and that path miscompiles the concat.

**The demotion is also inconsistent, which is worse than either outcome alone.**
Same mechanism, two different behaviours depending on surrounding syntax:

- `return ("" + v) === "42" ? 1 : 0;` → compiles, returns the WRONG answer.
- `var s = "" + v; if (s === "42") …` → **hard compile error**
  `Codegen error: IR path failed for test: ir/from-ast: ternary branches have
  different types (f64 vs string) [IR-FALLBACK]`.

A user cannot tell which they will get.

## Proposed fix (aligned with #2855)

Do not bail. When the arms genuinely mismatch, **box both to `dynamic`** and
give the `if`/`else` a dynamic result type. That is what the spec means by the
result being an ordinary JS value, and it retires an IR fallback rather than
widening one — the explicit #2855 direction.

The primitive already exists: `IrFunctionBuilder.emitBox(value, toType)`
(`src/ir/builder.ts:442`, #2949 S5.0), which erases a concrete value into a
boxed-any carrier and supports a `JsTag` refinement.

**Read this before starting.** `emitBox`'s own header states the S5.0 methods
are *"byte-inert by construction … no producer calls them yet (from-ast/select
unchanged)"*. Implementing this makes you **the first producer**, so the
lowering path is unexercised in practice — budget for finding gaps there, and
verify the emitted module rather than trusting that the builder accepts it.

Constraints that fall out of the existing code:

- Each `emitBox` must be emitted **inside its own arm's body buffer**
  (`collectBodyInstrs`), or #1820's short-circuit guarantee breaks — that
  regression is documented in the function's header (a `select`-based version
  once caused non-termination on `n <= 1 ? 1 : n * fact(n-1)`).
- `emitBox` throws if its operand is already dynamic (verifier R1), so box only
  the non-dynamic side when one arm is already boxed.
- Prefer a refined `irDynamic(JsTag.X)` where the arm's partition is statically
  known — the builder header says lowering maps the refinement onto the
  canonical boxing helper.

## Measurable acceptance

There is a **committed, ratchetable** test for this — better than any probe:

`tests/equivalence/spec/coercion-arithmetic-add.test.ts` fails **8 of 20** on
main, and all 8 are in `scripts/equivalence-baseline.json`'s `knownFailures`
(one per lane × two cases):

```
coercion/arithmetic-add {host,host-O,standalone,standalone-O} any string + any string concatenates
coercion/arithmetic-add {host,host-O,standalone,standalone-O} any string + any number concatenates (§13.15.3)
```

That is **8 of the 36 entries in the entire equivalence known-failures baseline
— 22%**, one mechanism, failing in all four lanes including host. So this is
not standalone-only.

- [ ] The probe matrix above returns correct for all rows.
- [ ] Neither demotion shape occurs: no `IR-FALLBACK` for a mixed-type ternary,
      and no hard `Codegen error` for the `var s = "" + v` shape.
- [ ] `pnpm run check:ir-fallbacks` shows the mixed-type-ternary rejection
      bucket shrink; ratchet it with `--update-on-decrease`.
- [ ] `scripts/equivalence-baseline.json` drops those 8 entries
      (`equivalence-gate --update` reports them as "newly fixed").
- [ ] No standalone-floor regression.

## Size

**Unmeasured — deliberately.** The handover claimed it caps every
`propertyHelper` `verifyProperty(…, {writable: …})` because `isWritable`
computes exactly this mixed-type ternary shape; that part is plausible and
untested. A separate measurement found **739 ES5-label standalone failures live
in eval-consumer modules**, but that is an upper bound on a *different*
population and must not be read as this bug's yield — the eval-consumer
correlation is now known to be incidental (see the refutation table).

Whoever picks this up: measure the lever first, with the #4162 shim, before
committing to a plan. Five of five levers this session had their framing
refuted by the agent working them, and this issue is itself the sixth.

## 2026-08-06 — W3: the root cause above is REFUTED for the population that matters; PART of this landed

Branch `issue-4178-mixed-ternary-ir-box`. Full write-up:
`plan/agent-context/W3-runtime-eval-ternary.md`.

### What actually breaks concat (fixed on that branch)

Two **legacy-path** defects, neither of which is the IR bail:

- **(A)** `coerceType`'s `ref → ref_null` arm was the only one of its four
  same-function siblings missing the `$AnyValue` **unbox** case.
  `compileAnyBinaryDispatch` returns exactly `{kind:"ref", typeIdx:$AnyValue}`,
  so an `any`-operand `+` result assigned to a NULLABLE slot fell through to the
  generic guarded `ref.cast`, which tests the BOX against the target, always
  fails, and stores `ref.null`. The next `__str_concat`/`.length` dereferenced
  null and trapped.
- **(B)** `tryStaticToNumber` traced `const` initializers for an operand's VALUE
  but not for its STRING-NESS, so `const a: any = "1"; const b: any = 2; a + b`
  folded to `f64.const 3`.

### Why the IR bail is not the cause

Every unit in the failing shapes is rejected at IR **SELECT** stage
(`body-shape-rejected` / `call-graph-closure` — read with `trackIrOutcomes`) and
never reaches `lowerConditional`. Module-init, which is what test262 top-level
statements compile to, is always in that class. The two behaviours this issue
describes as "the same mechanism, two outcomes" are two different mechanisms:
the hard `IR-FALLBACK` error is the bail; the wrong answer / trap is (A).
**Fixing the bail alone would have moved zero measured failures.**

### Conformance yield: NULL at the sample size measured

An 800-file ES5-label standalone A/B (500 baseline-fails + 300 baseline-passes,
#4162-shimmed) shows **0 gained, 0 lost** attributable to this change. The raw
`+25 / −22` against the committed baseline is entirely artifact: the `+` are
baseline staleness (main moved 76.90% → 78.87% across seven PRs), and 18 of the
`−` are the `--refusal-only` provider tier of my own instrument. Re-running the
25 gains + 4 non-shim losses on **base** and **patched** gives `pass 25 / 29`
both times with **0 per-file differences**.

So: the equivalence evidence is real and cross-lane; the conformance yield is
**unproven**, not disproven — the sample is ~24% of the ES5-label failures, so a
true effect below roughly ±4 tests would not surface.

### The acceptance criterion was also mis-attributed — and is met anyway

The 8 `coercion/arithmetic-add` rows contain **no ternary**. They are (B) plus
(A). All 8 now pass; `equivalence-gate` reports **12** baseline known-failures
fixed (those 8 + `#1197`'s i32 peephole row + the Math.pow test262 pattern +
two `Symbol` rows) with **no new regressions**.

### The `emitBox` route was implemented and REVERTED — measured, not abandoned

- **Correctness regression:** `"" + (c ? someBoolean : "s")` IR-compiles to
  `"1"`, not `"true"` — the boolean brand on the arm's `i32` does not reach
  `emitBox`, so it boxes tag-2 instead of tag-4. A silent wrong answer replacing
  a loud compile error.
- **The bail just moves:** with it retired the same functions immediately hit
  `local 'g' annotated as string but initializer is dynamic`, then
  `arg 0 of call to len is dynamic, expected string`.

So the remaining slice is **(a)** carry the boolean/symbol brand onto the arm
IrType (or derive the partition from the arm's TS type at the lowering site),
**(b)** teach annotated-local writes and call-arg positions to accept a
`dynamic` producer via an explicit unbox/ToString, **then** **(c)** retire the
bail. That is an **L**, not an M. `tests/issue-4178.test.ts` pins the bail's
current behaviour so the boundary is visible.

### Adjacent defects found, not filed

- **`$AnyValue === nativeString` inline** answers false:
  `const g = a + b; g === "12"` is true but `(a + b) === "12"` is false.
- **Eval-consumer `$AnyValue`/externref mismatch.**
  `registerReassignedFunctionGlobals` (`src/codegen/index.ts:6006-6027`) widens
  every top-level binding to `externref`; consumers still expect
  `ref_null $AnyValue` from `resolveWasmType`; nothing coerces; and
  `stack-balance.ts:1504` papers over it with a blind
  `any.convert_extern; ref.cast_null $AnyValue`. Traps for a `$BoxedNumber`,
  mis-tags (tag-5 "string", the #1888 lie) for an `$AnyValue`. Fixing the boxer
  alone converts the wrong answer into a trap — the read site must go first.
  This is the real home of the "739 ES5-label standalone failures in
  eval-consumer modules" number, which is **not** this issue's population.

## Notes

- **Id provenance:** reserved via `claim-issue.mjs --allocate`. The open-PR scan
  degraded (`gh` unavailable), so `--allow-unscanned` was used, and the id was
  taken **above 4172** deliberately: open PR #4124 hand-picks 4163–4171 without
  reserving any of them, which has already collided with two PRs (#4142, #4145).
- The `## RESIDUAL BLOCKER` section in
  `plan/issues/3251-array-descriptor-overlay-substrate.md` should be replaced by
  a pointer here once this lands — it records the refuted framing.
