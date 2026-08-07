---
id: 4208
title: "Operator abstract-ops are lowered from the STATIC type: ToNumber / ToPrimitive / Type() are skipped for string, wrapper and `{valueOf}` operands — 59 ES5 files, `1 === true` answers true"
status: in-progress
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
language_feature: abstract-operations, value-representation
goal: es5
related: [3055, 4183, 4173, 2733, 3216, 3397, 4205, 4204]
assignee: ttraenkler/W27
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

## 6. Measurement

| arm | n | result |
| --- | --- | --- |
| base lever (59 filed files) | 59 | 0 pass / 59 fail; **59/59 agree with the standalone baseline** |
| head lever | 59 | **FIXED 6, BROKE 0** — exactly the 6 predicted `S11.9.4_A8_T{1,2,3}` / `S11.9.5_A8_T{1,2,3}` |
| base control (ALL 1,006 ES5 operator-family files the baseline calls `pass`) | 1,006 | 998 pass, **8 disagree** |

The 8 control disagreements are the `line-terminator-{carriage-return,line-feed,
line-separator,paragraph-separator}` ASI negative tests under
`postfix-increment`/`postfix-decrement`. They fail identically in *both* arms
and on unmodified base, so they are an instrument artifact of `runTest262File`
on parse-phase negatives, not a finding — but they are named here rather than
dropped, because a 0.8 % blind spot that is silently excluded is how a real
regression hides.

Unit coverage: `tests/issue-4208-strict-eq-type-disjoint.test.ts`, verified
two-sided by A/B against the pre-fix `binary-ops.ts` — **10 of 15 RED on base,
5 green on both arms**. Those 5 are the deliberate PRECONDITION set; `false` is
the answer the fold produces, so a disjoint-only suite would also pass an
implementation that folded *every* strict comparison.

## 7. Vacuous-pass conversions (no file regressed, but read this)

Two files changed **which assertion** they die on, because an assertion that
passed for the wrong reason now correctly fails:

- `postfix-increment/S11.3.1_A3_T1.js`: was `#2: new Boolean(true); x++` →
  now `#1: var x = false; x++; x === 0 + 1. Actual: true`
- `prefix-increment/S11.4.4_A3_T1.js`: same movement

On base, `x++` left `x` as the boolean `true`, and `true === 1` folded to
`f64.eq(1,1)` → **true**, so CHECK#1 passed while the update operator was
broken. Both files were already failing, so nothing flipped pass→fail — but
this is the mechanism by which a Number ⊥ Boolean fix can *unmask* S2 elsewhere
in the corpus. Any file whose only failure was masked this way flips pass→fail
and must be read as an honest conversion, not a regression.
