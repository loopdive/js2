---
id: 4668
title: "ES5 standalone: a property read on a number/boolean PRIMITIVE never walks the wrapper prototype chain — `(5).x` answers null (language/ bucket)"
status: done
completed: 2026-08-24
sprint: current
created: 2026-08-24
updated: 2026-08-24
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: property-access
goal: standalone-gap
assignee: ttraenkler/lane-language
loc-budget-allow:
  # CONSUMED by the shipped diff, not speculative. The local gate run on
  # 2026-08-24 satisfied this growth from #4491's grant instead — that grant
  # belongs to another lane's issue file, which this change-set does not touch,
  # so it is a STRANDED grant under CI's merge-preview base. Restated here.
  #   src/codegen/property-access.ts  +10  the arm's dispatch line (six lines)
  #                                        plus the comment that says why it
  #                                        sits immediately after #4483's arm
  #                                        and before the legacy tail — the
  #                                        position IS the design, since the two
  #                                        arms' gates are exact complements.
  #                                        The arm's body lives in its own new
  #                                        module, primitive-proto-member-get.ts.
  - src/codegen/property-access.ts
---

# Primitive receiver property read does not walk the wrapper prototype chain

`--target standalone`. Owner lane: the `language/` bucket of the ES≤5
conformance campaign (38 remaining rows as of 2026-08-24; 35 after this
change).

## Root cause

A property read whose receiver's static type is `number` or `boolean` never
reaches any boxing site. `compilePropertyAccess` runs its arm ladder, #4483's
`tryEmitPrimitiveAbsentPropertyRead` **declines** the moment the module writes
to `Number.prototype` / `Boolean.prototype` / `Object.prototype` (its fold's
premise is "this property is provably ABSENT", which such a write destroys),
and the read then falls through every arm of
`finalizeStructAndDynamicMemberGet` to its terminal
`fctx.body.push({ op: "ref.null.extern" })`. That placeholder is what the
program observes, and `typeof null === "object"` is what makes it visible.

The terminal also never compiles the receiver, so the read has **no side
effects at all** — which is the sharpest available discriminator and is what
the probes below use.

### Two axes, and the second one nearly shipped wrong

The issue was handed to this lane framed as the §10.4.3 primitive-`this` boxing
rule — "strictness × this-value-type" — with
`language/function-code/10.4.3-1-{103,104,106,17-s,83-s,84-s}` named as one
likely root. Half of that framing was wrong and half was right, and finding out
which half took a row that was not on the failing list.

**Wrong: it is not one root.** `103/104/106` share a root; `17-s` (direct-eval
`this` in a strict function) and `83-s`/`84-s` (a `Function(...)`-minted strict
function calling a global `this.f`) are two further, unrelated roots, untouched
by this fix. Their distinct error text — `TypeError: not a function` — was the
tell.

**Wrong: strictness is not what makes the three rows FAIL.** The axis the
probes had held fixed was the receiver's STATIC type. Same program, same
strictness, two receiver spellings:

| probe (`Object.defineProperty(Object.prototype,"x",{get(){…}})`) | receiver static type | getter ran? | value |
| --- | --- | --- | --- |
| `(5).x`                             | `number`   | **no** (`ran=0`) | `null` |
| `({}).x`                            | object     | yes (`ran=1`)    | `42`   |
| `function f(v){return v.x}; f(5)`   | `any`      | yes (`ran=1`)    | `42`   |
| `Object.prototype.z = 7; (5).z`     | `number`   | — (data prop)    | `null` |
| `Number.prototype.q = 9; f(5)`      | `any`      | —                | `9`    |

The `any`-typed rows are the load-bearing ones: **the runtime was already
correct.** `__extern_get` (`object-runtime.ts`) services a boxed-primitive
receiver — its chain-exhausted miss arm has been receiver-aware since
#4160/#4176 and consults the receiver's own brand companion before
`Object.prototype`'s. Only the static dispatch never got there.

