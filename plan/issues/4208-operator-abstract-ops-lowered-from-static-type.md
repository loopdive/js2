---
id: 4208
title: "Operator abstract-ops are lowered from the STATIC type: ToNumber / ToPrimitive / Type() are skipped for string, wrapper and `{valueOf}` operands — 59 ES5 files, `1 === true` answers true"
status: in-progress
completed_slice: "S1, S2, the first S3/S7 OrdinaryToPrimitive slice, and S4 wrapper loose equality — 2026-08-13"
sprint: current
created: 2026-08-07
updated: 2026-08-13
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: abstract-operations, value-representation
goal: es5
related: [3055, 4183, 4173, 2733, 3216, 3397, 4205, 4204]
assignee: ttraenkler/codex-4208
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/declarations.ts
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/index.ts
  - src/codegen/literals.ts
  - src/codegen/statements/variables.ts
  - src/ir/integration.ts
  - src/ir/module-bindings.ts
  - src/ir/select.ts
  - src/codegen/binary-ops-typed-dispatch.ts
  - src/codegen/binary-ops.ts
  - src/ir/backend/legality.ts
  - src/ir/from-ast.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/literals.ts::compileObjectLiteral
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/runtime.ts::resolveImport
origin: "2026-08-07 W23 census of the ES5 standalone failing residue. #3055 covers only `any === any` on boxed numbers; nothing covers ToNumber/ToPrimitive in update, compound-assignment and relational operators."
---

# #4208 — operator abstract-ops follow the static type, not the value

## The lever

**59 failing ES5 standalone files** under `language/expressions/<operator>/`.
45 of them fail in the host lane too, so this is a shared-semantics defect, not
a standalone-lowering one.

| operator family | files |
| --- | --- |
| `equals` / `does-not-equals` | 13 |
| `strict-equals` / `strict-does-not-equals` | 8 |
| `postfix-`/`prefix-increment`/`decrement` | 20 |
| `compound-assignment` | 5 |
| `addition`/`concatenation`/`unary-plus`/`unary-minus`/`bitwise-*`/shifts | 9 |
| relational (`<`, `<=`, `>`, `>=`) | 4 |
| total | **59** |

## Four observable shapes, one root cause

The compiler chooses the lowering of `ToNumber` / `ToPrimitive` / `Type(x)`
from the operand's **TypeScript static type**. Every failure is a case where
the runtime value's type is not the static one.

1. **`Type()` collapses across the f64 representation.**
   `1 === true` → `true` (`strict-equals/S11.9.4_A8_T{1,2,3}.js`,
   `strict-does-not-equals/S11.9.5_A8_T{1,2,3}.js`). Booleans and numbers share
   the f64 slot and `===` compares slots, not types.
2. **ToNumber is skipped in update expressions.**
   `var x = "1"; x--;` leaves `x === 1`, not `0`
   (`postfix-decrement/S11.3.2_A3_T3.js`, `prefix-increment/S11.4.4_A3_T3.js`,
   `postfix-increment/S11.3.1_A3_T3.js`, `prefix-decrement/S11.4.5_A3_T3.js`).
   Same with a wrapper: `var x = new Boolean(true); x++` (`S11.3.1_A3_T1.js`).
3. **ToPrimitive is skipped for `{valueOf}` / `{toString}` operands.**
   `var object = {valueOf: function(){return 1}}; object--`
   (`postfix-decrement/S11.3.2_A2.2_T1.js`, `prefix-decrement/S11.4.5_A2.2_T1.js`,
   `postfix-increment/S11.3.1_A2.2_T1.js`, `equals/S9.1_A1_T3.js`,
   `equals/S11.9.1_A7.9.js`, `does-not-equals/S11.9.2_A7.8.js`,
   `concatenation/S9.8_A5_T2.js`, `less-than/S11.8.1_A3.2_T1.2.js`,
   `greater-than/S11.8.2_A3.2_T1.2.js`, `addition/S11.6.1_A3.2_T1.2.js`).
4. **The same defect crashes instead of answering wrong** when the static type
   drives an unchecked cast: `illegal cast [in __str_to_number() ← __module_init]`
   (8 files: `equals/S11.9.1_A7.{2,3,4,5}.js`, `does-not-equals/S11.9.2_A7.{2,5}.js`,
   …), `illegal cast [in __module_init()]` (6 update-operator files),
   `dereferencing a null pointer [in __module_init()]`
   (`bitwise-not/S9.5_A3.1_T4.js`, `unary-minus/S11.4.7_A2.2_T1.js`,
   `unary-plus/S11.4.6_A2.2_T1.js`, `unsigned-right-shift/S9.6_A3.1_T4.js`),
   and one `invalid Wasm binary`
   (`compound-assignment/S11.13.2_A4.4_T2.7.js`).

