---
id: 2726
title: "delete residual: sloppy return-value semantics, hasOwnProperty-after-delete, accessor descriptor configurability, mapped-arguments delete"
status: done
completed: 2026-07-26
sprint: 77
goal: es5
feasibility: medium
depends_on: []
priority: medium
es_edition: ES5
language_feature: delete
task_type: bug
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/index.ts
  - src/codegen/typeof-delete.ts
  - src/ir/select.ts
created: 2026-06-26
updated: 2026-07-30
---

> **Strict-rerun residual (2026-07-28, codex-2726).** The authoritative
> original-harness runner exposed one remaining group (e) gap that the earlier
> focused wrapper did not cover: `11.4.1-4.a-17` passed its sloppy execution but
> failed the required strict rerun in both host/gc and standalone. Strict
> functions use an _unmapped_ arguments object, so they intentionally have no
> `mappedArgsInfo`; the generic property-delete path reported success but could
> not clear the opaque vec-backed slot. The delete lowering now preserves that
> generic result (including descriptor refusal), and on success clears a
> statically indexed unmapped-arguments slot to canonical `undefined`.
>
> Same-SHA authoritative A/B: the 69-file delete directory moves host
> **59→60** and standalone **51→52**, with exactly
> `11.4.1-4.a-17` flipping in each lane and no reverse flips. Across all 26
> Test262 files containing direct `delete arguments[...]`, host moves **7→12**
> and standalone **5→10** (five exact fail→pass flips per lane, zero
> pass→fail). The remaining standalone-only `11.4.1-5-a-27-s` failure is still
> the separately owned `preventExtensions`/strict-assignment gap, not delete
> semantics.
>
> **Final resolution (2026-07-26, codex-2726).** Group **(b)** is now **4/4**:
> the two structural residuals `S11.4.1_A3.1` and
> `S11.4.1_A3.3_T1` pass in both host/gc and standalone. The implementation
> follows the architect specification and resolution below.
>
> **Partial resolution (2026-07-05, dev-2726).** Group **(a)** DONE (sloppy
> `delete <unresolvable identifier>` → `true`; +4 test262). Groups **(c)** and
> **(d)** DONE earlier (+6 test262). Group **(b)** is now **2/4**: the
> configurable-built-in-global case **`11.4.1-4.a-8`** (`delete JSON === true`)
> is DONE (+1 test262, 0 regressions — see `## Resolution — group (b) 11.4.1-4.a-8`),
> alongside `S11.4.1_A3.2_T1` (carried earlier by the (a) oracle). The **2
> remaining (b) tests are STRUCTURAL** and need the global-object model
> (architect-spec first): `S11.4.1_A3.1` (`delete this.y === false` — top-level
> `this` as the global object) and `S11.4.1_A3.3_T1` (`x = 1; delete x; x` →
> ReferenceError — implicit-global creation + real deletion + unresolved read).
> **(e)** mapped-arguments delete now **DONE** (2026-07-05, opus-2726: +1 test262
> `11.4.1-4.a-17`, 0 regressions — see `## Resolution — group (e)`). **(g)**
> prototype-chain (inherited) delete now **DONE** (2026-07-06, opus-2726fg: +1
> test262 `S8.12.7_A2_T2`, 0 delete-dir regressions — see `## Resolution — group (g)`).
> **(f)** (`11.4.1-5-a-27-s` — strict assign to a `preventExtensions`'d object)
> re-routes to its owning strict-mode/preventExtensions feature issue. This issue
> therefore stayed open at that point for the 2 structural (b) tests — route to
> architect before further dispatch.

# #2726 — delete residual (non-throw) semantics

Split out of #2703, which delivered the **throw** cases of `delete`
(super → ReferenceError, null/undefined base → TypeError, strict non-configurable
→ TypeError). The remaining `delete` test262 failures are **non-throw** concerns
that each need a distinct subsystem fix; they are tracked here so #2703 can close
on its throw-semantics scope.

## Architect specification — residual group (b) global environment

The remaining two tests need one bounded GlobalEnvironmentRecord slice rather
than another return-value constant:

1. **Discover implicit-global candidates before body compilation.** A
   whole-source AST scan records simple sloppy assignments whose identifier LHS
   has no value binding according to the checker oracle. This set is computed
   before any function or `__module_init` body is emitted, so a reader compiled
   before its writer gets the same lowering as a reader compiled after it.
2. **Use one target-aware global-object carrier.** Host/gc reads the current
   sandbox through `__get_globalThis`; standalone/WASI uses the existing cached
   native `$Object` returned by `emitNativeGlobalThisObject`. Assignment,
   identifier read, and delete must all request this carrier through the same
   helper.
3. **Keep the three operations symmetric.** Sloppy unresolvable `x = value`
   performs `__extern_set(globalObject, "x", value)` (default attributes,
   including `configurable:true`). A later candidate read first tests own
   presence, throws `ReferenceError` when absent, and otherwise performs
   `__extern_get`. `delete x` performs
   `__delete_property(globalObject, "x")`, so it removes the property rather
   than merely returning a compile-time `true`.
4. **Record non-configurable script declarations separately from storage.**
   Top-level script `var` bindings remain in their existing typed Wasm globals,
   but their names are also recorded as non-configurable global-object
   bindings. A direct top-level `delete this.name`/`delete globalThis.name`
   consults that record and returns `false` (or takes the existing strict
   TypeError path). `let`/`const` names are deliberately excluded because global
   lexical bindings are not properties of the global object.
5. **Gate every new path.** Sources without a sloppy implicit-global assignment
   or direct delete of a recorded script `var` retain the current local/global
   lowering. Dynamic aliases of the global object and full reflective mirroring
   of typed Wasm globals are follow-up GlobalEnvironmentRecord work, not needed
   for these two ES5 assertions.

The acceptance invariants are: assignment creates an own configurable property
on both targets; a read observes it while present; delete removes it; the next
read throws a real `ReferenceError`; and a script `var` remains non-deletable
through direct top-level `this`.

## Resolution — group (b) structural residuals (2026-07-26, codex-2726)

**Root causes.**

- Sloppy unresolvable assignment used the host global object only in host/gc;
  standalone allocated a function local. Bare-identifier delete returned a
  compile-time `true` without deleting that host property, and identifier reads
  had no compile-order-independent record that the property could exist.
- Script `var` values use typed Wasm globals, but no companion binding-attribute
  record told `delete this.y` that `y` is a non-configurable global property.
  In the full harness, the checker additionally gave top-level `this` a
  structural global shape, so field-specialized delete lowering ran before the
  generic property path.
- The IR module-init selector admitted `delete this.y` even though its delete
  lowerer only evaluates the receiver and returns constant `true`.

**Fix.** A checker-oracle pre-scan records simple sloppy implicit-global
assignment targets before any body compiles. The new shared
`global-environment.ts` selects the host sandbox global or native standalone
`$Object`; assignment uses `__extern_set`, reads use
`__hasOwnProperty` + `__extern_get` (throwing a real `ReferenceError` when
absent), and bare delete uses `__delete_property`. Script `var` names are tracked
separately from `let`/`const` and consulted before all property-specialized
delete paths. IR module init conservatively demotes direct top-level
`delete this.name` until IR owns global binding attributes.

**Results.** Focused regression coverage exercises both targets, property
presence with an `undefined`-distinguishing read, real deletion, post-delete
`ReferenceError`, non-configurable script `var`, and the IR selector boundary.
The authoritative original-harness runner reports **pass** for both
`S11.4.1_A3.1` and `S11.4.1_A3.3_T1` in host/gc and standalone.

## Sub-groups (14 tests, all `test/language/expressions/delete/` unless noted)

### (a) Sloppy-mode `delete <unresolvable identifier>` → `true` (3) — DONE (2026-06-29)

`S11.4.1_A2.2_T1.js`, `S11.4.1_A3.3_T6.js`, `11.4.1-3-1.js`

- `delete x` where `x` resolves to **no binding anywhere** returns `true` in
  sloppy mode (§13.5.1.2: unresolvable Reference ⇒ true). We previously returned
  `false` for every bare identifier (variables-not-deletable path in
  `compileDeleteExpression`).
- **Hazard**: a naive "unknown to the compiler ⇒ unresolvable ⇒ true" flip
  regresses `delete NaN`/`delete undefined`/`delete Infinity` (real
  non-configurable globals ⇒ must stay `false`). Needs a reliable
  "is this a real global binding" oracle, not the `isUnresolvableIdent`
  compiler-knowledge heuristic.
- **Resolved** — see `## Resolution — group (a)`. The reliable oracle is
  TS-checker **symbol presence** (`getSymbolAtLocation === undefined` ⇒
  unresolvable), which keeps `undefined`/`arguments`/`globalThis` (symbol, no
  value decl) and `NaN`/`Infinity`/`JSON` (lib-declared) out of the `true`
  bucket. +4 test262 (the 3 targets + bonus implicit-global `S11.4.1_A3.2_T1`).

### (b) Sloppy global-object model (4)

`S11.4.1_A3.1.js` (#2 `delete this.y === false`), `S11.4.1_A3.2_T1.js`
(`x = 1; delete x === true` — implicit global), `S11.4.1_A3.3_T1.js`
(`delete x; x` then ReferenceError), `11.4.1-4.a-8.js` (`delete JSON === true`).

- Requires modelling top-level `this` as the global object and tracking
  `var`/function-declared globals as non-configurable vs implicitly-created
  globals as configurable. Structural; likely architect-spec first.

### (c) `hasOwnProperty` false after a configurable `Object.defineProperty` delete (3)

`11.4.1-4.a-1.js`, `11.4.1-4.a-2.js`, `11.4.1-4-a-4-s.js`

- After `delete obj.prop` of a `configurable:true` defineProperty'd property,
  `obj.hasOwnProperty("prop")` still reports `true`. The `__delete_property`
  tombstone (`_wasmStructDeletedKeys`) / `__hasOwnProperty` predicate is not
  clearing the property for these struct shapes. ~27 sibling fails in
  `built-ins/Object/defineProperty/15.2.3.6-3-*.js` share this root cause.

### (d) Non-configurable accessor descriptor not consulted by delete (1+)

`11.4.1-4-a-2-s.js`

- `delete obj.prop` of a **non-configurable accessor** wrongly returns `true`
  (host `__delete_property` does not see the accessor's `configurable:false`
  flag). Runtime descriptor-storage fix in `src/runtime.ts`.

### (e) Mapped-arguments delete (1) — DONE (2026-07-05)

`11.4.1-4.a-17.js`

- `delete arguments[0]` in a mapped-arguments function: `=== true` and the slot
  reads `undefined` afterward. Routes through the `mappedArgsInfo` bookkeeping in
  `compileDeleteExpression` plus the element-delete on `arguments`.
- **Resolved** — see `## Resolution — group (e)`.

### (f) preventExtensions interaction (1)

`11.4.1-5-a-27-s.js`

- Not really a delete bug: after `delete a.x; Object.preventExtensions(a)`, a
  strict-mode `a.x = 1` must throw (assign to a property of a non-extensible
  object). Belongs with strict-mode assignment / preventExtensions support.

### (g) Prototype-chain read (1)

`S8.12.7_A2_T2.js`

- Fails at the inherited-property _read_ (`__palette.red`), before the delete —
  a prototype-chain read gap, not a delete bug.

## Acceptance

The (a)–(e) groups flip from fail to pass with no regression in
`expressions/delete/` or `built-ins/Object/defineProperty/`. (f) and (g) may be
re-routed to their owning feature issues. Full CI green.

## Resolution — group (a) (2026-06-29, del2726)

**Root cause (a).** The bare-identifier arm of `compileDeleteExpression`
(`src/codegen/typeof-delete.ts`) unconditionally emitted `i32.const 0` ("variables
are not deletable") for **every** `delete <Identifier>`. §13.5.1.2 step 4 says a
`delete` of an **UnresolvableReference** (the name resolves to no binding
anywhere) evaluates to `true` in sloppy mode. Strict mode makes
`delete <bare identifier>` an early SyntaxError
(`early-errors/node-checks.ts` already enforces this), so the codegen arm is
reached only in sloppy code — exactly where step 4 applies.

**Oracle (the issue's stated hazard).** A reliable "real binding vs unresolvable"
test is **TS-checker symbol presence**: `ctx.checker.getSymbolAtLocation(ident)`
returns `undefined` only for a genuinely unresolvable name. The three
non-configurable intrinsic globals that MUST stay `false`
(`undefined`/`arguments`/`globalThis`) return a **symbol with no
`valueDeclaration`**, and every lib-declared global (`NaN`/`Infinity`/`JSON`/…)
returns a symbol **with** a value decl — so symbol-presence keeps all of them out
of the `true` bucket, where the weaker `!valueDeclaration` heuristic would
wrongly flip `undefined`/`arguments`/`globalThis`.

**Fix (a).** When the bare-identifier reference is unresolvable
(`getSymbolAtLocation === undefined`), emit `i32.const 1` (true); otherwise keep
the `false`. **Eval guard**: an identifier inside an inlined `eval("<literal>")`
body lives in a foreign `SourceFile` (`EVAL_SOURCE_FILENAME`, exported from
`expressions/eval-inline.ts`) the checker never bound, so its symbol is _always_
`undefined` even for a name resolving to an outer var. The flip is gated to skip
eval-body nodes (`ident.getSourceFile().fileName !== EVAL_SOURCE_FILENAME`),
preserving `var x = 1; eval('delete x') === false` (`11.4.1-4.a-7`). Precise
eval-scope delete resolution stays out of scope (eval-substrate lane).
`src/codegen/typeof-delete.ts`, `src/codegen/expressions/eval-inline.ts`.

### Test Results — group (a) (host/gc lane, authoritative `runTest262File`)

| cluster                                                      | baseline → fix                      |
| ------------------------------------------------------------ | ----------------------------------- |
| `language/expressions/delete`                                | 59 → **63** pass, **0 regressions** |
| 98 other test262 files containing a bare-identifier `delete` | no change (0 collateral)            |

Net **+4** test262. Flipped fail→pass: `S11.4.1_A2.2_T1`, `S11.4.1_A3.3_T6`,
`11.4.1-3-1` (group (a)) plus bonus `S11.4.1_A3.2_T1` (group (b) implicit-global
`x = 1; delete x === true`, carried by the same oracle). Regression test:
`tests/issue-2726-sloppy-unresolvable-delete.test.ts`.

## Resolution — group (b) `11.4.1-4.a-8` (2026-07-05, dev-2726)

**Scope.** The configurable-built-in-global slice of group (b) —
`11.4.1-4.a-8.js` (`delete JSON === true`). The other two (b) tests
(`S11.4.1_A3.1`, `S11.4.1_A3.3_T1`) remain STRUCTURAL and out of this slice
(see the top note / Residual).

**Root cause.** After group (a) flipped only the _unresolvable_ bare-identifier
`delete` to `true`, every _resolvable_ bare identifier still emitted `false`
("variables are not deletable"). But §13.5.1.2 step 5 makes `delete` of a
**configurable** property of the global object return `true`. Per ECMA-262 §19
**every** built-in global (`JSON`/`Object`/`Math`/`parseInt`/…) is
`{[[Configurable]]: true}`; only `NaN`/`Infinity`/`undefined` are
non-configurable. So `delete JSON` must be `true`, not `false`.

**Oracle.** Distinguish a configurable built-in global from a user-declared
`var`/`function` (whose global binding is non-configurable ⇒ `false`) by TS
**symbol provenance**: a built-in's `symbol.declarations` are ALL in ambient
`.d.ts` lib files (`decl.getSourceFile().isDeclarationFile`), whereas a user
binding is declared in the program's own source. Two guards make it precise:

- name-exclude the three non-configurable intrinsics
  `NON_CONFIGURABLE_GLOBALS = {NaN, Infinity, undefined}` (all three are
  ambient-declared, so provenance alone wouldn't separate them);
- require `decls.length > 0`, which keeps `undefined`/`globalThis`/`arguments`
  (empty `declarations`) out of the `true` branch.
  Eval-body nodes never reach this branch (their symbol is `undefined`, already
  handled by the group-(a) arm). Front-end constant flip (`i32.const 1`), so the
  host and standalone lanes agree — **no new host import**.
  `src/codegen/typeof-delete.ts` (bare-identifier arm + `NON_CONFIGURABLE_GLOBALS`).

### Test Results — group (b) 11.4.1-4.a-8 (host/gc lane, authoritative `runTest262File`)

| cluster                                                                        | baseline → fix                      |
| ------------------------------------------------------------------------------ | ----------------------------------- |
| `language/expressions/delete` (full dir, 69 files)                             | 63 → **64** pass, **0 regressions** |
| collateral (`delete <builtin>` elsewhere: `built-ins/undefined`, `staging/sm`) | no change (0 collateral)            |

Net **+1** test262. Flipped fail→pass: `11.4.1-4.a-8`. Guards verified unchanged:
`delete NaN`/`delete undefined`/`delete <user var|func>` stay `false`
(`11.4.1-4.a-4`, `built-ins/undefined/S15.1.1.3_A3_T2`, `11.4.1-4.a-5/-13/-16`).
Regression test: `tests/issue-2726-configurable-global-delete.test.ts` (+ the
corrected JSON/Object assertion in `tests/issue-2726-sloppy-unresolvable-delete.test.ts`).

## Resolution — group (e) (2026-07-05, opus-2726)

**Scope.** `11.4.1-4.a-17.js` — `delete arguments[0]` in a mapped-arguments
function returns `true` AND `arguments[0]` reads `undefined` afterward.

**Root cause (e).** The mapped-`arguments[i]` delete arm in
`compileDeleteExpression` (`src/codegen/typeof-delete.ts`) recorded the
sever-bookkeeping (`unmappedIndices.add(argIndex)`) and then **fell through to
the generic `__delete_property` path**. That path reports `true` for a mapped
arguments object but never clears the **WasmGC-vec backing slot** — the vec's
indices carry no sidecar descriptor — so a subsequent `arguments[i]` read still
returned the original argument. (The arguments object is vec-backed:
`arguments[i]` reads array field 1 of the vec directly; param writes
forward-sync into it, slot writes reverse-sync into the param. §10.4.4.5.)

**Fix (e).** In the mapped, configurable-index arm, after recording the sever,
write the canonical `undefined` externref into the backing slot
(`vec.data[argIndex]`, null-guarded, mirroring `emitMappedArgParamSync`'s slot
write) and emit `i32.const 1` (`true`), **short-circuiting the generic path**.
The already-present `unmappedIndices` entry stops a later parameter write from
resurrecting the slot (§10.4.4.2). The non-configurable arm (returns `false`) is
untouched. Front-end only — no new host import; standalone and host lanes agree.
`src/codegen/typeof-delete.ts`.

### Test Results — group (e) (host/gc lane, authoritative `runTest262File`)

| cluster                                       | baseline → fix                                                     |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `language/expressions/delete` (69 files)      | 64 → **65** pass, **0 regressions**                                |
| `language/arguments-object/mapped` (43 files) | 39 → 39 (no change; 4 pre-existing defineProperty fails unchanged) |

Net **+1** test262. Flipped fail→pass: `11.4.1-4.a-17`. Remaining `delete`-dir
fails are all out-of-scope: `S11.4.1_A3.1` + `S11.4.1_A3.3_T1` (structural (b),
architect-first), `11.4.1-5-a-27-s` (f, preventExtensions), `S8.12.7_A2_T2`
(g, prototype-chain read). Regression test:
`tests/issue-2726-mapped-args-delete.test.ts`.

## Resolution — groups (c) + (d) (2026-06-27, dev2)

**Root cause (c).** `var o = {}` infers an empty struct type, so the receiver
takes the WasmGC-struct lowering path (not the `any`/host path #2731 fixed).
`o.hasOwnProperty('foo')` was **constant-folded to `i32.const 1`** against the
static struct shape (which `Object.defineProperty` _widens_ to include `foo`),
ignoring a later configurable `delete`'s `_wasmStructDeletedKeys` tombstone. The
fold's runtime-routing guard (`needsRuntime`) only consulted
`ctx.definedPropertyFlags`, which is populated **only for inline object-literal
descriptors**. The dominant ES5 `var d = { value: 1, configurable: true };
Object.defineProperty(o, k, d)` shape routes through `emitDefinePropertyDescRuntime`
(recorded in `sidecarDefinedPropertyKeys`) and the inline-**accessor** fast path
(recorded in neither), so the guard never fired for them.

**Fix (c).** Added `ctx.definePropertyReceiverKeys` — a `varName:propName` set
recorded at the single `compileObjectDefineProperty` chokepoint, capturing EVERY
defineProperty lowering path uniformly. `hasOwnProperty` / `propertyIsEnumerable`
now route to the runtime `__hasOwnProperty` helper (which consults the tombstone)
whenever the receiver var was defineProperty'd. Kept SEPARATE from
`definedPropertyFlags` / `sidecarDefinedPropertyKeys` so it never perturbs
descriptor-flag or `getOwnPropertyDescriptor` routing (a presence-routing signal
only). `src/codegen/object-ops.ts`, `src/codegen/context/{types,create-context}.ts`.

**Root cause (d).** The inline-accessor `Object.defineProperty` fast path
(statically struct-typed receiver) compiles the getter/setter into a
`${struct}_get/set_<prop>` fn + `classAccessorSet` and — unlike the data fast
path — never mirrors the descriptor's `configurable` flag into the runtime
`_wasmPropDescs` sidecar. So `__delete_property` couldn't see `configurable:false`
and wrongly reported a successful delete.

**Fix (d).** Added `ctx.nonConfigurableAccessorKeys` (populated by that fast path
when `configurable !== true`; per §6.2.5.6 an omitted `configurable` defaults to
false). The struct-field `delete` site consults it to emit OrdinaryDelete's
refusal (return `false`; strict ⇒ TypeError, leaving the property intact) without
issuing the runtime call (which would otherwise add a spurious tombstone).
`src/codegen/typeof-delete.ts`.

### Test Results (host/gc lane, authoritative `runTest262File`)

| cluster                                                                         | baseline → fix                    |
| ------------------------------------------------------------------------------- | --------------------------------- |
| `expressions/delete` + `Object.prototype/{hasOwnProperty,propertyIsEnumerable}` | 117 → 121 pass, **0 regressions** |
| `Object/{defineProperty,getOwnPropertyDescriptor,defineProperties}`             | 207 → 207 (no change)             |
| `Object/{freeze,seal,preventExtensions,create,getOwnPropertyNames}`             | 400 → 402 pass, **0 regressions** |
| `for-in` + `Object/keys` + `expressions/object`                                 | 363 → 363 (no change)             |

Net **+6** test262, **0 regressions** across ~4,500 most-related tests. Targets
flipped fail→pass: `11.4.1-4.a-1`, `11.4.1-4.a-2`, `11.4.1-4-a-4-s` (c),
`11.4.1-4-a-2-s` (d), plus sibling `Object/freeze/15.2.3.9-2-3` and
`Object/seal/object-seal-inherited-accessor-properties-are-ignored`.
Regression test: `tests/issue-2726.test.ts`.

## Residual (as of #2199, PO reconcile 2026-06-28; updated 2026-07-05 dev-2726)

NOT done — partially resolved. DONE so far: (a) sloppy unresolvable-identifier
oracle (+4 test262, 0 regressions, 2026-06-29, **PR #2296**), (c) hasOwnProperty-
after-configurable-delete + (d) non-configurable accessor delete (+6 test262, 0
regressions, **PR #2177**), (b-partial) configurable-built-in-global
`11.4.1-4.a-8` `delete JSON === true` (+1 test262, 0 regressions, 2026-07-05,
dev-2726). Remaining OPEN: **(b) sloppy global-object model** — now **2/4**
(`S11.4.1_A3.2_T1` + `11.4.1-4.a-8` done; still failing: `S11.4.1_A3.1`
`delete this.y === false`, `S11.4.1_A3.3_T1` `delete x; x` → ReferenceError).
These 2 are STRUCTURAL (need top-level-`this`-as-global-object + implicit-global
creation/real-deletion/unresolved-read) and need an architect spec first (NOT
dev-claimable as-is). (e) mapped-arguments delete → #1726; (f)/(g) re-routed to
owning feature issues. Stays `ready` for the 2 structural (b) tests — route to
architect before further dispatch.

## Resolution — group (g) (2026-07-06, opus-2726fg)

**Scope.** `S8.12.7_A2_T2.js` — `delete __palette.red` where `red` is inherited
from `Palette.prototype`, then the prototype-chain read `__palette.red` must
still see the inherited value (CHECK#3). (The issue's original "fails at the
inherited _read_ before the delete" note is stale — CHECK#1's initial inherited
read already passes on current main; the sole remaining failure is CHECK#3, the
read _after_ the delete.)

**Root cause (g).** The WasmGC-struct arm of `__delete_property`
(`src/runtime.ts`) unconditionally dropped the sidecar/descriptor entries **and
recorded a tombstone** (`_wasmStructDeletedKeys`) for the key — even when the key
is not an **own** property of the receiver. For `delete __palette.red`, `red`
lives only on `Palette.prototype`, so the receiver owns nothing named `red`; the
spurious tombstone then shadowed the still-present inherited value on the next
`__palette.red` read (the read consults the tombstone before walking the
prototype chain), returning `undefined` instead of `0xFF0000`.

**Spec.** ECMA-262 §10.5.7 OrdinaryDelete step 2: `Let desc be
O.[[GetOwnProperty]](P). If desc is undefined, return true.` — deleting a
property the receiver does not **own** is a true no-op: return `true`, mutate
nothing. (The delete still evaluates to `true`, so CHECK#2 was already passing;
only the erroneous tombstone side-effect had to go.)

**Fix (g).** Guard the struct delete arm with the existing own-property oracle
`_wasmStructHasOwn(obj, k, exports)`: if the key is **not** own, `return 1`
immediately without touching sidecar/descriptor/tombstone state. Own keys
(struct field, sidecar, descriptor, class method) still `hasOwn === true` and
fall through to the unchanged real delete, so groups (c)/(d)/(e) and every other
own-delete case are untouched. `src/runtime.ts` (`__delete_property` struct arm).

### Test Results — group (g) (host/gc lane, authoritative `runTest262File`)

| cluster                                            | baseline → fix                      |
| -------------------------------------------------- | ----------------------------------- |
| `language/expressions/delete` (full dir, 69 files) | 65 → **66** pass, **0 regressions** |

Net **+1** test262. Flipped fail→pass: `S8.12.7_A2_T2`. The other 3 dir failures
are unchanged: `11.4.1-5-a-27-s` (group (f), re-routed) and the 2 STRUCTURAL
group-(b) tests (`S11.4.1_A3.1`, `S11.4.1_A3.3_T1`). Regression test:
`tests/issue-2726-inherited-delete-noop.test.ts`.
