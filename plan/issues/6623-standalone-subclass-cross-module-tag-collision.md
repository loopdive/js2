---
id: 6623
title: "standalone: a locally-declared field-less subclass of an unresolved heritage value can be WRONGLY answered as a linked provider instance's prototype (cross-module `__tag` collision, S36)"
status: done
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
completed: 2026-09-17
assignee: ttraenkler/senior-dev
func-budget-allow:
  # 2026-09-17 (S36) — `collectClassDeclaration` gains the
  # `classDynamicUnresolvedHeritageSet` marking at BOTH of its existing
  # heritage-detection sites (the unresolved-identifier fallback and the
  # property-access/`else` arm). 23 lines over budget for two small,
  # precedent-matching marks in a function that already walks this exact
  # branch structure — not an incidental regression.
  - src/codegen/class-bodies.ts::collectClassDeclaration
---

# #6623 — cross-module class-`__tag` collision for a subclass of unresolved heritage, standalone

## Problem

`class S extends <heritage the compiler cannot statically resolve to a known
local class>` — a property-access into a linked provider namespace
(`class S extends NS.PD {}`) or an identifier bound to a runtime PARAMETER
(`class S extends construct {}`, exactly test262's own
`TemporalHelpers.checkSubclassingIgnored(construct, ...)` shape) — compiles,
under `--target standalone`/`wasi`, as an INDEPENDENT ROOT struct with no
compiled relationship to its true superclass
(`src/codegen/class-bodies.ts`'s heritage-detection loop only resolves an
`Identifier`/`ClassExpression` base to a real parent; both other shapes leave
`parentClassName`/`parentStructTypeIdx` unlinked, `hasDynamicHostParent`'s
equivalent host-mode-only handling notwithstanding).

