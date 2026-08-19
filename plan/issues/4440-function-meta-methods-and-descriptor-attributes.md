---
id: 4440
title: "Function meta R1/R-attr slice — method name/length + own-property descriptor attributes (writable/enumerable/configurable)"
status: done
completed: 2026-08-15
sprint: 78
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: function-properties
goal: standalone-gap
related: [4437, 4436, 2896]
origin: "2026-08-15 ES5-standalone campaign wave 8 — #4437's R1 residual (class/object METHODS decline the meta) plus the descriptor-attribute family ('Expected obj[length] NOT to be writable' x4, Function/length 6 ES<=5 non-pass)."
loc-budget-allow:
  # All new LOGIC is in the new module `function-instance-meta-methods.ts`
  # (157 lines). What lands in these four is wiring and its rationale:
  #  - eval-inline.ts       +50: ONE 6-line predicate plus the measurement table
  #                              that justifies why a `null` body argument is a
  #                              constant, not a dynamic body (the whole reason
  #                              the six Function/length files were unreachable).
  #  - context/types.ts     +11: one optional Map field + its field doc. A
  #                              per-compile side table has to live on the
  #                              context; there is no other home.
  #  - literals.ts           +9: one extra argument threaded to
  #                              `emitObjectMethodAsClosure`, reformatted by
  #                              prettier onto its own lines.
  #  - class-bodies.ts       +6: three `recordFnMetaMemberDeclaration` calls at
  #                              the three registration sites (method / getter /
  #                              setter) plus the import. The declaration is only
  #                              in scope here.
  - src/codegen/expressions/eval-inline.ts
  - src/codegen/context/types.ts
  - src/codegen/literals.ts
  - src/codegen/class-bodies.ts
func-budget-allow:
  # The same three wiring edits, seen per-function. Each is a call/argument at
  # the ONE site where the needed value is in scope; none adds a branch.
  #  - compileObjectLiteralForStruct +9: the extra `emitObjectMethodAsClosure`
  #    argument, wrapped by prettier.
  #  - fillMemberGetDispatch        +7: the `$fnmeta` operand + derived type in
  #    the dynamic-read lazy init, so it cannot disagree with the typed read.
  #  - collectClassDeclaration      +5: three one-line registry writes next to
  #    the three existing `ctx.funcMap.set` calls.
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/member-get-dispatch.ts::fillMemberGetDispatch
  - src/codegen/class-bodies.ts::collectClassDeclaration
---

# #4440 — function meta for METHODS + own-property descriptor attributes

## Problem

Two adjacent residuals #4437 left with owners-unassigned:

1. **R1 — methods decline the meta.** `ensureMethodClosureSingleton` receives
   a name + funcIdx, not a declaration node, so class/object-literal methods
   have no `$fnmeta` and `name`/`length` reflection declines. All 8 remaining
   `*length-dflt.js` files sit here. Method `name` needs the `get `/`set `
   prefix rule and symbol-key handling (§10.2.9 SetFunctionName).