Shape 4 matters for triage: **~16 of these files currently sit in the
"crash cluster" (#3442/#3443) by error text, but they are not an independent
crash mechanism** — the crash is this defect's failure mode when the mis-typed
value reaches a cast rather than a comparison. Fixing the coercion removes the
crash; hardening the cast alone converts a crash into a wrong answer.

5. **Compound assignment picks the numeric operator from the static type.**
   `x = 1; x += "1"` gives `2`, not `"11"`
   (`compound-assignment/S11.13.2_A4.4_T2.6.js`).

## Relationship to existing issues

- **#3055** (`ready`, unassigned) — `any === any` on boxed numbers returns
  equal-for-unequal. That is shape 1 restricted to boxed numbers; this issue is
  the general case including primitives (`1 === true`) and the other four shapes.
- **#4183** (`ready`) — `$AnyValue === nativeString` inline vs through a local.
  A narrow slice of shape 1.
- **#3397** (`ready`) — boxed value used in a scalar op without unbox. The
  standalone-invalid-Wasm framing of shape 4.

None of them owns ToNumber/ToPrimitive in update, compound-assignment or
relational operators. Sequence this **before** #3055/#4183 or fold those in;
they are strictly narrower.

## Codegen sites

- `src/codegen/binary-ops.ts` — abstract equality / relational dispatch.
- `src/codegen/binary-ops-typed-dispatch.ts` — the static-type dispatch that
  chooses the numeric arm.
- `src/codegen/coercion-plan.ts` / `coercion-engine.ts` — where a
  ToNumber/ToPrimitive plan is (not) inserted.
- `src/codegen/type-coercion.ts` — `coerceType`; and `__str_to_number` /
  `__to_primitive` / `__class_to_primitive` on the runtime side.
- Update expressions: the `PostfixUnaryExpression` / `PrefixUnaryExpression`
  arms in `src/codegen/expressions.ts`.

## Acceptance criteria

- [ ] `Type(x)` is a runtime property of the value for `===`/`!==`, not a
      compile-time property of its declared type: `1 === true` is `false`,
      `"0" === 0` is `false`, `new Number(0) === 0` is `false`.
- [ ] Update operators apply `ToNumber(ToPrimitive(v, number))` before the ±1,
      including for string, wrapper-object and `{valueOf}` operands.
- [ ] `+=` on a string operand concatenates.
- [ ] Relational and `+` apply ToPrimitive with the correct hint and call a
      user `valueOf`/`toString`.
- [ ] A/B over the 59-file set. **Report the 16 crash-signature files
      separately** and cross-check the delta against #3442/#3443's buckets so
      the two lanes do not double-count the same files.
- [x] **S1 (`Type()` for `===`/`!==`) — DONE.** Scoped by measurement to
      Number ⊥ Boolean, the only broken pair; see the W27 notes below.
- [x] **S2 must DELETE `isUpdateRetypedBoolean` from
      `src/codegen/strict-eq-type-disjoint.ts` in the same PR.** S1 left that
      guard in place so a Boolean binding that is a `++`/`--` target does not
      get its `Type()` folded, because the binding's `i32` slot still holds a
      Boolean after `x--` and folding there would trade one wrong answer for
      another. Measured on `origin/main@745f6066b7`, with #4204 already merged
      and the guard disabled behind a kill-switch: `S11.3.2_A3_T1.js` and
      `S11.4.5_A3_T1.js` fail `#1: var x = true; x--; x === 0. Actual: false`.
      Once #4204's `heterogeneous-scalar-var-widening` predicate grows an
      **UpdateExpression-target** arm, `x` holds a real Number `0`, `x !== 0`
      compares correctly at runtime, and those files pass *because the value is
      right* rather than because a fold declined — at which point the guard
      guards nothing and is a dead constraint that reads as live. The S2 work
      happens in `heterogeneous-scalar-var-widening`, not in the fold's module,
      so this is written here rather than only in that file's doc comment.

## Measurement provenance

`classifyEdition() === 5` over the standalone baseline (48,619 rows, oracle v13,
2026-08-07): 8,931 files, 7,566 pass, 1,365 fail. Host comparison from the
same-day host baseline (`test262-current.jsonl`, `env` imports only).

---

# W27 verification + implementation notes (2026-08-07)

Base for every number below: `origin/main@1f613276d8`, freshly fetched, in a
worktree provisioned via `scripts/provision-worktree-deps.sh`. Standalone lane,
full-interpreter runtime-eval tier (`TEST262_FULL_RUNTIME_EVAL=1`) with
`.test262-cache/runtime-eval-provider-*.wasm` **deleted before every rebuild** —
the cache key `854c120ce015d507` was identical across all four rebuilds in this
worktree, so the key and the 3,995,550-byte size are worthless as controls and
only the deletion is.

## 1. The filed root cause REPRODUCES — with one shape narrower than filed

The census that produced this issue ran no local compiles, so the first job was
to re-derive it. Both halves check out:

- **Population re-derived exactly.** `classifyEdition() === 5` over the
  standalone baseline gives **8,931 ES5 files / 7,574 pass / 1,357 fail**
  (the issue said 7,566/1,365 — the baseline moved by 8 since it was written),
  and the operator-family failing set is **59, matching the filed table
  family-for-family**.
- **Mechanism reproduces on freshly-compiled code, not just baseline text.**
  A 17-case shape probe run locally reproduced all five filed shapes.

The one correction: **shape 1 is Number ⊥ Boolean only.** A 27-cell strict-
equality matrix over every ES5 `Type()`-disjoint pair found String↔Boolean,
String↔Number, wrapper-object↔primitive and object-literal↔primitive **already
answer correctly** on unfixed main. Only Number ⊥ Boolean is broken — both
operand orders, `===` and `!==`, literals and locals. The issue's "`"0" === 0`
is `false`" and "`new Number(0) === 0` is `false`" acceptance criteria were
already satisfied before this change.

## 2. The ~16 crash-cluster files: attribution CONFIRMED, count is 21

The issue asked whether the crash-signature files belong to #3442/#3443 or to
this coercion defect. **They belong here.** Measured 21, not ~16:

| signature | n | attribution |
| --- | --- | --- |
| `illegal cast [in __str_to_number()]` | 8 | `==` with an Object operand and a Boolean operand. The lowering statically decides "ToPrimitive may give a string" and casts the anyref to a string ref unconditionally; a `$BoxedBoolean` fails the cast. **All 8 PASS in the host lane** — standalone-only. |
| `illegal cast [in __module_init()]` | 7 | 4 are `+=` mixed-type (this issue); **3 are NOT** — `_A2.1_T1` files whose CHECK#2 is `this.x = 1` at script top level, i.e. #4205's absent realm global object. |
| `dereferencing a null pointer [in __module_init()]` | 5 | unary `~`/`-`/`+`/`>>>` on a `{valueOf}` object. The object literal's *static* shape fixes a field layout and funcref type; an absent or differently-shaped `valueOf`/`toString` reaches an unguarded `ref.as_non_null` on a `ref.null`. |
| `invalid Wasm binary` (`any.convert_extern` type error) | 1 | `x = true; x += "1"` — same `+=` defect, caught at validation instead. |

**The consequence the issue predicted holds: hardening the cast would convert a
crash into a wrong answer.** For the 8 `__str_to_number` files the cast is the
*only* thing currently stopping a `$BoxedBoolean` from being read as a string;
a guarded cast would return NaN and the comparison would silently answer wrong.
Recommend #3442/#3443 **hand these 18 files to this issue** and keep the 3
`_A2.1_T1` files, which are #4205's.

## 3. The filed 59 is over-inclusive by 8 — real #4208 population is 51

Attributed per file from the head-arm run, not by error text:

| bucket | n | owner |
| --- | --- | --- |
| S1 `Type()` collapse, Number ⊥ Boolean | 6 | **FIXED here** |
| S2 update-op ToNumber (string / wrapper operand) | 8 | #4208 |
| S3 ToPrimitive on `{valueOf}`/`{toString}` operand | 16 | #4208 |
| S4 abstract-`==` Object vs Boolean (illegal cast) | 8 | #4208 |
| S5 compound assignment, mixed types | 5 | #4208 |
| S6 ToPrimitive on Date / function operand | 2 | #4208 |
| S7 unary ToPrimitive (null deref) | 2 | #4208 |
| `_A2.1_T1` script-goal `this.x` | 3 | **#4205, not this issue** |
| `_A2.1_T2` unresolvable-reference `ReferenceError` | 4 | **not this issue** |
| `_A2.4_T2` evaluation-order / exception propagation | 4 | **not this issue** |

## 4. S2 has a hard dependency the issue does not name

`var x = "1"; x--;` is not a *mis-coerced* update — it is a **no-op**. The
ref/ref_null local arm of `compilePrefixUpdate` / `compilePostfixUpdate`
(`src/codegen/expressions/unary-updates.ts`) reads the slot, coerces to f64,
adds 1 — **and never stores the result**, because an f64 does not fit a
string-typed slot. Confirmed by probe: `typeof x` is still `"string"` and the
value is still `"1"` afterwards.

So S2 cannot be fixed inside the update operator. It needs the binding to be
representable as either type first — which is **#4204**'s
`heterogeneous-scalar-var-widening`, in flight and **not yet on `main`** as of
`1f613276d8`. #4204's predicate keys on assignment RHS tag disagreement, so an
UpdateExpression target almost certainly does not trigger it today. **Sequence
S2 after #4204 lands and extend that predicate to update targets** rather than
adding a second widening path.

## 5. What landed: S1

`compileBinaryExpression` promotes any i32/f64 operand pair with
`f64.convert_i32_s` *before* dispatching. The promotion was written for
`string.length:i32 !== 8:f64`, where both sides really are Numbers; it fires on
every i32/f64 pair, so a Boolean is merged into the f64 slot and §7.2.16 step 1
never runs:

```wat
f64.const 1        ;; 1
i32.const 1        ;; true
f64.convert_i32_s  ;; <-- Type() dies here
f64.eq             ;; => 1
```

`src/codegen/strict-eq-type-disjoint.ts` now owns the fold **and** the
promotion in one helper, because their order is the fix.

### Why a STATIC fold is defensible in an issue titled "lowered from the static type"

The fold keys on the **agreement between the Wasm representation and the static
type**, never on the static type alone. An operand whose runtime value may be
of another JS type is boxed (`externref` / `$AnyValue`) and never arrives as a
scalar. Both known escapes are excluded by name: a for-in target `var` (same
`forInIdentifierVars` guard the #296 externref arm carries) and a
heterogeneously-assigned binding (#4204 routes it to externref). `i32` alone is
not a Boolean marker — `type i32 = number` and `string.length` are i32 with a
*number* static type — so the Boolean side requires `isBooleanType` plus the
absence of every other primitive predicate. Loose equality is untouched:
`1 == true` is genuinely `true`.

## 6. Measurement — final, re-cut on the merged tip

Main moved five times during this work (#4192, #4193, #4194, #4195, #4196).
**Every number below was re-cut on `origin/main@745f6066b7`** with all five
merged in; nothing from the earlier `1f613276d8` base survives here. Both arms
differ only in the three source files this change touches, and the runtime-eval
provider was rebuilt from a deleted cache for each arm (7 rebuilds total; key
`854c120ce015d507` was identical on every one, and the artifact size moved
`3,995,550 → 4,141,601` purely because main advanced — the key tracks neither).

The measurement path imports `compile` from `src/index.js` under `tsx`. It does
**not** go through the test262 pool worker, and `scripts/compiler-bundle.mjs` /
`scripts/runtime-bundle.mjs` do not exist in this worktree at all, so the
stale-bundle trap cannot apply.

| arm | n | result |
| --- | --- | --- |
| lever (the 59 filed files) | 59 | base 4 pass / head 10 pass → **FIXED 6, BROKE 0** |
| control — **ALL 1,006** ES5 operator-family files the baseline calls `pass` | 1,006 | **FIXED 0, BROKE 0**, 1,006 unchanged |

The base arm already passes 4 of the 59: the `_A2.1_T1` files that #4192
(#4205) fixed. Diffing head against the *pre-merge* base would have reported
`FIXED 10` and claimed four of someone else's files.

### Byte-level exposure — an enumeration, not an estimate

Emitted module bytes hashed per file, base vs head, over three disjoint
populations (2,265 files):

| population | n | byte-identical | changed |
| --- | --- | --- | --- |
| lever | 59 | 53 | **6** — exactly the 6 that flipped to pass |
| control | 1,006 | 976 (+25 where the runner reports no sha on a `pass`) | **5** |
| deterministic 1,200-file sample of the ES5 population *outside* the operator families | 1,200 | **1,200** | **0** |

So the change provably cannot have altered 2,229 of the 2,265 modules measured,
and it altered exactly **11**. The 5 changed control files all still pass and
are all the same shape: `strict-equals/S11.9.4_A4.1_T{1,2}`,
`strict-does-not-equals/S11.9.5_A4.1_T{1,2}` (`Number.NaN === true`) and
`unary-plus/S9.3_A5_T2`. They were passing *vacuously* — `f64.eq(NaN, 1)` is
false for the wrong reason — and now pass for the right one. That is a
conversion, not a regression, and it is why the exposure table is reported
separately from the pass/fail table.

### The 8 control disagreements with the baseline

`line-terminator-{carriage-return,line-feed,line-separator,paragraph-separator}`
under `postfix-increment`/`postfix-decrement` fail locally while the baseline
calls them `pass`. They fail **identically in both arms** and on unmodified
base, so they are an artifact of `runTest262File` on parse-phase negative tests,
not a finding. Named rather than dropped: a 0.8 % blind spot that is silently
excluded is how a real regression hides.

### Unit coverage

`tests/issue-4208-strict-eq-type-disjoint.test.ts`, verified two-sided by A/B
against the pre-fix `binary-ops.ts`: **10 of 15 RED on base**, 5 green on both
arms as the deliberate PRECONDITION set (16 tests now, with the update-guard
case). `false` is the answer the fold produces, so a disjoint-only suite would
also pass an implementation that folded *every* strict comparison; the controls
are what distinguishes them. Run together with #4204's and #4205's suites on
the merged tip: **61/61 green**, so the three compose.

## 7. The guard is load-bearing — measured, not assumed

The full control caught two regressions the 59-file lever could not:
`postfix-decrement/S11.3.2_A3_T1.js` and `prefix-decrement/S11.4.5_A3_T1.js`
flipped pass→fail. Both were passing **vacuously**: `var x = true; x--` leaves
`x` as the boolean `false` (S2's defect), and the file's `x !== 0` was being
answered by the very f64 collapse this change removes. The fold now declines on
a Boolean binding that is a `++`/`--` target.

`#4204` is on main and does **not** cover this — verified by disabling only the
guard behind a temporary kill-switch, on the merged tip:

```
guard ENABLED    PASS S11.3.2_A3_T1.js   PASS S11.4.5_A3_T1.js
guard DISABLED   FAIL #1: var x = true; x--; x === 0. Actual: false
                 FAIL #1: var x = true; --x; x === 1 - 1. Actual: false
```

Both files being green on merged main was equally consistent with the guard
being redundant; only removing it distinguished the two. See the S2 acceptance
criterion above — the guard must be **deleted** when S2 lands.

## 8. Hand-over to #3442 / #3443 — READ THIS BEFORE HARDENING ANY CAST

21 of the filed 59 carry a crash signature. On the merged tip **17 belong to
#4208 and 4 need no home at all**:

| signature | n | disposition |
| --- | --- | --- |
| `illegal cast [in __str_to_number()]` | 8 | **#4208.** Re-verified still failing on `745f6066b7`. All 8 **PASS in the host lane** → standalone-only, not shared-semantics. |
| `illegal cast [in __module_init()]` | 7 | 4 are `+=` mixed-type (#4208); **3 now PASS** (see below). |
| `dereferencing a null pointer [in __module_init()]` | 5 | **#4208** — unary `~`/`-`/`+`/`>>>` on a `{valueOf}` object. |
| `invalid Wasm binary` (`any.convert_extern` type error) | 1 | **#4208** — same `+=` defect, caught at validation. |

**The 4 `_A2.1_T1` files are FIXED and closed**: `S11.3.1_A2.1_T1`,
`S11.3.2_A2.1_T1`, `S11.4.4_A2.1_T1`, `S11.4.5_A2.1_T1` all PASS on the merged
tip — measured through the real harness after #4192/#4196 landed, not inferred
from "#4205 merged". Their CHECK#2 is `this.x = 1` at script top level, which
is what #4205 fixed.

**The load-bearing warning, for whoever picks up #3442/#3443:** for the 8
`illegal cast [in __str_to_number()]` files the unchecked cast is the **only**
thing currently stopping a `$BoxedBoolean` from being read as a string.
Hardening or guarding that cast makes it return NaN and the comparison answer
**wrong**, silently — strictly worse than the trap, and it would read as
progress in the crash-count. Those 8 need the coercion fixed (S4), not the cast
hardened.

## 9. Residual after S1 — 45 files, attributed per file

| bucket | n | owner |
| --- | --- | --- |
| S2 update-op ToNumber (string / wrapper operand) | 8 | #4208 — **blocked on extending #4204's predicate** |
| S3 ToPrimitive on `{valueOf}`/`{toString}` operand | 16 | #4208 |
| S4 abstract-`==` Object vs Boolean (illegal cast) | 8 | #4208 |
| S5 compound assignment, mixed types | 5 | #4208 |
| S6 ToPrimitive on Date / function operand | 2 | #4208 |
| S7 unary ToPrimitive (null deref) | 2 | #4208 |
| `_A2.1_T2` unresolvable-reference `ReferenceError` | 4 | **not this issue** |
| `_A2.4_T2` evaluation-order / exception propagation | 4 | **not this issue** |

Highest-value next slice is **S3** (16 files): one `OrdinaryToPrimitive` engine
covering the relational operators, `+`, and the unary numeric operators. S7's 2
files are the same engine reached from the unary path, so S3 and S7 are one
piece of work worth 18.

---

## Handoff — 2026-08-07 (S3+S7 lane killed by a container restart)

**Unmerged work exists on `issue-4208-s3s7-ordinarytoprimitive` @ `5a2b4f04b0`,
fully pushed (local == remote), no open PR.** The lane started late and was
killed early, so **its contents are UNASSESSED** — read the two-dot diff against
`main` before assuming any part is complete. Do not assume it is empty either.

Two constraints inherited from S1 that must survive whoever picks this up:

1. **Do NOT re-do S1.** `src/codegen/strict-eq-type-disjoint.ts` is on main and
   owns both the strict-equality fold *and* the i32/f64 promotion whose **order**
   was the actual fix.
2. **Do NOT remove the Boolean `++`/`--` guard `isUpdateRetypedBoolean` on the
   assumption it is redundant.** It was proven load-bearing by a kill-switch
   experiment — with #4204's widening present on main and *only* the guard
   disabled, `var x = true; x--` fails again on both
   `postfix-decrement/S11.3.2_A3_T1.js` and `prefix-decrement/S11.4.5_A3_T1.js`.
   It can only be removed by repeating that proof.

   It **should** be removed by the S2 PR (extending #4204's
   `heterogeneous-scalar-var-widening` predicate to UpdateExpression targets),
   because at that point those files pass because `x` holds a real Number rather
   than because a fold declined. A guard left behind then is a dead constraint
   that reads as live. That removal is recorded as an acceptance criterion on S2
   with its reason, not just as an instruction.

**S2 remains blocked** on that predicate extension: `var x = "1"; x--` is a
*no-op*, not a mis-coercion — the ref-typed local arm computes the value and
never stores it, so it cannot be fixed inside the update operator.

Session-wide context, including the census-reliability record that bears on this
issue's own file counts: `plan/agent-context/session-2026-08-07-lead-handoff.md`.

---

## S2 closure — 2026-08-11

Base: `origin/main@70d531bcccc8a608da45b90998a2f6f2d4efb73e`, fetched from
`loopdive/js2wasm` and checked out in an isolated worktree.

S2 is no longer blocked. Update-retyped top-level `var` bindings now use a
single checker-identity analysis shared by IR selection and compatibility
allocation. Primitive initializers are represented by the IR dynamic carrier,
the module initializer boxes them through the existing IR producer, and
`++`/`--` calls the canonical ToNumber lowering before storing the resulting
Number. Object and wrapper initializers retain the same widened global but
conservatively demote module initialization until IR has a general
object-to-dynamic materializer; the update itself still uses the canonical
coercion path.

The original S2 population was eight files. Six were red on current main; the
two Boolean cases were green only because `isUpdateRetypedBoolean` suppressed
the strict-equality optimization after the update stored the wrong logical
type. The implementation deletes that workaround and proves those cases now
pass because the binding actually contains Number `0`.

Sloppy duplicate `var` declarations need one extra compatibility rule because
Test262 redeclares the same module binding. The analysis marks every declaration
sharing that symbol, and equality dispatch recognizes the widened module slot
instead of trusting the stale initializer type. A simple non-redeclared source
probe separately proves that `<module-init>` is emitted through IR with no
post-claim error; duplicate-declaration harness shapes remain on the conservative
compatibility path.

### Maintained-runner measurement

Node 25.9.0, Test262 `b363f29d3c43c626dc852744ad64a0b48a003693`,
maintained `pnpm run test:262` runner, exact six-file current-red filter:

| lane | before | after | run id |
| --- | ---: | ---: | --- |
| host GC | 0 / 6 | **6 / 6** | `20260811-194844` |
| standalone | 0 / 6 | **6 / 6** | `20260811-194926` |

The six are the prefix/postfix increment/decrement string cases plus the two
Boolean-wrapper increment cases. The Boolean-primitive correctness proof and
sloppy-redeclaration coverage live in the focused unit suite.

The same implementation also closes the update-expression overlap with S3.
Four object-operand files previously catalogued as red now exercise user
`valueOf` through the canonical coercion path and pass in both lanes:

- `postfix-decrement/S11.3.2_A2.2_T1.js`
- `postfix-increment/S11.3.1_A2.2_T1.js`
- `prefix-decrement/S11.4.5_A2.2_T1.js`
- `prefix-increment/S11.4.4_A2.2_T1.js`

| lane | after | run id |
| --- | ---: | --- |
| host GC | **4 / 4** | `20260811-201901` |
| standalone | **4 / 4** | `20260811-202024` |

That makes ten previously-red update-expression files verified green in both
lanes. The remaining S3 population covers other operators and stays open.

### Verification

- `issue-4208-update-to-number-ir`, `issue-4208-strict-eq-type-disjoint`,
  `issue-4204-module-var-widening`, and `issue-1379`: **58 / 58** tests.
- `pnpm run typecheck`: pass.
- `pnpm run check:ir-fallbacks`: pass; no unintended, post-claim, or
  module-level fallback increase.

Fresh whole-suite baselines contain 9,029 ES5 tests: standalone is 8,052 pass,
880 fail, 93 compile-error and 4 timeout; host GC is 7,218 pass, 1,760 fail and
51 compile-error. This change removes a verified ten-file update-expression
slice from that residue; this issue remains open for the rest of S3–S7 rather
than claiming the overall ES5 goal complete.

---

## S3/S7 first OrdinaryToPrimitive slice — 2026-08-11

Continued from the ready #4377 head on `origin/main@6c1117f8767e9b43ab9eefa0bd0084bf9c980a7d`,
fetched from the renamed canonical repository `loopdive/js2wasm` in the same
isolated worktree.

The first five S3/S7 crash cases shared a representation failure, not five
operator bugs. Test262's wrapper repeatedly declares one function-scoped
`var object` with different anonymous object shapes. Each declaration denotes
the same JS binding, but legacy allocation selected a different closed WasmGC
struct for every initializer; a later guarded assignment stored null when the
shapes disagreed, and unary/bitwise coercion dereferenced it.

The compatibility prepass now groups declarations by exact checker symbol and
widens only the bounded shape where all repeated initializers are method-only
`valueOf`/`toString` function literals and the binding has a coercive numeric
use. Those exact declarations and literals share the open object carrier. The
host bridge also treats its exact `__is_closure` classifier as authoritative
and wraps OrdinaryToPrimitive methods with the zero-argument dispatcher before
storing them.

### IR ownership boundary

The real Test262 wrapper is still deliberately legacy-owned: duplicate `var`
bindings are outside the current IR declaration model, and its unannotated JS
function expressions are outside the typed closure surface. It is therefore
reported as a selector rejection rather than falsely counted as IR coverage.

A focused typed source is genuinely IR-emitted in both lanes:

```ts
export function probe(): number {
  const object = { valueOf: function (): number { return 1; } };
  return +object;
}
```

The selector admits only zero-argument, explicitly typed `valueOf`/`toString`
function properties. From-AST lowering builds an open object through symbolic
`__new_plain_object`/`__extern_set` calls, packs the closure through the
canonical callable ABI, and lowers unary ToNumber as
`__to_primitive(value, null)` followed by `__unbox_number`. Runtime providers
are preregistered before Phase 3 for both host imports and the standalone native
object runtime. Mixed method/data objects remain a pre-claim rejection.

### Maintained-runner measurement

Node 25.9.0, Test262 `b363f29d3c43c626dc852744ad64a0b48a003693`,
maintained `pnpm run test:262` runner:

| lane | before | after | after run id |
| --- | ---: | ---: | --- |
| host GC | 0 / 5 | **5 / 5** | `20260811-205948` |
| standalone | 0 / 5 | **5 / 5** | `20260811-210129` |

The five previously crashing files are:

- `unary-plus/S11.4.6_A2.2_T1.js`
- `unary-minus/S11.4.7_A2.2_T1.js`
- `bitwise-not/S11.4.8_A2.2_T1.js`
- `bitwise-not/S9.5_A3.1_T4.js`
- `unsigned-right-shift/S9.6_A3.1_T4.js`

### Verification

- Focused host/standalone IR ownership, repeated-`var`, and selector-boundary
  suite: **6 / 6**.
- Related #4208 and object-method suites: **41 / 41**.
- `pnpm run typecheck`: pass.
- `pnpm run check:ir-fallbacks`: pass; no unintended, post-claim, or
  module-level fallback increase.

This is a five-file slice, not closure of S3/S7 or the ES5 goal. Relational,
addition, abstract-equality, Date/function operands, and wider
OrdinaryToPrimitive shapes remain to be measured and implemented.

---

## S4 closure — primitive-wrapper abstract equality (2026-08-13)

Base: exact `origin/main@81125e5e248847a5df94c3e2a3a20016782e1df4`,
with Test262 pinned at `b363f29d3c43c626dc852744ad64a0b48a003693` in
an isolated worktree.

### Re-grounded lever and root cause

The filed S4 population still reproduces exactly: eight standalone failures,
all host-pass, all reporting `illegal cast in __str_to_number()` through the
assembled Test262 harness. The files are `S11.9.1_A7.{2,3,4,5}.js` and
`S11.9.2_A7.{2,3,4,5}.js`. Six adjacent controls — A7.1, A7.6, and A7.7 for
both `==` and `!=` — pass in both lanes.

The compatibility-path defect occurs before the already-correct native
Object→ToPrimitive equality cascade. The early mixed-primitive shortcut asks
the checker whether an operand is a String/Boolean/Number; a real
`new String(...)` wrapper therefore enters the String shortcut from its static
type, even though its runtime `Type` is Object. Standalone then feeds the
wrapper externref directly to `__str_to_number`, whose `$AnyString` cast traps.

Wrapper equality now bypasses that static primitive shortcut. The typed
externref dispatcher receives the real operands and uses its existing
IsLooselyEqual sequence: detect exactly one Object, call canonical
`__to_primitive(value, default)`, then compare the resulting primitive through
the shared number/boolean/string carrier cascade. Host mode retains its
canonical `__host_loose_eq` wrapper route. Strict equality, wrapper identity,
and wrapper-vs-string behavior are unchanged.

### IR ownership boundary

As in the first S3/S7 slice, the full assembled Test262 module initializer is
still compatibility-owned because unrelated harness declarations are outside
the current module-init selector. The IR proof therefore uses a focused typed
source rather than claiming that the entire harness wrapper is IR-emitted.

The focused producer admits only a fresh ambient `Boolean`/`Number`/`String`
wrapper compared with `==`/`!=` to a proven Boolean or Number, in either operand
order. Constructor identity is checker-backed, the constructor argument must
already have its exact primitive family, and the current producer is limited to
the non-fast externref dynamic carrier. From-AST allocates the real wrapper via
`__new_Boolean`/`__new_Number`/`__new_String`, calls `__to_primitive`, boxes the
returned primitive and the concrete counterpart into the canonical dynamic
carrier, and emits `dyn.eq`. It does not compute the answer from AST shape.

Focused functions are genuinely IR-emitted in host and standalone, with no
post-claim errors; standalone has zero imports. Wrapper-vs-wrapper identity and
wrapper-vs-string remain pre-claim legacy boundaries, and local-variable
wrapper probes pin the compatibility fix independently of the fresh-wrapper IR
producer.

### Same-base A/B

The assembled-harness instrument proved both verdict directions before each
arm. Both arms contain the identical 14-file set, so the partition denominator
is exact.

| lane | before | after | gained | lost | unchanged |
| --- | ---: | ---: | ---: | ---: | ---: |
| host GC | 14 / 14 | **14 / 14** | 0 | 0 | 14 |
| standalone | 6 / 14 | **14 / 14** | **8** | 0 | 6 |

Standalone gained exactly:

- `language/expressions/equals/S11.9.1_A7.{2,3,4,5}.js`
- `language/expressions/does-not-equals/S11.9.2_A7.{2,3,4,5}.js`

The project-wide ES5 goal denominator is the full **9,029 tests in each lane**.
This bounded S4 result does not exclude eval, `Function`, `with`, or any other
ES5 category, and it does not claim closure of that full goal or of the remaining
S3/S5/S6/S7 operator families.

### Verification

- Maintained filtered Test262 runner: host GC **8 / 8**
  (`20260813-062253`) and standalone **8 / 8** (`20260813-062426`). The
  standalone filter used the supported interpreter eval provider because this
  machine lacks the `clang-18` required to build the default QuickJS provider;
  these eight equality files do not invoke eval. This does not narrow the full
  9,029-test ES5 target, and no full sweep is claimed here.
- Focused wrapper loose-equality IR ownership and legacy-boundary suite:
  **4 / 4**.
- Related wrapper/object OrdinaryToPrimitive suites: **19 / 19**.
- `pnpm run typecheck`: pass.
- `pnpm run check:ir-fallbacks`: pass; no unintended, post-claim, or
  module-level fallback increase.
