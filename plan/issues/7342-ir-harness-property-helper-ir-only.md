---
id: 7342
title: "IR: the test262 `propertyHelper.js` harness compiles with zero legacy units"
status: ready
sprint: current
created: 2026-11-13
updated: 2026-11-13
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7338, 7339, 7341, 7277, 7119, 7260, 4612, 7106]
---

# #7342 — IR: `propertyHelper.js` with zero legacy units

## Problem

Program goal: every ES5 test262 file compiles on `--target standalone` with
zero legacy units ("IR-only": no function and no `<module-init>` falls back to
the direct AST compiler).

Census of 2026-11-11 (main `7ce9bc8fbf`, 8,591 ES5 files compile, 1,505
IR-only, 7,086 blocked; file
`scratchpad/es5-map-1111/per-file.jsonl`): **899 blocked files include
`harness/propertyHelper.js`, and in all 899 the harness's own functions are
legacy units.** No file that includes this harness can be IR-only, whatever
the test body does. It is the largest single-source blocker in the census:

| harness file | blocked files carrying it | units that fall back |
| --- | --- | --- |
| `propertyHelper.js` | 899 | `verifyProperty`, `isWritable`, `verifyCallableProperty`, `verifyAccessorProperty`, `verifyEqualTo`, `verifyWritable`, `verifyNotWritable`, `verifyPrimordialCallableProperty`, `verifyPrimordialAccessorProperty`, `<module-init>` |
| `assert.js` | 716 | out of scope here, see "Not in this issue" |
| `sta.js` | 555 | out of scope here |