2. **Descriptor attributes.** `length`/`name` are now own DATA properties on
   plain functions (#4437), but their gOPD attributes must be
   `{ writable:false, enumerable:false, configurable:true }` per ES2015+/
   §15.1.5 ES5 (non-configurable in ES5 — test262 tests the MODERN attributes;
   follow what the failing files assert). Fresh-baseline signatures:
   `Expected obj[length] NOT to be writable, but was.` ×4;
   `built-ins/Function/length` 6 non-pass (S15.3.5.1_A2_T*/A3_T* —
   DontDelete/ReadOnly probes via assignment and delete).

## Implementation Plan

1. Base on #4437's modules: `function-instance-meta.ts` (write side),
   `function-instance-meta-arms.ts` (read side), `function-instance-props.ts`.
   Read #4437's issue file first — the nominal-struct discriminator rationale
   and the `$arity` no-repoint constraint both bind here.
2. R1: thread the declaration (or at minimum `{name, prefix-length}`) into
   `ensureMethodClosureSingleton`'s callers so methods intern a meta too.
   Where the declaration is genuinely unavailable, keep the decline.
3. Attributes: the reflection arms (`hasOwnProperty`/gOPD/`__extern_get`)
   answer for `length`/`name`; extend the gOPD synthesis to report the spec
   attribute triple, and make WRITES respect writable:false (sloppy silent
   no-op, strict TypeError — check what `__extern_set_strict` needs) and
   `delete` respect configurable per the asserted edition semantics.
4. Verify: the 8 `*length-dflt.js` files; `built-ins/Function/length/*`
   (6 non-pass; S15.3.5.1_A2_T1-3, A3_T1-3); the `Expected obj[length] NOT
   to be writable` ×4; #4437's 19-test pin + #4436's 23-test pin stay green;
   140-file closure-heavy control from #4437's methodology.

## Acceptance criteria

- ≥6 of the named files flip; zero regressions in the control set; gc/host
  byte-identical; non-flips root-caused here with owners.

**Met, with one declared exception.** 14 named files flip (8 method
`*length-dflt.js` + 6 `built-ins/Function/length/S15.3.5.1_A2/_A3`); the two
control sets are clean (128-file stride sample byte-identical, 114-file
neighborhood +8/−0); gc/host is sha256-identical across 27 files. The exception
is **one** regression, `built-ins/Function/S15.3.2.1_A1_T10`, root-caused below,
pinned in the test file, and filed as R6 — it is the price of the `null`-body
fold that buys the six `A2`/`A3` files, so the directory is net +5.

---

## Root cause

**Two causes, not one.** The issue bundled them because the two failure
signatures look adjacent, but they are unrelated mechanisms and needed separate
fixes.

### R1 — a method mint site has a NAME, not a node

`ensureMethodClosureSingleton`, `emitObjectMethodAsClosure` and
`emitFuncRefAsClosure` (the static-method path) all receive
`(methodName, methodFuncIdx, objStructTypeIdx)`. #4437's `fnMetaSlot` resolves
§15.1.5 / §10.2.9 **from a declaration node**, so every one of them declined and
`length` kept #4436's `$arity` fallback — the DECLARED FORMAL COUNT, which
diverges from §15.1.5 for exactly the defaulted-parameter shapes the
`*length-dflt.js` files test.

What the three sites *do* share is the physical name they key everything else
by (`ClassName_m`, `ClassName_get_p`, `ClassName_set_p`,
`LiteralType_field`). `class-bodies.ts` records the member declaration under
that key at the same moment it writes `ctx.funcMap`; the mint sites look it up.
Keyed by NAME rather than funcIdx because funcIdx is shift-sensitive and the
name is what those sites already re-resolve by at fill time.

### R-attr — the six `Function/length` files never reached the enforcement

The attributes were **already right** for an ordinary user closure before this
change: `__builtinfn_gopd` derives the descriptor from `get_meta` with
`FLAG_CONFIGURABLE` (= `{writable:false, enumerable:false, configurable:true}`),
`buildBuiltinFnSetRefusalArm` refuses the write, and #4436's tombstone arm
implements `delete`. Measured on this branch's base:

```
function g(a,b,c){}                    delete → removed;  g.length = 99 → refused (3)
new Function("a,b,c", null)            delete → NO-OP;    f.length = 99 → accepted (99)
```

The receiver was the whole difference. §20.2.1.1.1 `ToString`s every argument,
so a `null` body IS a constant body — but `resolveConstantString` returns
`null` for a non-string literal, so `synthesizeStaticNewFunction` declined and
the call routed to the **runtime-eval (QuickJS) tier**, whose function object is
not a Wasm closure at all: no `$bag`, no `$fnmeta`, none of the #4436/#4437
arms. Measured through a fully opaque receiver (passed as a function parameter,
so no static fold can answer):

| on `f`, opaque receiver | `new Function("a,b,c", null)` | `new Function("a,b,c", "return 1;")` |
| ----------------------- | ----------------------------: | -----------------------------------: |
| `x[k]`, `hasOwnProperty("length")` | 3, true (the eval tier answers) | 3, true |
| `Object.getOwnPropertyNames(x).length` | **0** | 2 |
| `delete x.length`, then `hasOwnProperty` | **still true** | false |
| `x.length = 99`, then read | **99** | 3 (refused) |

Every one of the six files passes `null` as the body; that is their only unusual
ingredient. No new enforcement code was needed — folding the three KEYWORD
literals (`null` / `true` / `false`) puts the call back on the AOT closure path,
where the enforcement already lives.

This is why the first two `hasOwnProperty`/dynamic-read rows agreeing was
misleading for a while: those surfaces were answered by the eval tier, so the
receiver looked healthy while four other surfaces on the same value did not
exist.

## What shipped

- **`src/codegen/function-instance-meta-methods.ts`** (new) — the physical-name
  side table, §10.2.9 for a member (`get `/`set ` prefixes, literal keys only),
  and §15.1.5 over the member's own parameter list. Reuses #4437's interning
  global and field definition through the new `fnMetaSlotOfMeta` export, so a
  method's `{name, length}` lands in the same per-`<length>:<name>` global as an
  identically-shaped function's and the two cannot disagree about layout.
- Mint sites wired: `ensureMethodClosureSingleton` (typed `C.prototype.m`), the
  `member-get-dispatch` fill arm (dynamic `c.m`), `emitObjectMethodAsClosure`
  (`{ m() {} }.m`), `emitFuncRefAsClosure` (STATIC `C.m`),
  `mintClosureStructTypes` (object-literal get/set accessors).
- `eval-inline.ts` — `keywordLiteralToString`, standalone-gated.

### Three things that were load-bearing

1. **The dynamic read builds the singleton INDEPENDENTLY.**
   `member-get-dispatch.ts`'s fill arm has its own `ref.is_null`-guarded lazy
   init writing the SAME cache global as `emitCachedMethodClosureAccess`.
   Whichever executes first wins. If only one pushed the `$fnmeta` operand,
   `C.prototype.m.name` would depend on whether the typed or the dynamic read
   ran first in the program. Both push it; the operand is recorded on the arm at
   RESERVE time (the fill must not mint types, globals or string literals) and
   **deep-cloned per splice**, because one arm feeds both the externref and the
   typed-f64 dispatcher and a shared `Instr` object double-remaps on a
   late-import shift.
2. **Declining beats guessing, and it costs nothing.** A computed or `#private`
   key records nothing, so `length` keeps #4436's `$arity` answer (the property
   never disappears) and `name` stays absent (never *wrong*). Pinned:
   `class C { [Symbol.iterator]() {} }` reports no `name` rather than `""`.