When such a class declares no own fields (the common shape — a subclass whose
only job is forwarding to `super(...)`), its struct canonicalizes to the SAME
WasmGC type — `{__tag: i32, __shape_brand: i32}` — as ANY OTHER field-less
class, including one exported by a LINKED PROVIDER module.
`standalone-class-instance-proto.ts`'s `__std_class_instance_proto` dispatcher
(#6617/S30 — answers `Object.getPrototypeOf` for a compiled class instance
through a value the checker cannot narrow) disambiguates same-shape classes
ONLY by `__tag`, a small per-module integer counter
(`ctx.classTagCounter`, starting at **0 in every module independently** —
`src/codegen/context/create-context.ts`). Two field-less classes compiled in
DIFFERENT modules — the consumer's own subclass, and any provider class — can
therefore share BOTH the canonical struct shape AND the numeric tag by pure
coincidence (trivially likely: each is simply "the Nth field-less class
registered in its own module"), and the dispatcher answers the CONSUMER's
subclass's prototype for a value the PROVIDER genuinely minted — a silently
WRONG non-null answer, worse than the `null` it would otherwise decline to.

## Reduction

Per the S36 dispatch brief's required order:

1. **Single module, no link** (`class B { m() { return new B(); } } class S
   extends B {}; Object.getPrototypeOf(new S().m())`) — does NOT reproduce.
   `Object.getPrototypeOf(new S().m()) === B.prototype` reads `true`; the
   static, same-module fold already handles this (S30's own mechanism).
2. **Synthetic linked pair** (`.tmp/s36/link-probe6.mts`,
   `.tmp/s36/link-probe7.mts`) — reproduces cleanly, both heritage shapes:
   - Property-access: `class S extends NS.PD {}` in the same module as
     `const plain = new NS.PD(9); plain.m()` (a receiver that NEVER touches
     `S`) — `Object.getPrototypeOf(plain.m()) === S.prototype` reads `true`
     on the base tree.
   - Identifier (faithful to `checkSubclassConstructorUndefined`):
     `(function(construct){ class MySubclass extends construct {
     constructor(){super(1);} } ... })(NS.PD)` — `Object.getPrototypeOf(
     instance.m()) === MySubclass.prototype` reads `true` on the base tree.
   Confirmed by direct instrumentation (`ctx.classTagCounter`/`classTagMap`
   printed at registration time): `PD` (first class in the provider module)
   gets `__tag = 0`; `S`/`MySubclass` (first — and only — class in the
   consumer module) ALSO gets `__tag = 0`. Both are field-less. The
   `ref.test` + `__tag` guard in `standalone-class-instance-proto.ts` passes
   on both counts, and the arm answers the wrong prototype.
3. **Real provider** (`.tmp/s35probe/debug2.js`,
   `checkSubclassConstructorUndefined` against the real polyfill) —
   `Object.getPrototypeOf(instance.abs())` answers `null`, NOT a wrong
   prototype. Consistent with the same mechanism: `Temporal.Duration` is not
   the first class the polyfill declares (many classes precede it — JSBI,
   `TimeDuration`, `Instant`, the calendar-helper classes, …), so its real
   `__tag` almost certainly does not coincide with `MySubclass`'s `__tag = 0`
   in THIS specific test file. The consumer's local dispatch therefore
   correctly declines (tag mismatch) and the query should fall through to the
   `__js2wasm_link_get_prototype_of` boundary terminal (#6617/S30) — which
   answers `null` rather than `Duration.prototype` for THIS specific value.
   That fall-through gap (why the boundary terminal does not resolve a value
   returned from a dynamic METHOD CALL on an unresolved-heritage subclass
   receiver, as opposed to a value from `new NS.PD()`/`NS.PD.from()` directly,
   which #6617's own witness already covers) is a THIRD, separate,
   NOT-YET-REDUCED mechanism — this is the actual blocker for the 45-file
   headline, and it is NOT what this issue fixes. See "Residual" below.

## Fix

`ctx.classDynamicUnresolvedHeritageSet` (new `Set<string>`,
`src/codegen/context/types.ts`/`create-context.ts`) is populated at BOTH
heritage-detection sites in `class-bodies.ts::collectClassDeclaration` that
leave a class unlinked under `--target standalone`/`wasi`:

- the `ts.isIdentifier(baseExpr)` arm, when `resolveClassHeritageAlias`
  returns `undefined` (the identifier could not be tied to any known local
  class declaration — a function PARAMETER is exactly this case);
- the property-access/other `else` arm (`hasDynamicHostParent`'s equivalent,
  currently HOST-MODE ONLY — `class S extends NS.PD {}` gets no standalone/
  wasi handling at all today).

`standalone-class-instance-proto.ts`'s `collectEntries` excludes a flagged,
field-less class (checked by filtering out only the `__tag`/`__shape_brand`
bookkeeping fields, not the raw `structFields.length`) from ever claiming a
`getPrototypeOf` answer — declining (falling through, eventually to `null`)
rather than risking the false-positive match. A class with genuine own (or
inherited) fields is NOT excluded: its struct shape is unique enough that the
collision cannot occur, so its own instances still answer correctly (verified
directly, see witness test control #5).

This is answer-PRESERVING for every value that was already correct (declining
can only ever REMOVE a false positive, never introduce one — the same
reasoning #6620/S33's `taCtorIdentityTestInstrs` fix used for a sibling
collision), and it is standalone/wasi-only (`ctx.classDynamicUnresolvedHeritageSet`
is populated only under `ctx.standalone || ctx.wasi`), so the JS-host/`gc`
lane is untouched.

## Result

Targeted synthetic probes (`.tmp/s36/link-probe*.mts`), fresh compiles both
labels:

| probe | base | branch |
| --- | --- | --- |
| `plain.m()` prototype, `S` declared elsewhere in module (property-access heritage) | `S.prototype` (WRONG) | not `S.prototype` (declines) |
| `instance.m()` prototype, identifier heritage (`construct` a parameter) | `MySubclass.prototype` (WRONG) | not `MySubclass.prototype` (declines) |
| CONTROL — no colliding class in module | `PD.prototype` (correct) | `PD.prototype` (correct, unchanged) |
| CONTROL — field-HAVING provider | `"not a function"` (unrelated, unfixed mechanism) | `"not a function"` (unchanged) |
| CONTROL — unresolved-heritage class WITH its own field, `getPrototypeOf(instance)` | `MySubclass.prototype` (correct) | `MySubclass.prototype` (correct, unchanged) |

Real provider (`.tmp/s35probe/debug2.js` against `@js-temporal/polyfill`,
fresh `JS2WASM_TEMPORAL_CACHE` per label): **unchanged**, `p1===null=true`
on both trees — matching the reduction's prediction (Duration's real tag does
not collide with this specific test's lone `MySubclass`). Provider artifact
byte-identical on both trees (`3311638 B`, `cacheHit=false` both prewarms) —
expected: the provider module itself declares no class with unresolved
heritage. Consumer artifact (debug2.js compiled standalone) changes
`wasm_sha` `6bb03bd61120` → `65e70d305741` — confirms the fix DOES touch this
exact test's codegen path (fewer/different dispatcher arms emitted), even
though the JS-observable answer for this specific probe stays `null`.

**Four-family sample, first 120 files each, `--target standalone`, provider
linked, fresh cache, file-copy revert base**: unchanged from S35's tip,
**430/480 both labels, 0 flips** (`PlainDate` 111, `Duration` 104,
`PlainDateTime` 112, `ZonedDateTime/prototype` 103). No `compile_error`, no
`timeout`, no `__temporal_*` leak in 960 rows.

**45-file `subclassing-ignored.js` corpus-wide, both labels: 0/45, unchanged**
— consistent with the reduction's third step: this fix targets a DIFFERENT
mechanism than the one blocking the headline family. The residual signature
stays `Test262Error: […]Expected SameValue(«null», «null») to be true`
(S35's documented signature), byte-identical message set on both trees.

**Must-not-move, per file, both labels, 0 flips.**

| group | rows | base pass | branch pass | flips |
| --- | --- | --- | --- | --- |
| A: `Object/keys` + `expressions/object` + `Reflect/{get,has}` | 1,250 | 1,125 | 1,125 | 0 |
| B: `Object/{entries,values,getOwnPropertyNames}` + `for-in` | 205 | 179 | 179 | 0 |
| C: `language/statements/class/subclass/**`(109, capped 150) + `subclass-builtins/**`(36, capped 100) + `Object/getPrototypeOf/**`(39) + `Reflect/construct/**`(10) | 194 | 146 | 146 | 0 |

1,649 rows total, per-file byte-identical `.tsv` diff on all three groups (`diff <(sort A-base.tsv) <(sort A-branch.tsv)` etc. — 0 lines of output on each).

**Corpus byte A/B**: 42 modules × {gc, standalone} = 84 artifacts — gc lane
byte-identical (this fix is standalone/wasi-only by construction); standalone
lane: 0 moved (no module in that 42-file corpus declares a class with
unresolved heritage that also happens to be field-less AND reaches a
`getPrototypeOf`-consuming site) — a genuine null control, stated as such.

**Equivalence gate** (`npm run -s test:equivalence:gate`): 22 failing / 1720
passing / 22 known-failures — baseline exactly, on both trees (this fix
touches only the standalone/wasi `classDynamicUnresolvedHeritageSet` path,
never reached by the `gc`-target equivalence corpus).

**Witness**: `tests/issue-6623-standalone-subclass-tag-collision.test.ts`,
5 `it`s — 2 fix-witnesses measured failing on the file-copy-reverted base
(both answer `"WRONG"` where the branch answers `"OK"`); 3 controls pass
identically on both trees.

## Residual — the actual 45-file blocker (not fixed here, sized instead)

Per the S36 brief's third reduction step, the headline's real blocker is a
THIRD, separate mechanism: `Object.getPrototypeOf(result)` where `result`
comes from a dynamic METHOD CALL (`instance.abs()`) on an
unresolved-heritage subclass receiver does not fall through to the
`__js2wasm_link_get_prototype_of` boundary terminal (#6617/S30) the way a
direct `new NS.PD()`/`NS.PD.from()` construction already does (#6617's own
witness covers exactly those two shapes and both pass). The difference is
receiver-shape-specific: `instance`, an `$MySubclass`-typed value locally
constructed via `new MySubclass()`, versus a value the checker types as
coming straight from the linked namespace. Reducing this needs its own
synthetic probe budget (a linked-pair variant where `instance`'s own
construction ALSO goes through the boundary correctly first, then the
METHOD CALL's result is checked) and is NOT attempted in this slice — filed
here rather than chased, per the brief's explicit instruction to size and
file rather than force a second fix into one PR.

A second, much smaller residual, also NOT fixed (one-line-or-less budget did
not apply): `String(<linked class>.prototype)` renders the literal text
`"null"` even though the object is real and non-null —
`assert.js`'s `formatSimpleValue` falls back to `String()` for any
non-primitive, and something about a linked class's prototype value makes
`String()` produce that text. Purely a diagnostic/stringification artifact
(it does not affect any `assert.sameValue`/`===` comparison, only what a
FAILURE MESSAGE prints), but worth a follow-up issue so a future slice does
not re-discover the same red herring S35 already flagged.

## Traps, carried forward from S30–S35, and one addition

Everything in S26–S35 still holds (see #5383's own findings log). One
addition:

- **A "field-less" check must exclude the compiler's OWN bookkeeping
  fields.** The first version of this fix's `collectEntries` guard checked
  `(ctx.structFields.get(className) ?? []).length === 0` — which is NEVER
  true for any class, because `__tag`/`__shape_brand` are appended to EVERY
  class's `structFields` entry AFTER the declared-field collection loop
  (`class-bodies.ts`, "Add hidden `__tag` field…"/"…`__shape_brand`…"). The
  guard silently never fired until corrected to filter those two names out
  first — caught only by re-running the targeted probe after the "fix" and
  seeing the wrong answer persist unchanged, not by any type or compile
  error. Worth re-checking for any future "is this class field-less" query
  in this codebase: `structFields.length === 0` is never the right test:
  `structFields.every(f => f.name === "__tag" || f.name === "__shape_brand")` is.