**Right, and this is the part that nearly shipped broken: strictness decides
WHICH value the accessor sees.** A first cut of the arm always handed over the
raw primitive. It flipped all three failing rows and **regressed
`10.4.3-1-105`** — a row that was PASSING on the base *for the wrong reason*.
105 is `noStrict` and asserts `(5).x === 5` is false and `typeof (5).x` is
`"object"`; the base's `null` satisfies both. The four rows together pin all
four cells:

| row | flags      | asserts                              | accessor `this` must be |
| --- | ---------- | ------------------------------------ | ----------------------- |
| 103 | noStrict   | `(5).x == 5` true, `== 0` false      | either — blind to it    |
| 105 | noStrict   | `(5).x === 5` false, typeof "object" | **wrapper object**      |
| 104 | onlyStrict | `(5).x === 5`                        | **primitive**           |
| 106 | onlyStrict | `typeof (5).x` is "number"           | **primitive**           |

Two things follow that are worth more than the fix itself:

1. This is brief methodology 6 turned on its author. The probe table above
   varies receiver type and strictness and still could not see the defect,
   because every cell in it read a value through an assertion a `null` also
   satisfies. The cell that decided the answer was a row **outside the failing
   list**, reachable only by sweeping a scope wider than the bucket.
2. **A passing row is not evidence the behaviour is right.** 105 passed on the
   base by coincidence of `typeof null === "object"`. Any change in this area
   that reports "+3, 0 regressions" without sweeping the sibling rows is
   reporting an artifact of what it chose to look at.

## Fix

New leaf module `src/codegen/primitive-proto-member-get.ts`
(`tryEmitPrimitiveProtoMemberGet`), spliced into `compilePropertyAccess`
(`src/codegen/property-access.ts`) immediately after #4483's arm and before
`finalizeStructAndDynamicMemberGet`. It compiles the receiver, converts it, and
calls `__extern_get`. The conversion is where §10.4.3 lives:

| read site is | receiver becomes | helper |
| --- | --- | --- |
| sloppy code | a real wrapper `$Object` (`typeof` "object", ToPrimitive recovers the value) | `__new_Number` / `__new_Boolean` |
| strict code | the primitive carrier | `__box_number` / `__box_boolean` |