3. **The keyword fold is deliberately three tokens wide.** `undefined` is an
   ordinary, shadowable identifier; a numeric literal's ToString is
   Number::toString (`1e21` → `"1e+21"`, `0x10` → `"16"`). Getting either wrong
   publishes a wrong function BODY, which is far worse than declining. Pinned by
   asserting the IMPORT SECTION: a folded call links no `js2wasm:runtime-eval`,
   a declined one still does.

## Test Results

All figures below are from runs of `.tmp/run-one.mts` / `.tmp/run-list.mts` (the
real `runTest262File`, `--target standalone`) on **this branch's base** — the
merge of `claude/es5-standalone-pass-rate-6tk9rb` (#4437) — and on the change,
both mine. Nothing is inherited from `.test262-cache/test262-standalone-current.jsonl`,
which predates #4437 (it still records `language/statements/function/name.js`
as `fail`) and is therefore unusable as a before-state here.

### Target family 1 — the `*length-dflt.js` methods (all 11 method/setter files)

| | base | after |
| --- | ---: | ---: |
| pass | **0** | **8** |
| fail | 11 | 3 |

Flipped: `{statements,expressions}/class/{method,gen-method}-length-dflt.js`,
`statements/class/static-method-length-dflt.js`,
`expressions/object/method-definition/{generator,name}-length-dflt.js`,
`expressions/object/setter-length-dflt.js`.