Greedy cover over the census reasons (fix the reason that frees the most
files, repeat): `propertyHelper.js` is step 27 and frees **631** files at that
point, the largest single step in the whole ordering. It is a ceiling, not a
first step: those files also carry `expr-ident-not-in-scope(Object)` (#7338),
`expr-object-define-property-target` (#7338), `.hasOwnProperty` (#7339) and
others. The value of this issue is that it removes the ceiling.

### What refuses, measured

Compiled on main `636331310e` with `JS2WASM_IR_SHAPE_DIAG=1
JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`, standalone, original harness, on
`built-ins/Object/preventExtensions/15.2.3.10-3-8.js`,
`built-ins/Object/defineProperty/15.2.3.6-4-613.js`,
`built-ins/Object/prototype/propertyIsEnumerable/S15.2.4.7_A10.js` and
`harness/verifyProperty-value-error.js`. The refusals are the same in all
four, because the harness source is the same:

| # | unit | refusal | source |
| --- | --- | --- | --- |
| R1 | `verifyProperty` | `vardecl-module-binding-alias` | `var originalDesc = __getOwnPropertyDescriptor(obj, name);` |
| R2 | `isWritable` | `vardecl-module-binding-alias` | `var unlikelyValue = __isArray(obj) && name === "length" ? nonIndexNumericPropertyName : "unlikelyValue";` |
| R3 | `verifyCallableProperty` | `expr-logical-value-family` | `options && options.verifyProperty \|\| verifyProperty` |
| R4 | `verifyAccessorProperty` | `param-type-unresolved(desc)` | parameter `desc` |
| R5 | `verifyEqualTo` | `param-dynamic-carrier-diverges-from-legacy` | parameter `value` |
| R6 | `verifyPrimordialCallableProperty` | `param-dynamic-carrier-diverges-from-legacy` | parameter `options` |
| R7 | `verifyPrimordialAccessorProperty` | `param-dynamic-carrier-diverges-from-legacy` | parameter `desc` |
| R8 | `verifyNotWritable` | `param-dynamic-carrier-diverges-from-legacy` (parameter `obj`) or `move-only[dyn]` (`name`), depending on the test's call sites | |
| R9 | `verifyWritable`, sometimes `verifyNotWritable` | `call-graph-closure` | derived: they call a refused unit |
| R10 | `<module-init>` | `expr-ident-not-in-scope(Function)` and the aliases at lines 27–35 | `var __join = Function.prototype.call.bind(Array.prototype.join);` etc. |

Each row is the FIRST refusal of its unit. A unit that passes its first
refusal can hit a second one; the plan measures that before any code is
written (S0).

### Why the parameter rows refuse

`param-dynamic-carrier-diverges-from-legacy` is not a missing lowering. The
IR and the legacy compiler share one function signature per top-level
declaration, and legacy infers each implicit-`any` parameter's Wasm type from
the call sites (`makeIrDynamicCarrierDivergenceProbe`,
`src/codegen/fnctor-typed-instances.ts:199`): a number at every call site
gives `f64`, an object literal gives a struct reference, a string a
non-null string reference. The IR would use the dynamic carrier
(`externref`), which does not match, so the selector declines up front
(`src/ir/select.ts:2821`) instead of claiming and failing the parity check.
#7277 already lets the IR adopt legacy's refined slot when it is `f64` or
`ref $AnyString`. Everything else declines.

So R5–R8 are one problem: **who owns the signature of a function whose every
caller and whose body are compiled by the IR.**

## Not in this issue

- `assert.js` (716 files) and `sta.js` (555 files). Their refusals are a
  different family: `Test262Error` refuses as
  `return-type-unresolved(lattice=dynamic)` (a constructor function called
  with and without `new`), and `assert` / `compareArray` refuse with
  `expr-ident-not-in-scope(assert)`; in eval-using files the helpers are
  withdrawn by the runtime-eval boundary (`late-preparation-unsupported`).
  They get their own issue once S0 here shows how much of the 899 they still
  hold back.
- The `Object` statics table (#7338), own-property methods (#7339),
  `new Object()` (#7341): different refusals in the test bodies.

## Implementation Plan

Order: S0 (measure) → S1 → S2 → S3 → S4. Each slice is its own PR. No slice
may change JS-environment (default target) output bytes, and no slice may
turn a unit that main lowers through the IR into a legacy unit.

### S0 — measure the second-order refusals (no product code)

The table above lists only the first refusal per unit. Before designing S1–S4
in detail, stub each first refusal in turn (a local, uncommitted change that
makes the selector answer "yes" at exactly that site for exactly that
harness unit) and record what the unit refuses next, and whether from-ast can
lower the body at all. Do this on the four files above plus 30 files sampled
from the 899 (seeded shuffle, seed 7342).

Deliverable, written into this file under "S0 results": for each of the nine
units, the full ordered list of refusals until the unit is claimed and built,
or the build error that ends the chain. If the chain for one unit is longer
than three steps, split that unit into its own follow-up issue rather than
growing a slice.

Also record, for the 899 files, how many have a legacy unit ONLY from
`propertyHelper.js` once #7338's and #7339's labels are discounted (label
overlap from the census, not a re-run): that is the real yield of this issue
when those land.

### S1 — the stored-builtin aliases (R1, R2, R10)

`propertyHelper.js` lines 27–35 store builtins in script vars and calls them
later: `__isArray`, `__defineProperty`, `__getOwnPropertyDescriptor`,
`__getOwnPropertyNames`, and four `Function.prototype.call.bind(...)` forms
(`__join`, `__push`, `__hasOwnProperty`, `__propertyIsEnumerable`).

Target structure:

- One module owns "a script var that is a certified alias of a builtin":
  `certifiedAliasCall` already exists and is used in
  `src/ir/select.ts` (~7325) for exactly this. Extend its certificate, do not
  add a second recogniser. Read `certifiedAliasCall` and its callers first and
  list in the PR which alias forms it certifies today.
- New certificate rows, as data: `Array.isArray`,
  `Object.getOwnPropertyDescriptor`, `Object.getOwnPropertyNames`,
  `Object.defineProperty` (these reuse the #7338 table's plans once #7338 is
  on main — if #7338 has not landed, S1 covers only `Array.isArray` and the
  call-bind forms and says so), and the call-bind form
  `Function.prototype.call.bind(<Builtin>.prototype.<method>)` for the four
  methods the harness uses, lowered as the direct method call on the first
  argument.
- R1 and R2 then stop being "an alias of a tracked module value": the
  initialiser is a call through a certified alias, which
  `vardecl-module-binding-alias` already exempts (`certifiedAlias` in the
  same function).
- R10: `<module-init>` must admit the alias declarations themselves. Check
  whether `Function` as an identifier is needed at all once the call-bind
  form is recognised as a whole expression; if it is, that is a refusal to
  lift only for this exact expression shape.

Reuses: `certifiedAliasCall`, the #7338 statics table. Removes: nothing.
Refuse at select anything the certificate does not cover; a rebinding of the
alias var anywhere in the file (assignment, `eval`, `with`) voids the
certificate — #7214's review found exactly this bug for a user-declared
`Object`, use `isUnshadowedLibBinding` / `sourceWritesMemberNamed`.

Acceptance: `verifyProperty` and `isWritable` no longer refuse at R1/R2;
`<module-init>` no longer refuses on lines 27–35; a test row per alias form,
each compared with node; rows where the alias var is reassigned stay refused.

### S2 — the logical value form (R3)

`options && options.verifyProperty || verifyProperty` refuses in
`src/ir/select.ts:12484` because the operands are neither both boolean nor
"dynamic logical value operands" (`dynamicLogicalValueOperands`).

Read `dynamicLogicalValueOperands` and state in the PR which operand kinds it
admits. The missing case is: left side a dynamic value (a parameter or a
member read of one), right side a reference to a top-level function. The
result is a dynamic value. Extend `dynamicLogicalValueOperands` for that
case; do not add a new arm. The consumer in the harness is a call through the
resulting local (`propertyVerifier(obj, name, ...)`), which is
`expr-local-call-target` territory: S0 tells whether that is the next
refusal. If it is, S2 includes the call through a dynamic local whose only
possible values are top-level functions of the same arity, or it stops at
the measured boundary and files the rest.

Acceptance: R3 gone; rows for `a && a.p || f`, `a || f`, `a && f`, with `a`
undefined, null, an object without `p`, an object with `p`; compared with
node.

### S3 — the unresolved parameter (R4)

`verifyAccessorProperty(obj, name, desc, options)`: `desc` resolves to no
type at all (`param-type-unresolved(desc)`, `src/ir/select.ts:2332`), which
means the lattice entry is neither a primitive, `unknown` nor `dynamic` — a
`union`, per the comment at `select.ts:2811` ("Lattice `union` stays null:
#2135's union rows own that shape"). Confirm with a dump of the TypeMap entry
for this parameter in S0. If it is a union of object shapes, the honest
carrier is the dynamic one; the change is to let a union of reference shapes
resolve to `dynamic` when S4's signature rule holds, and nowhere else.

### S4 — signature ownership (R5–R8, R9 follows)

This is the structural slice and needs a design decision before code. Two
options; S0 supplies the numbers to choose:

- **Option A — the IR adopts legacy's slot.** Extend `legacyRefinedParamSlot`
  (`src/codegen/fnctor-typed-instances.ts`) beyond `f64` / `ref $AnyString`
  to every slot kind the IR can name (bool, a vec, a struct reference), so
  the IR parameter has legacy's type. Cheap per case, but each slot kind
  needs the IR body to operate on that type, and the docblock on
  `legacyRefinedParamSlot` says the current filter is load-bearing.
- **Option B — the IR owns the signature when it owns every use.** If the
  function's body is IR-claimable with dynamic parameters AND every call site
  of the function in the module is in a unit the IR claims, the signature is
  registered with the dynamic carrier and legacy's call-site inference for it
  is not consulted. Callers box at the call. This removes the parity question
  for whole-program-IR files, which is the program goal, and leaves mixed
  files exactly as they are.

Recommendation: Option B, because it converges with the goal (in an IR-only
file there is no legacy caller to stay compatible with) and does not grow a
per-slot-kind case list. Its cost is an ordering problem: "every caller is
IR-claimed" is known only after selection, and the divergence probe runs
during selection. The plan for B:

1. Find where the selector already iterates to a fixed point for
   `call-graph-closure` (a unit is withdrawn when a callee is refused). The
   signature rule joins that iteration: a function with a
   dynamic-carrier-divergent parameter is provisionally claimable; it is
   withdrawn if any caller ends up legacy. State the termination argument in
   the PR (the claimed set only shrinks).
2. The signature registration (`ctx.funcMap` / the declaration pre-pass) must
   then register the dynamic-carrier type for provisionally claimed functions
   that survive. Identify the single place that registers a top-level
   function's type and make the choice there; no second registration path.
3. Exported functions and functions whose reference escapes as a value keep
   legacy's signature (an outside caller exists).

Either option: JS-environment bytes identical; a differential set of files
with no `propertyHelper.js` include must keep main's unit routing exactly.

Acceptance for S4: R5–R8 gone on the four sample files; R9 gone as a
consequence; the 34-file S0 sample has zero legacy units from
`propertyHelper.js`; verdicts unchanged on those files
(`run-test262-paths.mts --standalone`, both trees).

### Code-quality acceptance (all slices)

- No new recogniser where `certifiedAliasCall`, `dynamicLogicalValueOperands`
  or the #7338 table can be extended; new table rows are data.
- New selector code goes in a sibling module with hooks (the shape of
  `select-expression-structure.ts`), not into `select.ts`; no size grant for
  `select.ts`.
- Refuse at select; a unit that is claimed must build. Zero post-claim errors
  on the S0 sample and on a 300-file IR-only sample.
- No harness-name special cases: nothing may key on the strings
  `verifyProperty`, `propertyHelper` or a file name. The harness is the
  motivating input; the rules are general JavaScript rules.
- Each PR gets a fresh-context adversarial review before release, with the
  verdict recorded in the PR body.

## S0 results (2026-11-13)

### Method

- **Tree:** main `68b95c2869`, standalone, original harness.
- **Settings:** `JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`.
- **Tool:** the census script from #7338. It records per-unit code and detail, the claimed units, and post-claim errors.
- **Sample:** 34 files: the four named above, plus 30 drawn from the 899 by a seeded shuffle (mulberry32, seed 7342).
- **Chain walk:** done on an 8-file subset, then confirmed with all stubs stacked on all 34 files. The subset is:
  - the four named files;
  - `15.2.3.6-4-547-2.js` and `S15.5.4.15_A10.js`;
  - `harness/propertyhelper-verifywritable-not-writable.js`;
  - `harness/propertyhelper-verifyconfigurable-configurable-object.js`.
- **Harness-only check:** a synthetic file that includes only `propertyHelper.js`, with a one-line body, isolates the harness's own `<module-init>`.
- **Stubs:** local and uncommitted. Each answered "yes" at one select site, for one unit, matched by source text. A class of identical refusals within one unit (for example six `names[i] === "…"` reads) counts as one step.
- **Exploratory runs:** where a chain passed six steps, one extra run admitted every `move-only` and external-call refusal of that unit at once, to reach from-ast. Those rows are marked "exploratory".
- **Line numbers:** `test262/harness/propertyHelper.js` in the repo's test262 checkout.

### Baseline: first refusal per unit (34 files)

The table at the top of this issue is out of date on current main. **R1 and R2 no longer refuse.** `isWritable` is IR on all 34 files, and `verifyProperty` now first refuses at line 106.

| unit | IR / legacy | first refusal (count) |
| --- | --- | --- |
| `verifyProperty` | 0 / 34 | `expr-binary-operand-families`: `desc.enumerable !== isEnumerable(obj, name)` (l.106) |
| `isWritable` | 34 / 0 | none |
| `verifyCallableProperty` | 0 / 34 | `expr-logical-value-family` (l.228) |
| `verifyAccessorProperty` | 0 / 34 | `param-type-unresolved(desc)` |
| `verifyEqualTo` | 0 / 34 | `param-dynamic-carrier-diverges-from-legacy` on `value` (28); `move-only[dyn]` on `obj[name]` (6, l.388) |
| `verifyNotWritable` | 31 / 3 | `move-only[dyn]` on `name` (2); `param-dynamic-carrier-diverges-from-legacy` on `obj` (1) |
| `verifyWritable` | 27 / 7 | `move-only[dyn]` on `name` (7) |
| `verifyPrimordialCallableProperty` | 0 / 34 | `param-dynamic-carrier-diverges-from-legacy` on `options` |
| `verifyPrimordialAccessorProperty` | 0 / 34 | `param-dynamic-carrier-diverges-from-legacy` on `desc` |
| `verifyConfigurable`, `verifyNotConfigurable` | 33 / 1 | `move-only[dyn]` on `name` |
| `<module-init>` | 0 / 34 | `expr-ident-not-in-scope(Function)` ×4 (l.31–34) and `expr-ident-not-in-scope(verifyProperty)` (l.469 `var verifyPrimordialProperty = verifyProperty`). Lines 27–30 and 35 do not refuse. |

No post-claim errors in the baseline. R9 (`call-graph-closure`) does not occur in the sample.

### Chains, per unit

**`verifyProperty`: longer than 6.** Exploratory end: from-ast fails.

| step | refusal | construct (line) |
| --- | --- | --- |
| 1 | `expr-binary-operand-families` | `desc.enumerable !== isEnumerable(obj, name)` (106) |
| 2 | `move-only[dyn]` | `assert.notSameValue(desc, null, …)` (68) |
| 3 | `move-only[concrete]` | `names[i] === "value"` and its five siblings (83–) |
| 4 | `move-only[concrete]` | `label + "… should be " + String(desc.value)` (97–) |
| 5 | `move-only[concrete]` | `desc.enumerable !== undefined` and the siblings (104–) |
| 6 | `move-only[dyn]` | `__join(failures, '; ')` (128) |
| expl. | `external-call` | `__join(failures, '; ')`, the only external callee |
| expl. | from-ast | `empty array 'failures' escapes before its element type is closed` (`var failures = []`, l.93, passed to `__push` / `__join`) |

The exploratory run admitted 25 distinct `move-only` sites in six classes, then the `__join` call edge.

**`verifyCallableProperty`: longer than 6.** Exploratory end: from-ast fails.

| step | refusal | construct (line) |
| --- | --- | --- |
| 1 | `expr-logical-value-family` | `options && options.verifyProperty \|\| verifyProperty` (228) |
| 2 | `expr-ident-not-in-scope` | `verifyProperty` as a value (228) |
| 3 | `expr-local-call-target` | `propertyVerifier(…)` (249, 263, 275) |
| 4 | `move-only[dyn]` | the same logical expression (228) |
| 5 | `move-only[concrete]` | `desc = { writable: true, … }` (239) |
| 6 | `move-only[concrete]` | `desc.value = value` (246) |
| expl. | `external-call` | the three `propertyVerifier(…)` calls |
| expl. | from-ast | `identifier "verifyProperty" is not in scope in verifyCallableProperty`: a top-level function used as a value has no lowering |

**`verifyAccessorProperty`: longer than 6.** Not run to from-ast.

| step | refusal | construct (line) |
| --- | --- | --- |
| 1 | `param-type-unresolved(desc)` | JSDoc `{object}` plus nested `@param [desc.*]` tags (see R4) |
| 2 | `expr-logical-value-family` | `checkGet \|\| checkSet` (308), then l.312 |
| 3 | `expr-ident-not-in-scope` | `verifyProperty` as a value (312) |
| 4 | `expr-ident-not-in-scope` | `verifyCallableProperty` as a value (313) |
| 5 | `expr-local-call-target` | `callabilityVerifier(…)`, `propertyVerifier(…)` |
| 6 | `objectlit-empty` | the `{}` argument of `callabilityVerifier(originalDesc, "get", …, {}, …)` (347) |

**`verifyEqualTo`: 1 step, then the signature parity check (S4).**

| step | refusal | construct |
| --- | --- | --- |
| 1 | `param-dynamic-carrier-diverges-from-legacy` | `value`: legacy slot `f64` (28 files) |
| end | post-claim | `function typeIdx parity mismatch … keeping legacy body`: the IR signature is all-externref, legacy's has `f64` for `value` (28/28) |

In the 6 files where `value` is externref, the only refusal is `move-only[dyn]` on `obj[name]` (l.388). Once that is admitted, the unit is claimed and builds (6/6). The `move-only` scan refuses something from-ast can lower.

**`verifyNotWritable` (3 legacy files):**

- `name` (2 files): `move-only[dyn]` on `name`, then claimed and built.
- `obj` (`15.2.3.10-3-8.js`, legacy slot `ref $__Date`): `param-dynamic-carrier-diverges-from-legacy`, then `move-only[dyn]` on `verifyProp` (l.411), then post-claim parity mismatch.

**`verifyWritable` (7) and `verifyConfigurable` / `verifyNotConfigurable` (1):** `move-only[dyn]` on `name`, then claimed and built.

**`verifyPrimordialCallableProperty`: longer than 6.**

| step | refusal | construct (line) |
| --- | --- | --- |
| 1 | `param-dynamic-carrier-diverges-from-legacy` | `options`: legacy slot `ref_null $__anon_1` |
| 2 | `vardecl-module-binding-alias` | `var resolvedOptions = { verifyProperty: … : verifyPrimordialProperty }` (479) |
| 3 | `expr-module-value-conditional-mismatch` | `options && … !== undefined ? options.verifyProperty : verifyPrimordialProperty` |
| 4 | `move-only[concrete]` | the `resolvedOptions` object literal |
| 5 | `move-only[concrete]` | `options.label !== undefined` (484) |
| 6 | `move-only[stmt]` | `return verifyCallableProperty(…)` (487). Still refused after every expression-level `move-only` and external call was admitted; the callee is a legacy unit. |

**`verifyPrimordialAccessorProperty`: longer than 6.** The same shape:

1. `desc` diverges (`ref $__anon_2`);
2. `options` diverges;
3. `vardecl-module-binding-alias` (498);
4. `expr-module-value-conditional-mismatch`;
5. `verifyPrimordialCallableProperty` as a value;
6. `move-only[concrete]` on the object literal.

It then ends at `move-only[stmt]` `return verifyAccessorProperty(…)` (509).

**`<module-init>` (harness part): 2 steps, then from-ast fails.**

| step | refusal | construct (line) |
| --- | --- | --- |
| 1 | `expr-ident-not-in-scope(Function)` | `Function.prototype.call.bind(…)` (31–34) |
| 2 | `expr-ident-not-in-scope(verifyProperty)` | `var verifyPrimordialProperty = verifyProperty` (469) |
| end | from-ast | `identifier "Function" is not in scope in <module-init>` (synthetic harness-only file) |

In the 34 real files, the test bodies keep `<module-init>` legacy after these steps: `Object`, `Object.defineProperty`, `String`, `Test262Error`, closures and IIFEs.

### R4: `verifyAccessorProperty(desc)`

This is not a lattice `union`. Measured:

- The TypeMap entry is `{"kind":"dynamic"}`.
- `effectiveIrParamTypeNode` returns a `JSDocTypeLiteral`. TypeScript builds it from `@param {object} desc` plus the nested `@param [desc.enumerable]`, `[desc.configurable]`, `[desc.get]`, `[desc.set]` tags.
- `resolveParamType` accepts only a `TypeLiteral`, a `TypeReference` or an `ArrayType`, so the result is `null`.
- `jsDocParamLowersAsExternref` answers `false`: legacy registers `desc` as `ref $__anon_2`, a struct built from that JSDoc literal.
- The divergence probe answers `true`.

So R4 is the same signature problem as R5–R8. The only difference is that the JSDoc type literal is not recognised. S3's premise ("a union of object shapes") is wrong.

### R5–R8: legacy slots and where they come from

| parameter | legacy slot (files) | origin |
| --- | --- | --- |
| `verifyEqualTo(value)` | `f64` (28), externref (6) | All 28 `f64` files have **no call site** of `verifyEqualTo`. The synthetic harness-only file gets `f64` too. So this is not call-site inference, and where the `f64` comes from was not traced. The 6 externref files each call it from the test body with a call result as `value`. |
| `verifyPrimordialCallableProperty(options)` | `ref_null $__anon_1` (34) | `@type {typeof verifyCallableProperty}`: legacy lowers the JSDoc object type of `options`. No call site in any sample file. |
| `verifyPrimordialAccessorProperty(desc)` (and `options`) | `ref $__anon_2` (34) | `@type {typeof verifyAccessorProperty}`, the same mechanism. No call site. |
| `verifyNotWritable(obj)` | `ref $__Date` (1) | The test body calls it with a `new Date(0)` var. |
| `verifyAccessorProperty(desc)` | `ref $__anon_2` (34) | Its own JSDoc literal. Its only caller is `verifyPrimordialAccessorProperty`. |

`fnctor=false` everywhere: no fnctor-instance slot is involved.

### Every caller claimed (Option A vs B)

Caller units are counted as claimed if they were IR in the baseline, or are harness units.

| function | files with every caller claimed / 34 | of which: no caller at all |
| --- | --- | --- |
| `verifyEqualTo` | 28 | 28 |
| `verifyNotWritable` | 31 | 31 |
| `verifyPrimordialCallableProperty` | 34 | 34 |
| `verifyPrimordialAccessorProperty` | 34 | 34 |
| `verifyAccessorProperty` | 34 | 0 (its only caller is the harness's `verifyPrimordialAccessorProperty`) |

Every file where a test-body caller exists (6 for `verifyEqualTo`, 3 for `verifyNotWritable`) has that caller in a legacy `<module-init>`.

So Option B's condition holds in every file where the function is uncalled, or called only from the harness. There, the legacy signature is a default or JSDoc artifact with no caller to stay compatible with. Where a test body calls the function, B needs `<module-init>` to be IR first.

### Label overlap (census 2026-11-11, no re-run)

The census attributes `expr-ident-not-in-scope(Function)` to `<module-init>` without the harness label, but it is lines 31–34 of this harness, present in all 899 files. It is counted as harness here.

- Files whose only legacy reasons are `harness:propertyHelper.js` plus that `Function` label: **12**.
- The same plus only the #7338/#7339 labels (`expr-ident-not-in-scope(Object)`, `expr-object-define-property-target`, `expr-module-scalar-method(.hasOwnProperty)`, `expr-array-method-not-lowerable(.hasOwnProperty)`): **229**. This is the real yield once those land, against the 631 of the greedy step.
- Top 15 other co-reasons in the 899:

| count | reason |
| --- | --- |
| 175 | `vardecl-module-storage-unrepresentable[empty-array]` |
| 154 | `vardecl-let-closure` |
| 89 | `body-exprstmt-other(expr-call-callee-nonident)[IIFE]` |
| 83 | `harness:assert.js` |
| 72 | `harness:fnGlobalObject.js` |
| 72 | `expr-call-callee-nonident[Function()]` |
| 50 | `harness:sta.js` |
| 43 | `move-only[concrete] {fn}` |
| 39 | `objectlit-ordinary-to-primitive-mixed` |
| 33 | `expr-new-module-binding-callee` |
| 33 | `expr-call-callee-nonident[IIFE]` |
| 32 | `expr-ident-not-in-scope(global)` |
| 32 | `vardecl-module-storage-unrepresentable[object-literal]` |
| 31 | `expr-local-call-target` |
| 28 | `vardecl-module-storage-unrepresentable[array-literal]` |

- The census also shows two sub-populations the random sample did not hit: 83 files with `late-preparation-unsupported` (runtime-eval boundary) and 39 with `constructor-resolution-unsupported`. Two of them were compiled on `68b95c2869`. There every harness function refuses differently: `expr-new-ctor-unknown(Test262Error)`, and `expr-ident-not-in-scope(assert)` in `verifyProperty`. Those files depend on `assert.js` / `sta.js` first.

### What this means for S1–S4

- **S1 is smaller than planned.** R1 and R2 are gone on main. What remains:
  - the call-bind aliases at lines 31–34;
  - `__join` / `__push` with an empty array (`verifyProperty`'s from-ast end);
  - `var verifyPrimordialProperty = verifyProperty` (l.469).

  From-ast must lower `Function.prototype.call.bind(…)` too, not just the selector.
- **A new cross-cutting slice is needed: "a top-level function used as a value".** It shows up in four units: `verifyCallableProperty`'s and `verifyAccessorProperty`'s logical defaults, `<module-init>` l.469, and the `resolvedOptions` object literals. The calls through the resulting locals (`expr-local-call-target`) belong to the same slice. It underlies S2. S2 alone (extending `dynamicLogicalValueOperands`) unblocks one step of one unit.
- **The `move-only` scan is the longest tail.** `verifyProperty` needs 25 sites in six classes:
  - strict compare of a dynamic member read with a literal or `undefined`;
  - string concatenation with `String(dynamic)`;
  - a dynamic argument to `assert.*`.

  In `verifyEqualTo`, `verifyWritable`, `verifyNotWritable` and `verifyConfigurable`, admitting `move-only[dyn]` on a parameter or `obj[name]` gave a unit that from-ast built. So the scan is stricter than the lowering there. This needs its own issue; it is not in S1–S4.
- **S3 needs re-scoping.** It is not a union. It is a JSDoc type literal (`{object}` plus nested property tags) over a legacy struct slot. That makes it the same signature-ownership question as S4, plus recognising `JSDocTypeLiteral` as "object".
- **S4: the numbers favour Option B.** In the sampled files the divergent slots are not call-site inference:
  - for the Primordial pair and `verifyAccessorProperty`, they are the JSDoc `@type {typeof …}` / `{object}` literals;
  - for `verifyEqualTo` without a call site, they are a default `f64`.

  In those files no caller exists outside the harness. Option A would have to adopt struct slots (`$__anon_1`, `$__anon_2`, `$__Date`) the IR has no body operations for.
- **Chains longer than three steps:** `verifyProperty`, `verifyCallableProperty`, `verifyAccessorProperty` and both Primordial units. Per the S0 rule, each needs its own follow-up issue, or the slices are re-cut by refusal class (function values; the `move-only` classes) rather than by unit.

### Not measured

- Chains past six steps by single-site stubs. The exploratory runs admitted whole classes at once.
- `verifyAccessorProperty` and the Primordial units past their last select refusal; their from-ast outcome is unknown.
- Where legacy's `f64` for an uncalled `verifyEqualTo(value)` comes from.
- The 83-file runtime-eval and 39-file `Test262Error` sub-populations beyond two files.
- Verdicts (pass/fail) of any stubbed build.
- The default (JavaScript-environment) target.

## Notes

- 2026-11-13: filed from the 2026-11-11 census. The census file does not keep
  per-unit refusal details; the table above comes from eleven sample
  compiles. S0 exists to replace the samples with the full chains.