Strictness comes from `isStrictContext(expr, ctx.inferModuleStrictArguments)` —
the same flag `explicit-null-receiver.ts` uses, and the one that stops the
test262 harness's synthetic `export function test()` wrapper from reading every
sloppy script as strict module code (#2119). It is a **proxy**: §10.4.3 keys on
the strictness of the ACCESSOR, which a read site cannot know because the getter
is found by a runtime chain walk. The proxy is exact whenever the read and the
accessor share a strictness region, which is every corpus shape. See Residuals.

On the strict side the boolean BRAND still matters: `__box_boolean`, not
`__box_number`, is what makes the walk start at `Boolean.prototype`.

`src/codegen/primitive-absent-property.ts` changes only by exporting three
symbols it already had (`WRAPPER_CHAIN_MEMBERS`, `isWriteOrDeleteTarget`,
`moduleExtendsPrimitiveProtos`) so the two arms cannot drift apart; no logic
edit.

Narrowing (absent-not-wrong):

- standalone/WASI only;
- the **oracle** must prove the receiver is exactly `number`/`boolean`
  (`ctx.oracle.typeFactOf`; a boxed `new Number(1)` is an object type and never
  matches);
- `moduleExtendsPrimitiveProtos(sourceFile)` must be TRUE — the exact
  complement of #4483's gate, so where that arm can prove absence it keeps its
  cheap constant fold and this arm only takes the shapes it hands off. A module
  that touches no primitive prototype compiles byte-identically;
- `WRAPPER_CHAIN_MEMBERS` (`toFixed`, `valueOf`, `length`, …) keep their
  existing lowerings;
- not an assignment target, not a `delete` operand, and **not the callee of a
  call**. The callee case is a wrong-answer hazard rather than a missing one:
  the call lowering owns `this`-binding (measured working today —
  `Number.prototype.m = function(){return typeof this}; (5).m()` answers
  `"object"` on the base), and this arm can only hand back a bare function
  value;
- the result stays an honest `externref`; a numeric consumer re-narrows through
  its own coercion rather than dragging a getter's object result through
  `__unbox_number`.

## Test Results

All runs executed by this lane in
`/home/user/js2wasm/.claude/worktrees/agent-a49c2a090ec917818`, on 2026-08-24,
`runTest262File(…, "standalone")` with
`JS2WASM_EVAL_ENGINE=quickjs TEST262_FULL_RUNTIME_EVAL=1`, per-arm
`pnpm run build:compiler-bundle && node scripts/build-quickjs-eval-provider.mjs`
(the base arm's adapter key `f4f5b1dab5dbd655`, the final change arm's
`b8c074a3dda7224c` — different adapters, so neither arm was measured through
the other's). The box has 4 cores and three sibling lanes were sweeping
throughout; 1-min load averages are recorded per arm below, and **every flip and
every regression named here was re-verified serially**.

### The lane's own 38 rows (`.tmp/rows-language.txt`)

| arm | pass | fail | rows with a verdict | timeouts |
| --- | --- | --- | --- | --- |
| base (clean tree, `git diff HEAD --stat` empty) | 0 | 38 | 38 | 0 |
| with the fix | **3** | 35 | 38 | 0 |

Flips: `language/function-code/10.4.3-1-103.js`, `-104.js`, `-106.js`.
Regressions: 0. Rows whose status was unchanged but whose error text moved: 0.

A first `after` run had six rows reading `the quickjs provider is not built` —
an infrastructure failure, not a status. Those rows are excluded; both arms in
the table were run with the provider built for that arm.

### Scoped regression sweep — 408 rows, both arms

**Scope, and why it is the complete reachable set rather than a directory
guess.** The arm can only fire in a module whose source names
`Object.prototype` / `Number.prototype` / `Boolean.prototype`
(`moduleExtendsPrimitiveProtos` is a necessary condition). A plain text grep for
that is a strict SUPERSET of the AST condition, and over the campaign's 8,260
ES≤5 files it selects **375**. Union with this lane's own 38 rows = **408**.

Two things had to be checked for that argument to hold, and both were:

- the **harness** is prepended to every module, so a harness file that armed the
  gate would make the reachable set the whole corpus. `assert.js`
  (`Object.prototype.toString.call(v)`) and `propertyHelper.js`
  (`…bind(Object.prototype.hasOwnProperty)`) both name a prototype but neither
  matches the gate's shapes. The only harness file that DOES is `testIntl.js`
  (`taintDataProperty(Object.prototype, …)`), which is intl402-only.
- the sweep list therefore includes every `intl402` row that grep selected.

Directories NOT swept: everything outside that 408 — because the arm provably
cannot be reached there, not because it was expensive. No directory testing one
of this change's own fixes was dropped (`language/function-code` is in the list,
and it is where all three flips are).

| arm | rows | pass | fail | timeouts / driver errors | 1-min load during the run |
| --- | --- | --- | --- | --- | --- |
| base | 408 | 321 | 87 | 0 | 4.2 – 9.5 |
| with the fix | 408 | **324** | 84 | 0 | 4.9 – 8.6 |

- **Flips (+3):** `language/function-code/10.4.3-1-{103,104,106}.js`
- **Regressions: 0**
- **Same-status error-text changes: 0** — so no row "moved" without flipping
  either.

Both arms produced a verdict for all 408 rows with zero timeouts, so the
denominators are comparable despite the load. The four `10.4.3-1-10x` rows were
re-run **serially** on the final tree (load 4.6) and all four pass.

**The interim result this replaced is the finding, not a footnote.** An earlier
version of the arm measured `+3 / −1` on this same 408-row scope, the −1 being
`10.4.3-1-105`. That regression is what produced the strictness work above. Had
the sweep been scoped to the 38 failing rows, the change would have shipped as
"+3, zero regressions" while making a passing row wrong.

### Pins — `tests/issue-4668.test.ts`

13 tests, `13 passed (13)`, file line `(13 tests)` with no `skipped` suffix.
Reverted to the base (`git diff HEAD --stat` empty, module parked), the 7
behavioural pins of the first cut **all failed** and the 4 controls passed —
`7 failed | 4 passed (11)`. The sensitivity of the two later §10.4.3 pins is
established by `10.4.3-1-105` itself, which the first cut regressed.

No eval-tier arm is needed: the suite mints no module from a body string, so it
runs identically under `JS2WASM_EVAL_ENGINE=interpreter`.

### Gates

`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports` — all exit 0, run bare (not piped).
The LOC gate satisfies `property-access.ts`'s +10 from #4491's grant; since this
change-set does not touch that file, the grant is **restated in this issue's
frontmatter** so it is not stranded under CI's merge-preview base.

## Residuals

- **Mixed-strictness modules** — the accessor's strictness is approximated by
  the READ SITE's. A sloppy accessor reached from strict code (or the reverse)
  gets the wrong `this`. Not a regression — the base answered `null` for every
  one of these reads — and no ES≤5 corpus row exercises it, because test262's
  `onlyStrict`/`noStrict` variants are whole-file. The exact fix is per-function
  strictness carried on the closure and applied at the callee, which is a
  §10.4.3 change in the call machinery, not here.
- **JS-host / `gc` lane** — the arm is standalone/WASI-gated and the host lane
  was not measured. Whether the host path has the same terminal-null behaviour
  is open.
- **String primitive receivers** are out of scope: they have their own
  string-proto dispatch and #4483's table already recorded them answering
  `undefined` rather than `null`.

### Rows in this lane's bucket that belong to OTHER lanes

- `language/expressions/this/S11.1.1_A3.2.js` — `Object.prototype.toString is
  not yet implemented in --target standalone` (#4492 builtin-methods-as-values).
- `language/function-code/S10.2.1_A4_T1.js` — `Cannot access property on null
  or undefined at 325:6` (#4491 descriptor MOP / propertyHelper site).

Both were failing on base and on the fix arm with unchanged error text.

## Rooting of the rest of the `language/` bucket (not taken here)

Named so a successor does not start from zero. Every error string below is from
this lane's own base run.

Five roots cover 16 of the 35 remaining rows; the rest are singles.

| root | rows | evidence (test source + this lane's base error) |
| --- | --- | --- |
| **`with`-statement scope** — assignment target, closure capture, and `delete` | `statements/function/S13.2.2_A18_T{1,2}`, `statements/function/S13.2.2_A19_T8`, `statements/with/S12.10_A5_T5` | `with (arguments) { callee = 1 }` must write the WITH object's property, not the outer `var callee` (base: `callee === 1`). `with(__obj){ var __func = function(){return b} }` must capture the `with` scope (base: `__func()` answers `a`, the outer binding). `eval("with(myObj){del = delete p1}")` must delete off the `with` object. |
| **direct-eval scope interaction** | `expressions/assignment/S11.13.1_A6_T{1,2}`, `expressions/object/11.1.5-0-{1,2}`, `function-code/10.4.3-1-17-s`, `types/reference/8.7.2-1-s` | `x = (eval("var x;"), 1)` must use the Reference created BEFORE the eval-minted binding (base writes the inner one). `eval("o = {get foo(){…}}")` then `o.foo` answers **`null`** — the SAME terminal `ref.null.extern` this issue removes for primitives, on an eval-minted-object receiver. `eval("typeof this")` in a strict function must be `"undefined"`. Strict `eval("_x = 11")` must throw ReferenceError. Runtime-eval goal. |
| **arguments-object representation** | `statements/function/S13_A15_T3`, `S13_A2_T2`, `arguments-object/S10.6_A5_T4` | a PARAMETER named `arguments` must shadow the arguments object (base returns the object). `(function(arg){return arg + arguments[1]})(1,"1")` must be `"11"`; base answers `2`, i.e. `arguments[1]` was read at the first parameter's numeric representation and the string `"1"` became `1`. Adjacent to #4667 (`arguments-array-identity-vec-shared-rep`) — worth routing to that owner. |
| **catch-binding scope** | `statements/try/12.14-7`, `S12.14_A18_T6`, `annexB/…/catch-redeclared-var-statement` | after the catch block, the catch parameter must be unresolvable; base: referencing it does not throw, so the binding leaks to function scope. |
| **`var` hoisting** — two distinct mechanisms | `identifier-resolution/S10.2.2_A1_T3`, `types/boolean/S8.3_A1_T1` | (a) `var x = 1` AFTER a `return` must still create the function's binding, so a nested function reads `undefined` and not the outer `0`. (b) reading `x` before `var x = true` answers **`false`**, not `undefined` — an inferred-boolean local default-initialised to its i32 zero rather than the undefined carrier. The binding exists in (b); only its pre-init VALUE is wrong. |

Singles, rooted where the source made it cheap:

- `expressions/instanceof/S11.8.6_A2.4_T1` — `(OBJECT = Object, {}) instanceof OBJECT` with `var OBJECT = 0`: the RHS must be re-read at runtime, base resolves it from the declared numeric binding. `S11.8.6_A6_T4` and `S15.3.5.3_A3_T2` are the other two `[[HasInstance]]` rows.
- `expressions/in/S8.12.6_A2_T2` — `"phylum" in obj` where `Robin.prototype = {…}`: `__extern_has` does not walk a fnctor prototype reassigned to an object literal. This is the `has` twin of the `get` walk this issue fixes; the #4639/#4643 fnctor-prototype family.
- `types/object/S8.6.2_A8` — `x.__proto__ = y` on a `preventExtensions` object mutates the prototype; the `__proto__` setter ignores `[[Extensible]]`.
- Not rooted: `expressions/call/11.2.3-3_8`, `expressions/assignment/{8.12.5-3-b_1,S8.12.5_A2}` (the latter traps: `dereferencing a null pointer in __str_concat()`), `statements/function/{13.2-18-1,S13.2.2_A17_T3,S13.2.2_A2}`.

## Refuted here

- "The six §10.4.3 rows are one root." They are three.
- "The deciding axis is strictness × this-value-type." It is the receiver's
  static type; strictness is not observable on any of the three rows fixed.
- "`__extern_get` cannot service a primitive receiver." It can, and does — the
  `any`-typed probes prove it on the unmodified base.
- This lane's own first hypothesis, "the getter is invoked with a `null`
  `this`". Refuted by a counter in the getter: `ran=0` — it is not invoked.
- This lane's own second claim, "strictness decides nothing here, so all three
  rows flip without any §10.4.3 work". Refuted by `10.4.3-1-105`, which the
  first cut regressed. The claim was true of the rows it was checked against and
  false of the family; it survived because it was only ever tested on the cells
  that were already failing.

## Closed by the lead (2026-08-24) — successors named

§10.4.3 primitive-receiver reads are fixed (+3: `10.4.3-1-{103,104,106}`, 0 regressions).
`done` rather than `in-review`: I am the merger.

The rooting of the rest of the `language/` bucket above is NOT dropped — it is carried
forward by **[#4671](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4671-language-scope-roots-with-eval-catch-var)**
(`with` scope · direct-eval scope · catch-binding leak · `var` hoisting), which points back
at the table here rather than duplicating it. The arguments-object rows were routed to
**#4667**, and `expressions/in/S8.12.6_A2_T2` to the #4639/#4643 fnctor-prototype family,
both per this lane's recommendation.