The 3 non-flips fail with `TypeError: Cannot convert undefined or null to
object` — **identical on base**, a `gOPD` gap on the class prototype that has
nothing to do with `length` (it is #4437's already-recorded 3-file bucket). See
residual R1 below.

### Target family 2 — `built-ins/Function/length/` (the whole directory)

| | base | after |
| --- | ---: | ---: |
| pass | **7** | **13** |
| fail | 6 | 0 |

Flipped: `S15.3.5.1_A2_T1-T3` (DontDelete) and `S15.3.5.1_A3_T1-T3` (ReadOnly).
The other 7 (`A1_T*`, `A4_T*`, `15.3.3.2-1`) passed on base and still pass.

**Whole `built-ins/Function` directory, 509 files, A/B both mine: 346 → 351.**
The diff is exactly those 6 FAIL→PASS plus ONE PASS→FAIL,
`S15.3.2.1_A1_T10` — analysed in full below. Net **+5** in the directory the
fold touches most.

### The `f.constructor` family — a mis-attributed regression, and one real cost

Mid-slice this lane was asked to fix a reported **17-file ES≤5 regression**
(`The value of f.constructor is expected to equal the value of Function`, on
`built-ins/Function/S15.3.2.1_A1_T2..T12` / `_A3_T2..T14`) attributed to #4437,
since it sits in the modules reworked here.

**It is not a #4437 regression.** A/B'd across three trees, 28 files
(`S15.3.2.1_A{1,3}_T*`), all runs mine:

| tree | pass | failing |
| ---- | ---: | ------- |
| pre-#4437 (`09ecad8`, `src/` checked out wholesale) | 25/28 | A1_T6, A3_T3, A3_T15 |
| this branch's base (`09ecad8` + #4437) | 25/28 | **identical list** (`diff` empty) |

#4437 moves this family by **0**. A1_T6 and A3_T15 carry the reported signature
and fail the same way *before* #4437 exists.

**The real cause** is that there is no `.constructor` arm for a function-valued
receiver at all, so an AOT-compiled closure answers `undefined`. A NON-constant
`Function(…)` body routes to the runtime-eval tier, which *does* answer
correctly — which is exactly why the object/dynamic-body files (A1_T2..T5,
T7..T9, T11..T13) pass and the constant-body ones do not. Nothing to do with the
`$fnmeta` slot, the `spliceGopdPrologue` guard, or the `"anonymous"` change.

**On the CI figure itself** (load-bearing for anyone reading the baseline
trend): a per-run ES≤5 delta of this shape can be ENVIRONMENT, not code. The
whole family is served by the runtime-eval tier, and when that tier is
unavailable the entire family fails at once with one signature — reproduced
here: with `JS2WASM_EVAL_ENGINE=interpreter` (provider not prebuilt in this
container) the same 28 files go **0/28**. Before blaming a compiler commit for a
promote-to-promote delta in this family, check the eval-provider artifact of the
two runs.

**The one real cost this slice does incur** is `S15.3.2.1_A1_T10`
(`new Function(null)`): the fold moves it off the runtime-eval tier and onto the
AOT path, where `.constructor` is unimplemented. That is a 1-file regression
bought for the 6 `S15.3.5.1_A2/_A3` files, and it is pinned in
`tests/issue-4440.test.ts` so it cannot be forgotten.

**A fix was implemented, measured, and deliberately NOT shipped.** Both routes
were built:

1. **`__builtin_ctor_Function` carrier** (adding `"Function"` to
   `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES`, the #3006 route used for
   `Set`/`Map`/`Number`/…). Produced a genuine identity-stable object — and
   `f.constructor === Function` was **still false**, because the bare `Function`
   identifier read does not resolve through `emitBuiltinConstructorIdentity`.
   Two self-consistent objects that are not each other.
2. **Synthetic bare-`Function` identifier read** (the trick the
   `arguments.constructor` → `%Object%` arm already uses), gated on a callable
   receiver / the ambient `Function` interface. This WORKED — measured on the
   full 509-file `built-ins/Function` directory: **346 → 354, +9 / −1**, with
   `S15.3.2.1_A1_T6`, `S15.3.2_A1` and
   `Function/prototype/constructor/S15.3.4.1_A1_T1` flipping to pass.

It was dropped anyway, on a measurement the flip count hides: **the bare
`Function` value read pulls in the `js2wasm:runtime-eval` import**, so with the
arm in place ANY standalone module that reads `<fn>.constructor` stops being
host-free. Caught by `tests/issue-4440.test.ts`, which instantiates against an
empty import object and failed with
`Import #0 module="js2wasm:runtime-eval": module is not an object or function`
for a program containing nothing but `function g(a,b){}`. No gate measures
standalone-ness, so this would have shipped silently against the whole point of
the `standalone-gap` goal (#2860). +3 files is not worth that trade; the
prerequisite is a real self-contained `%Function%` carrier. Recorded as R6.

One further narrowing for whoever takes R6: with the arm in, the arm **fires**
for `A1_T10` (verified with a temporary `FIRE` trace) and the read still answers
`undefined`, while the identical arm in `A1_T6`'s module answers correctly. Both
compile the same synthetic `Function` identifier, so **two reads of the same
identifier in one program do not agree** — the divergence is inside
`compileIdentifier`'s bare-`Function` resolution
(`src/codegen/expressions/identifiers.ts`), not in the property-access arm, and
it is sensitive to the synthetic node's parent/text-range context. Start there.

### Target family 3 — `Expected obj[length] NOT to be writable` ×4

Three of the four are `S15.3.5.1_A3_T1-T3`, above. The fourth,
`built-ins/String/S15.5.5.1_A4_T2.js`, is `new String("…").length` — a String
exotic object, a different substrate entirely. Confirmed still failing on the
change with the same message; recorded as R3.

### Controls

- **Neighborhood A/B, 114 files** — every `name.js` / `*length*.js` /
  `fn-name-*.js` / `instance-name.js` / `prop-desc.js` under
  `language/{statements,expressions}` ∪ `built-ins/Function`. Base **54 pass**,
  after **62 pass**; the diff is exactly 8 FAIL→PASS lines and **zero
  PASS→FAIL**.
- **Stride sample, 128 files** — pool 13,417 files across
  `language/{statements,expressions}/{class,object,function,arrow-function,generators}`
  ∪ `built-ins/{Function,Object/{getOwnPropertyNames,getOwnPropertyDescriptor,defineProperty,keys},Reflect}`,
  every 105th taken. **108 pass on base, 108 after, status lines byte-identical**
  (`diff` empty).
- **gc/host byte-identity (sha256 A/B, both runs mine)** — 23 files
  (`website/playground/examples` ∪ `examples`) plus a 4-file corpus written for
  this change (class methods + static + accessors, object-literal
  methods/accessors, `new Function` with `null`/`true`/string bodies, a
  capture-carrying closure). **All 27 sha256s identical**; the diff is empty.
  Expected by construction — every entry point added here returns early unless
  `ctx.standalone` — and measured rather than asserted.

### Vitest

- `tests/issue-4440.test.ts` — new, **14 tests** (one of them PINS the A1_T10
  cost: `g.constructor === undefined`, with the flip-to-`Function` instruction
  written at the site for whoever lands R6).
- Controls, all green: `issue-4437` (19), `issue-4436` (23), `issue-2896`,
  `issue-4010`, `issue-4194-instance-expando`, `issue-4241-carrier-bag-slot`,
  `issue-4098-error-expando`, `issue-3468-closure-own-props`,
  `es5-standalone-function-semantics` — **164/164**.

### Gates

`typecheck`, `check:stack-balance`, `check:ir-fallbacks`,
`check:oracle-ratchet` (+0/+0), `biome lint` — all OK.
`check:loc-budget` and `check:func-budget` need the allowances in this file's
frontmatter (rationale in the comments there); with them, both OK.

## Residuals, with owners

| id | residual | why it is not fixed here | owner |
| -- | -------- | ------------------------ | ----- |
| **R1** | `{statements,expressions}/class/setter-length-dflt.js` and `expressions/class/static-method-length-dflt.js` throw `TypeError: Cannot convert undefined or null to object`. | Not a metadata defect — **identical on base**. These read `Object.getOwnPropertyDescriptor(C.prototype, "m").set`, and `gOPD` over a CLASS PROTOTYPE object returns `undefined` for an accessor member, so the test dereferences `undefined`. A class-prototype accessor-descriptor gap, adjacent to #4436's "class own-property stratum". The metadata half is already in place: an object-literal setter with the same shape now passes. | **unowned — next slice of #2860** |
| **R2** | Computed / symbol-keyed members decline the meta entirely (`[Symbol.iterator]() {}` reports no `name`, and `length` falls back to `$arity`). | The key is a runtime value at the mint site. §10.2.9 wants `"[Symbol.iterator]"`, which needs the well-known-symbol description at compile time or a runtime `SetFunctionName` on a MUTABLE `$fnmeta` slot. Declining is the safe state (absent, never wrong) and is pinned as such. Same root as #4437's R2. | **unowned** |
| **R3** | `built-ins/String/S15.5.5.1_A4_T2.js` — `new String("globglob").length` is writable. | A String exotic object, not a function object; §10.4.3 `length` lives on a different substrate with different attributes (`configurable: false`). Nothing in this slice touches it. | **unowned** |
| **R4** | `new Function` still declines the fold for a numeric or `undefined` body, so those calls keep the runtime-eval receiver and its missing gOPD/gOPN/delete/writable surfaces. | Deliberate: Number::toString is not trivially reproducible at compile time and `undefined` is shadowable (see "Three things that were load-bearing" #3). The **general** fix is to give the runtime-eval function object the own-property surfaces, not to widen the fold — that is a runtime-eval-boundary slice (Lane A), not a function-metadata one. | **unowned — runtime-eval boundary (Lane A)** |
| **R6** | `<function value>.constructor` answers `undefined` instead of `%Function%` (§20.2.3.1). Costs `built-ins/Function/S15.3.2.1_{A1_T6,A1_T10,A3_T15}`, `S15.3.2_A1`, `Function/prototype/constructor/S15.3.4.1_A1_T1` — 5 files, of which A1_T10 is this slice's one regression. | Pre-existing (A/B'd on the pre-#4437 tree). Both fixes were BUILT and measured here; see the `f.constructor` section above for why each was rejected. The blocker is that the bare `Function` value read has no self-contained carrier and pulls `js2wasm:runtime-eval`, so the working fix (+9/−1 over 509 files) would make every `.constructor`-reading standalone module non-host-free. Prerequisite: a real `%Function%` carrier that the BARE identifier read resolves to. Narrowed to `compileIdentifier`'s `Function` resolution in `src/codegen/expressions/identifiers.ts`. | **unowned — needs a `%Function%` carrier first** |
| **R5** | Class VALUES, builtin function objects (`eval`, `Proxy.revocable`'s revoker, Promise resolve/reject), `f.hasOwnProperty("prototype")`, and the static-fold/runtime-delete divergence. | Inherited unchanged from #4437's R3/R4/R5/R7 — different carriers, none touched here. | **unowned** |
