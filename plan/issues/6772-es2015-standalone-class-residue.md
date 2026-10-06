---
id: 6772
title: "ES2015 standalone class residue: this-before-super() ordering, return-override, class-ctor [[Call]] via call/apply, super() extras, computed-key side effects, `new`-named methods, static `constructor` accessors, comma heritage, RegExp `lastIndex` gOPD, heritage `prototype` getter, static/instance accessor slots"
status: in-progress
assignee: ttraenkler/opus-6772
sprint: current
created: 2026-09-30
updated: 2026-10-02
priority: high
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-lead
related: [6767, 5350, 6766, 6769, 6770, 6771, 5195, 5318, 5153, 4450, 2018, 1983]
loc-budget-allow:
  # 2026-09-30 (#6772 plan): thirteen mechanisms, each wired at the site that
  # already owns the shape; every body longer than ~40 lines goes in one of
  # the NEW leaves below. Existing files grow by hooks/arms only (S1a +6,
  # S1b hooks +2..+4 per site, S2 new-site swap +14, S5 +10, S6 +8/+12,
  # S7 +8, S9 +2, S10 one arm, S12 registration +4 per accessor kind).
  - src/codegen/class-bodies.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/this-keyword.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/statements/variables.ts
  - src/codegen/expressions/object-get-prototype-of.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/identifier-assignment.ts
  - src/codegen/class-member-keys.ts
  - src/codegen/declarations.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/externref-backed-class-rep.ts
  - src/codegen/class-call-without-new.ts
  - src/codegen/context/types.ts
  - src/codegen/context/create-context.ts
  - src/ir/planning-identity.ts
  # 2026-09-30 (#6772 S2, Opus implementation): a binding of a return-override
  # class may hold the FOREIGN override object, so the two sites that fold a
  # member read on the checker's class type (struct-name resolution / open
  # dynamic read, and `typeof`) take one-line hooks into the S2 leaf.
  - src/codegen/property-access.ts
  - src/codegen/typeof-delete.ts
  # 2026-10-01 (#6772 S4, Opus implementation): the two own-shadow method
  # lookups in the receiver-call ladder pass the member kind so a method named
  # `new` / `init` resolves to its relocated slot, not the allocator; prettier
  # wraps each lookup onto three lines (+4, no new logic).
  - src/codegen/expressions/call-receiver-method.ts
  # 2026-10-02 (#6772 merge of origin/main ce6631272c, Opus implementation):
  # #6797's flat-dir budget and import-cycle ratchet. The class leaves moved to
  # src/codegen/classes/ and reach the SCC helpers they need through the
  # late-bound core delegates; expressions.ts registers them (+5 imports, +6
  # registry entries), core-delegates.ts declares them (+6 types / wrappers).
  - src/codegen/expressions.ts
  - src/codegen/helpers/core-delegates.ts
  # NEW leaves, under src/codegen/classes/ (register each in scripts/compiler-boundaries.json, see Lane protocol)
  - src/codegen/classes/derived-ctor-this-guard.ts
  - src/codegen/classes/ctor-return-override.ts
  - src/codegen/classes/class-ctor-call-apply.ts
  - src/codegen/classes/class-heritage-runtime-get.ts
  - src/codegen/classes/class-static-accessor-keys.ts
  - src/codegen/classes/class-heritage-comma.ts # 2026-10-01 (#6772 S6, Opus implementation): comma-heritage peel + parent-binding proof
  - scripts/compiler-boundaries.json
func-budget-allow:
  # 2026-09-30 (#6772 plan): one-to-four-line call sites inside functions
  # already far over the threshold; every mechanism lives in a leaf.
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/class-bodies.ts::compileSuperCall
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/expressions/assignment.ts::compileElementAssignment
  - src/codegen/statements/control-flow.ts::compileReturnStatement
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/property-access-dispatch.ts::emitClassStaticMemberRead
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  # 2026-09-30 (#6772 S2, Opus implementation): one unsound-fold guard line
  # each, the same shape as the #4204 / #4428 guards beside them.
  - src/codegen/typeof-delete.ts::compileTypeofComparison
  - src/codegen/typeof-delete.ts::compileTypeofExpression
  # 2026-10-01 (#6772 S4, Opus implementation): same two wrapped lookups.
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  # 2026-10-01 (#6772 S6, Opus implementation): one routing line — a
  # `let C = class extends (e, P) {}` binding goes through module init so the
  # comma heritage's prefix runs at ClassDefinitionEvaluation.
  - src/codegen/declarations.ts::collectDeclarations
  # 2026-10-02 (#6772 S7, Opus implementation): the one `classExprAmbiguousNames`
  # initialiser in the context literal (the plan's context/types.ts field).
  - src/codegen/context/create-context.ts::createCodegenContext
---

## Problem

34 rows under `language/statements/class/**` and `language/expressions/class/**`
are non-pass in the ES2015 standalone baseline (2026-09-29 22:47 UTC;
11,229 / 11,704). They are NOT one defect. Measured on `origin/main`
@ `2ef807a6` (2026-09-30, `flock … run-test262-paths.mts .tmp/6772/rows.txt
--isolate --standalone`, log `.tmp/6772/base-sweep.log`): **33 fail + 1
compile_error, 0 pass**. Row list: `.tmp/6772/rows.txt` (paths relative to
`test262/test/`).

Bucketed by MECHANISM (the first failing assertion, confirmed by a minimal
probe on main — probes `.tmp/6772/p*.js`, runner `.tmp/6772/probe.mts`
(standalone, `imports: []`), node oracle `.tmp/6772/oracle.mjs`, verdict
logs `.tmp/6772/probes-base*.log`):

| # | mechanism | rows | probe: main → node |
| --- | --- | --- | --- |
| A | `this` / `super.x` / `super.m()` used BEFORE `super()` returns, and a SECOND `super()` — no ReferenceError (§13.3.7.1 step 8 BindThisValue / §9.1.1.3.1); the second call must still run the parent first | `definition/this-access-restriction.js`, `definition/this-check-ordering.js`, `definition/this-access-restriction-2.js` (also G, G2) | p1 0 → 3, p2 0 → 63, p3 14 → 15 |
| B | `super(a, b)` into a ZERO-formal parent that reads `arguments`: the extras are evaluated and DROPPED (class-bodies.ts:4558-4563) instead of published through `__extras_argv` the way the `new` site does (new-super.ts:8359-8365) | `arguments/access.js` | p5e 0 → 2121 (the `new Base(1,2)` site is fine: p5d 21 = node) |
| G | §10.2.1.3 [[Construct]] step 13 return-override with a FOREIGN object (`return o` / `return {}` / `return obj = {}`): the struct-typed constructor result cannot carry it, so `new C()` yields `this` | `subclass/class-definition-null-proto-contains-return-override.js`, `subclass/derived-class-return-override-with-object.js`, `subclass/default-constructor-2.js`, (+ `this-access-restriction-2.js`) | p4 8 → 63 (all four shapes wrong), p15 15 = node (everything else in `default-constructor-2.js` already passes) |
| G2 | a class constructor invoked through `.apply` / `.call` does not throw (`C()` already does, #4483 E) | `arguments/default-constructor.js`, (+ `this-access-restriction-2.js`) | p5c 0 → 15 |
| C1 | a computed member key that is an ASSIGNMENT (`[x = 1]() {}`) is constant-folded to its RHS (literals.ts:2600-2604) and the write never runs at ClassDefinitionEvaluation | `cpn-class-{decl,expr}-computed-property-name-from-assignment-expression-assignment.js`, `cpn-class-{decl,expr}-accessors-…-assignment.js` (4) | p6 14 → 15 (only bit 1, `x === 1` after the definition, is lost) |
| C2 | ONE `var C` assigned TWO class expressions in turn: `classExprNameMap` (declarations.ts:2668) is last-wins, so every `C.prototype.<k>` resolves against the wrong class | `expressions/class/accessor-name-inst-computed-in.js` | p7d 0 → 3 (one class alone: p7 bit 1 passes) |
| D | a class EXPRESSION's METHOD writing the class's own name (`new (class C { m() { C = 42; } }).m()`) does not TypeError; ctor / class-declaration methods do (#5195 Step 9 I) | `name-binding/const.js` | p8c 1 → 3; p8a/p8b/p8d = node |
| H1 | a method literally named `new` (escaped `new` or not) registers under `${C}_new` — the ALLOCATOR's own funcMap key — so `new C()` calls the method: invalid Wasm `local.tee … expected (ref null $C), found f64` in `__module_init`, even when the method is never called | `{statements,expressions}/class/ident-name-method-def-new-escaped.js` (2) | p9, p9b, p9c: CompileError on all three |
| H2 | `static get constructor()` / `static set constructor(_)`: `C.constructor` folds to the class object instead of calling the static accessor (p10 bit 4), and passing `C.prototype.constructor`/`C.constructor` into a helper traps "illegal cast" | `{statements,expressions}/class/elements/syntax/valid/grammar-static-ctor-accessor-meth-valid.js` (2) | p10 3 → 7; p10e (harness shape) illegal cast; p10d 3 = node |
| H3 | `class D extends (calls++, C) {}`: the IR planner throws `indexed support unit …:class-implicit-constructor… has no R0 terminal owner` (planning-identity.ts:409-413) for the `calls++` node — a top-level implicit-ctor SUPPORT unit is registered with a null owner (identity.ts:1233-1241) and the heritage expression's nodes walk up into it; plus R4: `Object.getPrototypeOf(D)` must be `C` (#6767 residual R4) | `definition/side-effects-in-extends.js` (the one compile_error) | p11 COMPILE-FAIL → 15 |
| E | `class RE extends RegExp {}`: the instance IS a real `$RegExp` (new-site lowering, #6651 C5) but `Object.getOwnPropertyDescriptor(re, 'lastIndex')` is `undefined` — also for a PLAIN `new RegExp()` (carrier gOPD arm missing; `hasOwnProperty` answers true) | `subclass/builtin-objects/RegExp/lastIndex.js` | p13d 8 → 15 |
| I | heritage that is a bound function with a `prototype` ACCESSOR: nothing evaluates `Get(superclass, "prototype")` at definition (class-heritage-check.ts is compile-time proof only and declines a `get` key), so the getter is never called and `42` never throws | `definition/prototype-getter.js` | p17 0 → 7; the carrier supports it: p17b 15 = node |
| F/R1 | static + instance accessor of the same name share ONE function slot `${C}_get_${name}` (class-bodies.ts:1839-1844 `continue`) — #6767 residual R1 | `definition/getters-restricted-ids.js`, `definition/fn-name-accessor-get.js`, `definition/fn-name-accessor-set.js` (the last two also need R3 + accessor `name`) | p12 4 → 63 (bit 1 `gOPD(A.prototype,'id')`) |
| F/R2 | `caller`/`arguments` on a method VALUE must throw (%ThrowTypeError%, §10.2.4); the typed fold exists (`function-poison-pill-access.ts`), the runtime arm does not — #6767 residual R2 | `definition/methods-restricted-properties.js`, (half of) `strict-mode/arguments-callee.js` | p12 bits 8/16, p14 0 → 3 |
| E2 | `class extends <TypedArray>` / `ArrayBuffer` / `GeneratorFunction` construct no carrier at all (`byteLength`/`length` undefined even through an untyped read); GeneratorFunction needs provider-side dynamic function construction | 9 rows — see "Deferred" | p13c 384 → 1023; p16 needs the eval provider |

Two internal errors surfaced by probes that are NOT in the 34 rows (file
separately, do not fix here): (i) two same-named block-scoped classes
extending a parent that has a METHOD → `Internal error … inherited class
callable __anonClass_C_0_method is not exact child physical key C_method`
(`program-abi-class-callable-planning.ts:602`, probe p2b); (ii) a module-level
`try { class C … }` plus a same-named class inside an IIFE → `projected local
class C carries ir-class:… instead of …` (`ir/module-bindings.ts:239`, probe
p8 first cut).

## Implementation Plan (2026-09-30, Fable lane; Opus implements)

Order: S1a → S1b → S2 → S3 (one row needs all three) → S4 … S12 in any
order (independent), S13 optional last. Everything new is gated on
`ctx.standalone` unless a step says otherwise; the host lane stays
byte-identical (verify with a `compile()` sha256 A/B on p1/p4/p9 for
`target: undefined`). Type queries go through `ctx.oracle`, never
`ctx.checker`. Every step: probe on base FIRST (`.tmp/6772/base-src` =
`git archive origin/main src`), then on the branch, then its rows.

### Step 0 — base copies and the before-state

`mkdir -p .tmp/6772 && git archive origin/main src | tar -x -C .tmp/6772/base-src`;
re-run `.tmp/6772/rows.txt` and every `.tmp/6772/p*.js` probe on the
unmodified tree (`npx tsx .tmp/6772/probe.mts .tmp/6772/p1.js …`) and keep
the logs. The QuickJS eval provider must be built for your src tree
(`node --import tsx scripts/build-quickjs-eval-provider.mjs`, seed with
`JS2WASM_QUICKJS_ARTIFACT_DIR=<any sibling worktree's .test262-cache/quickjs-artifact-*>`
to skip the 3-min cold build) — `getters-restricted-ids.js` is the only row
that needs it.

### S1a — `super(...)` publishes the extras a zero-formal `arguments` parent reads (B)

(a) Rows: `arguments/access.js`.

(b) `src/codegen/class-bodies.ts::compileSuperCall`, the `flatArgs` arm at
`:4551-4567`. Today: args beyond `paramTypes.length` are compiled and
`drop`ped (`:4558-4563`); `maybeSetArgcForKnownCall` at `:4604` publishes
`__argc` only.

(c) When `ctx.funcUsesArguments.has(parentInitName)` and
`flatArgs.length > paramTypes.length`: replace the drop loop with
`emitSetExtrasArgv(ctx, fctx, flatArgs, paramTypes.length)` (imported in
class-bodies.ts already; the `new` site's exact idiom, new-super.ts:8359-8365,
and the zero-formal runtime-spread arm two lines below at `:4583-4589`). Keep
the `evaluateArgumentForSideEffects` drop loop for parents that do NOT read
`arguments` (byte-identical). `actualArgCount` stays `flatArgs.length`.

(d) Order: extras are evaluated left-to-right after the positional args,
exactly as today. ES5 risk: `emitSetExtrasArgv` is shared with every
function call's extras protocol — do not touch its body. Pins: ES5
`language/arguments-object/**` (mapped + unmapped, every currently-passing
row) and `tests/issue-5153*.test.ts`, `tests/issue-2202*.test.ts` if present.

(e) Acceptance: p5e = 2121; `arguments/access.js` passes; p5d stays 21.

### S1b — uninitialised-`this` guard on every `this` use in a derived constructor, and a second `super()` throws AFTER running the parent (A)

(a) Rows: `definition/this-access-restriction.js`, `definition/this-check-ordering.js`;
with S2 + S3 also `definition/this-access-restriction-2.js`. Also the
ReferenceError half of `subclass/builtin-objects/GeneratorFunction/super-must-be-called.js`
(already passing; must stay so).

(b) Files. NEW leaf `src/codegen/derived-ctor-this-guard.ts` holding the
mechanism; hooks in:
- `src/codegen/expressions/new-super.ts`: `classifySuperUninitializedRead`
  (`:1710`) — generalise to `classifyUninitializedThisAccess(fctx, node)`
  (same walk, same "never/always/runtime" answers; the node may be a
  `ThisKeyword`, a `super.x`/`super[x]` reference, a `super.m()` callee, or
  a nested `super(...)` call). `ensureSuperInitializedFlagLocal` (`:1823`) —
  widen `needed`. `emitSuperInitializedFlagStore` (`:1860`) — becomes
  `emitSuperCallBindThis` (below). Move the three into the leaf; new-super.ts
  keeps re-exports or imports (line-neutral there).
- `src/codegen/expressions/this-keyword.ts::compileThisKeyword` (`:30`): after
  the inline-IIFE rung (`:40-43`) and BEFORE the typed-this / `localMap`
  rungs, call `emitUninitializedThisGuard(ctx, fctx, expr)`.
- `src/codegen/expressions/assignment.ts`: `compilePropertyAssignment` and
  `compileElementAssignment` take `this` receivers without going through
  `compileThisKeyword` (`tryEmitTypedThisFieldSet` `:4942`, the `pinnedThis`
  arm `:4948`, `tryEmitPinnedStructMemberSet`). Call the same guard once at
  the top of each when `skipTransparentExpressions(target.expression).kind ===
  ThisKeyword`. Probe `this.x = 3`, `this[k] = 3`, `this.x += 1`, `this.x++`
  (unary-updates.ts / operator-assignment.ts read `this` through
  `compileExpression` → covered by the this-keyword hook; verify).
- `src/codegen/expressions/new-super.ts::compileSuperMethodCallCore` (via
  `compileSuperMethodCall` `:1438`): guard at entry (the row's
  `super.method(); super(this)` needs the ReferenceError at the CALL, whose
  lowering has no guard today — the `:1841` comment).
- `src/codegen/class-bodies.ts:3068-3069` (statement `super(...)`) and
  `src/codegen/expressions/calls.ts:8079-8080` (nested `super(...)`): replace
  `emitSuperInitializedFlagStore(fctx)` with `emitSuperCallBindThis(ctx, fctx)`.

(c) Design.
- `emitUninitializedThisGuard`: `if (!ctx.standalone || !fctx.isDerivedConstructor) return;`
  classify the node: `"never"` → nothing; `"always"` → `emitThrowReferenceError`
  (the #5350 message, `new-super.ts:1880`) and fall through to the ordinary
  lowering (dead but well-typed code); `"runtime"` →
  `local.get $__js2_super_done; i32.eqz; if { throw }` then the ordinary
  lowering (the `:1886-1894` shape). "always" already covers a `this` INSIDE
  a `super(...)` argument list: that `super()` has not ENDED before the node,
  so it is not "preceded" (§13.3.7.1 evaluates the arguments before
  BindThisValue — `super(this.x)` / `super(this)` / `super(1, 2,
  Object.getPrototypeOf(this))` all throw while evaluating the argument).
- `ensureSuperInitializedFlagLocal` allocates the flag when ANY of: (i) some
  `this`/`super`-reference/`super.m()`-callee node in the constructor frame
  classifies `"runtime"` (today: `super.x` reads only); (ii) the constructor
  frame contains MORE than one `super(...)` call node (walk with the existing
  nested-class skip; nested FUNCTIONS/arrows are descended into for the
  count but their calls cannot set the flag — record that as the xa8-style
  residual); (iii) any constructor-frame `super(...)` lies inside an
  iteration statement.
- `emitSuperCallBindThis` (after `compileSuperCall` returned — the parent
  has run, §13.3.7.1 step 6 before step 8):
  ```wasm
  ;; only when the flag local was allocated
  local.get $__js2_super_done
  if                       ;; already initialised → §9.1.1.3.1 ReferenceError
    <restore $__ctor_override from the saved local, S2>
    <emitThrowReferenceError "Must call super constructor …">
  end
  i32.const 1
  local.set $__js2_super_done
  ```
  Without the flag (a single straight-line `super()`), the store stays a
  no-op exactly as today. `this-check-ordering.js` asserts, for a second
  `super(f())` after the first `super()`: the parent ran (`baseCalled === 1`),
  `f()` ran (`fCalled === 1`), ReferenceError, and `this === obj`. The
  second call re-runs the parent `_init` on the SAME `selfLocal` (accepted
  deviation: a parent that writes fields re-initialises them; the rows in
  scope do not observe it — record). Its nested shapes follow from "every
  `super()` throws at its OWN completion once `this` is initialised":
  `super(super(), f())` → the INNER `super()` runs Base (baseCalled 1) and
  throws, so `f()` never runs (`fCalled === 0`, node agrees);
  `super(f(), super())` → `f()` runs (1), the inner `super()` runs Base (1)
  and throws. Both are the design above with no special casing. p3 pins the
  first shape; add the two nested shapes to the pin file.
- S2 interplay: when the class's ancestor chain is override-capable (S2),
  spill `global.get $__ctor_override` into a temp local before
  `compileSuperCall` and restore it in the throw arm, so a discarded second
  construction cannot replace the first call's override object
  (`this-access-restriction-2.js` `Subclass2`: `s2.prp === 3` from the first
  call).

(d) Order-preservation: `ensureSuperInitializedFlagLocal` runs before the
body loop (`class-bodies.ts:3060`) — keep it there; the Promise on-host body
(`:4104-4129`) keeps the old store (host lane). ES5 risk: none (derived
constructors only); the this-keyword hook returns immediately outside a
derived constructor — pin ES5 `language/statements/function/**` +
`language/expressions/this/**` (every currently-passing row) to prove the
early return. Class pins: `tests/issue-5350-super-property-r1.test.ts` (18),
`issue-2709`, `issue-5195-es2015-class-r2`, `issue-5195-r3-*`,
`issue-3522-super-accessor`, `issue-3024-static-super-arity`,
`issue-5309`, `issue-5312`, `issue-6767-class-definition-reflective`.

(e) Acceptance: p1 = 3, p2 = 63, p3 = 15; the two rows pass; #5350's xa/n/g
probe answers unchanged (re-run `.tmp/rev5350*/p/*.ts` if still present in
the shared `.tmp`, else the 18 pins).

### S2 — return-override channel: `new C()` yields the object a constructor returned (G)

(a) Rows: `subclass/class-definition-null-proto-contains-return-override.js`,
`subclass/derived-class-return-override-with-object.js`,
`subclass/default-constructor-2.js`; with S1b + S3 also
`definition/this-access-restriction-2.js`.

(b) Files: NEW leaf `src/codegen/ctor-return-override.ts` (pre-scan,
global, the two emitters); `src/codegen/context/types.ts` +
`create-context.ts` (`classReturnOverrideSet: Set<string>`);
`src/codegen/class-bodies.ts::collectClassDeclaration` (call the pre-scan
after the parent link is known, `:1141-1190` region);
`src/codegen/externref-backed-class-rep.ts::externrefBackedClassValType`
(`:47-54`, one arm); `src/codegen/statements/control-flow.ts` struct return
arm (`:448-542`); `src/codegen/expressions/new-super.ts` user-class `new`
site (`:8387-8408`).

(c) Design — keep the struct representation, add a side channel:
- Pre-scan `ctorMayReturnObject(decl)`: the class's OWN constructor body
  (not nested functions) contains a `return <expr>` whose `<expr>` is not
  `this`, not a literal primitive, not `undefined`/`void 0`, and not
  statically primitive per `ctx.oracle` (the flag set the arm at `:390-396`
  already uses). Mark the class in `ctx.classReturnOverrideSet`; then
  propagate to every class whose ancestor chain (`classParentMap`) contains
  a marked class (the override flows through `super()`). `class Foo extends
  null` has no `classParentMap` entry and is scanned as a base. Standalone
  only.
- One module global `$__ctor_override: externref` (null), minted on demand.
- Return arm (control-flow.ts): for `fctx.isConstructor` (NOT
  `isFnctorConstructor` — ES5 function constructors keep `#2018`/`#4464`)
  and `classReturnOverrideSet.has(resolveEnclosingClassName(fctx))`, replace
  the `ref.test`-or-`this` body at `:505-530` with:
  ```wasm
  ;; operand already compiled, coerced to externref (extern.convert_any for ref)
  local.tee $ret
  ref.is_null
  if
    ;; null / undefined-null → discard
  else
    local.get $ret  call $__typeof_object
    local.get $ret  call $__typeof_function
    i32.or
    if  local.get $ret  global.set $__ctor_override  end
  end
  local.get $self          ;; the struct is still the function's result
  ```
  (`__typeof_undefined` first when `undefined` is a distinct extern value on
  this lane — mirror `:323-377`). The `_init` twin (the `${C}_init` body is
  the same `compileReturnStatement`) is covered because `super()` calls
  `_init` directly.
- `new` site (new-super.ts, after `call finalCtorIdx` and the new.target
  restore at `:8396-8407`, before `return { kind: "ref" }`): when
  `classReturnOverrideSet.has(className)`:
  ```wasm
  local.set $tmp                 ;; (ref $C)
  global.get $__ctor_override
  ref.is_null
  if (result externref)
    local.get $tmp  extern.convert_any
  else
    global.get $__ctor_override
    ref.null.extern  global.set $__ctor_override
  end
  ```
  and return `{ kind: "externref" }`.
- `externrefBackedClassValType`: `if (ctx.classReturnOverrideSet.has(name)) return { kind: "externref" }`
  so every binding/param/field typed as such a class is an externref slot
  (the #5201 precedent; `var b = new Base(1, 2); b.prp` then reads through
  `__extern_get`, whose class-instance arm answers a struct's declared field
  — measure `b.prp`, `s2.x`, a method call `b.m()` and `b instanceof Base`
  on a NON-overridden instance of a marked class in the pin file).

(d) Order: the pre-scan must run before `resolveWasmType` is consulted for
any binding of the class (collection phase, same place `classExternrefBackedSet`
is filled). The S1b flag store's override restore depends on this global.
ES5 risk: the return arm is `fctx.isConstructor`-only and set-gated; the
type hook is name-gated; `new` site is set-gated — no ES5 program has a
class. Pins anyway (the arms sit in shared functions): ES5
`language/expressions/new/**`, `language/statements/function/13.2.2-*`
(construct return semantics), `built-ins/Function/**` currently-passing
rows; class pins as S1b plus `tests/issue-2018*.test.ts`, `issue-4450*`,
`issue-5201*`.

(e) Acceptance: p4 = 63; the three rows pass; p15 stays 15; host-lane bytes
of p4 unchanged. Residual to record: a DERIVED constructor's `this` after a
`super()` whose parent overrode is not re-bound (§9.1.1.3.1 on the derived
frame) — `this.x` after such a `super()` writes the discarded struct.

### S3 — class constructors invoked through `call` / `apply` throw (G2)

(a) Rows: `arguments/default-constructor.js`; with S1b + S2
`definition/this-access-restriction-2.js`.

(b) NEW leaf `src/codegen/class-ctor-call-apply.ts`; export
`sourceClassForCallee` from `class-call-without-new.ts:44` (currently
module-private); hook in `src/codegen/expressions/calls.ts::compileCallExpression`
immediately before the existing `X.call(…)`/`X.apply(…)` lowering (grep
`=== "apply"` in calls.ts; place the hook where `tryEmitClassConstructorCallWithoutNew`
is called and mirror its position for the member-call shape).

(c) Design: callee `<expr>.call(...)` / `<expr>.apply(...)` /
`<expr>.bind(...)()`-free shapes where `sourceClassForCallee(ctx, <expr>)`
resolves (a class of THIS program; ambient classes decline — the whole
correctness story of that file). Evaluate `<expr>`, then each argument
(§13.3.6.1 order), drop, `emitThrowTypeError("Class constructor X cannot be
invoked without 'new'")`, push `ref.null.extern`, return externref — the
#4483 E shape verbatim. `Reflect.apply(C, …)` / `Function.prototype.call.call(C, …)`
reach the dynamic closure-apply terminal: if `__is_class_object`
(object-get-prototype-of.ts:575 names it as a separate identity ladder) is
reachable from `__apply_closure`'s callee classification, add a throw arm
there too; otherwise record.

(d) ES5 risk: the hook declines every non-class callee before compiling
anything (pure AST test) — pin ES5 `built-ins/Function/prototype/{call,apply}/**`
and `language/expressions/call/**` currently-passing rows.

(e) Acceptance: p5c = 15; `arguments/default-constructor.js` passes; with
S1b+S2, `this-access-restriction-2.js` passes (its `Base.call(new Object(), 1, 2)`
and `Subclass.call(…)` both take this arm).

### S4 — a member named `new` / `init` must not take the allocator's funcMap key (H1)

(a) Rows: `statements/class/ident-name-method-def-new-escaped.js`,
`expressions/class/ident-name-method-def-new-escaped.js`.

(b) `src/codegen/class-member-keys.ts::classMemberFuncKey` (`:47-70`). The
allocator registers `${className}_new` with `kind === undefined`
(new-super.ts:4608/4993/8387); methods register with `kind` set
(class-bodies.ts:1685/1800/3218).

(c) Add, before the `topLevelFunctionNames` rule: when `kind !== undefined`
and `fullName` ends in `_new` or `_init` and the prefix names a class
(`ctx.classSet.has(prefix)` — the class is in the set before its members
are minted; verify), relocate: `key = \`__cm$member$${fullName}\``. Both
producer (registration) and every consumer already route through this
helper with the same `kind` (#1983 contract), so no other site changes.
TS cooks `new` to `"new"` (`member.name.text`), so one rule covers
both spellings — probe p9 AND p9b.

(d) Residual: the inheritance loop (class-bodies.ts:1957) skips suffix
`new`/`init`, so a subclass does not inherit a method named `new` — record.
ES5 risk: none (class members only); pin `tests/issue-1983*.test.ts`.

(e) Acceptance: p9 = 42, p9b = 42, p9c = 7; both rows pass.

### S5 — a FOLDED computed key still runs its assignment at ClassDefinitionEvaluation (C1)

(a) Rows: the four `cpn-class-*-computed-property-name-from-assignment-expression-assignment.js`.

(b) `src/codegen/statements/nested-declarations.ts::emitUnresolvedComputedAccessorNameEffects`
(`:456-485`; both class-declaration call sites `:614`/`:673` and the
class-expression route in new-super.ts already call it, in member order).

(c) The `continue` at `:464-473` skips a member whose key
`resolveComputedKeyExpression` folds. Add a second arm: the key folds AND
`ts.isBinaryExpression(e) && e.operatorToken.kind === EqualsToken` (the
literals.ts:2600-2604 fold arm; also cover `++`/`--` and call expressions if
`resolveConstantExpression` ever folds them — it does not today) →
`compileExpression(ctx, fctx, member.name.expression)` and `drop` (no
`__cmkey_` global write: the folded name is still the property key). Keep
the members' relative order (one loop). This emitter runs on every lane, so
host bytes move for exactly these shapes — spec-correct; note it.

(d) ES5 risk: none (computed class keys are ES2015; object-literal computed
keys take a different emitter — do not touch literals.ts). Pins:
`tests/issue-5195*` (Step 1 computed keys), `issue-5318-r4/r5`.

(e) Acceptance: p6 = 15; four rows pass.

### S6 — heritage-clause nodes are owned by the enclosing scope, and `Object.getPrototypeOf(D)` is the parent class (H3 + R4)

(a) Rows: `definition/side-effects-in-extends.js`.

(b) `src/ir/planning-identity.ts::requireIrPlanningOwnerUnitId` (`:392-419`);
`src/codegen/expressions/object-get-prototype-of.ts` next to
`tryEmitStandaloneBaseClassGetPrototypeOf` (`:272-291`) and its call at
`:339-342`.

(c) IR: in the parent walk, when the matched `unit.kind ===
"class-implicit-constructor"` has `terminalOwnerId === null` (the top-level
support unit, identity.ts:1233-1241) and `node` lies inside the class
declaration's `heritageClauses` (`current` is the ClassLikeDeclaration and
`node.pos` is within a heritage clause's range) → `continue` the walk: the
heritage expression is evaluated in the ENCLOSING scope, never in the
constructor. Do not change the inventory (a null owner is deliberate for a
support unit). R4: add `tryEmitStandaloneDerivedClassGetPrototypeOf`: arg0 an
identifier naming a class with `ctx.classParentMap.get(name)` a USER class
(`ctx.classSet.has(parent)`) → compile arg0 for side effects (drop), then
`emitLazyClassObjectGet(ctx, fctx, parent)` (extern.ts:449, pushes the class
object; `extern.convert_any` if it is a ref) → externref. A builtin parent
answers the builtin constructor value only if `emitBuiltinConstructorIdentity`
has it; otherwise decline (record). Standalone-only; call it right after the
base-class helper at `:341`.

(d) ES5 risk: the IR walk change is keyed on a class-only unit kind — pin
`pnpm run check:ir-fallbacks` (no bucket may grow) and `tests/ir-*.test.ts`;
the fold is class-gated — pin ES5 `built-ins/Object/getPrototypeOf/**`.

(e) Acceptance: p11 = 15; the row passes; `#6767`'s q3 probe
(`Object.getPrototypeOf(D)` for a derived D) now answers the parent — update
the RESIDUAL pin in `tests/issue-6767-class-definition-reflective.test.ts`
to the fixed expectation.

### S7 — a binding assigned more than one class expression resolves dynamically (C2)

(a) Rows: `expressions/class/accessor-name-inst-computed-in.js`.

(b) `src/codegen/declarations.ts` `:2655-2670` (assignment-RHS class
expressions) and the var-name bridge near `:2798-2810`; `context/types.ts`
(`classExprAmbiguousNames: Set<string>`).

(c) At `:2664-2669`: if `ctx.classExprNameMap.get(nameHint)` already maps to
a DIFFERENT synthetic name (or the name is in `classExprAmbiguousNames`),
delete the entry and add the name to the set; guard both `set` sites with
the set. A read `C.prototype.<k>` / `new C()` for an ambiguous `C` then takes
the runtime path (`C` is an externref holding the class object; `__extern_get(C,
"prototype")` answers the prototype `$Object` (#5195/#6767 view) and the
runtime-keyed accessor is reached through its `__cmkey_` global). Measure —
if the dynamic `new C()` path declines for a class-object value, name the
arm (`__native_construct_<N>`, #3981) and record.

(d) ES5 risk: none. Pins: `tests/issue-5318-r4-computed-accessor-keys.test.ts`,
`issue-5383-class-value-dynamic-call`, `issue-4770-class-name-descriptor`.

(e) Acceptance: p7d = 3; the row passes; p7 stays 1-bit-passing.

### S8 — a class-expression METHOD writing the class's own name is a TypeError (D)

(a) Rows: `name-binding/const.js`.

(b) First determine the route: p8c's method (`new (class C { m() { C = 42; } }).m()`)
— run with `trackFallbacks`/`JS2WASM_IR_TRACE` (see `src/ir/select.ts` and
`plan/log/ir-adoption.md`) to learn whether the method body is IR-compiled.
`isConstIdentifierAssignmentTarget` (`expressions/helpers.ts:80-119`) already
answers `true` for this write, so the legacy path throws; the miss is either
(i) the IR lowering of identifier assignment (no class-name-immutable rule),
or (ii) the legacy identifier-write arm for a name that has NO slot in the
method's frame (`identifier-assignment.ts::resolveModuleAwareIdentifierWriteTarget`
region) not consulting `tryConstSet`.

(c) For (i): the smallest correct change is a SELECTOR decline in
`src/ir/select.ts` for a class member whose body assigns the enclosing class
expression's own name (a `writeIsInsideOwnClassBody`-style lexical test) —
the legacy path then throws; record the IR-lowering gap. For (ii): call
`tryConstSet` before that arm. Either way the throw must follow RHS
evaluation (§13.15.2).

(d) ES5 risk: (ii) touches the shared identifier-write path — pin ES5
`language/expressions/assignment/**`, `language/identifier-resolution/**`,
`language/statements/variable/**` currently-passing rows; (i) pin
`check:ir-fallbacks` (the `body-shape-rejected`-style bucket may grow by
exactly this shape — grant it in `scripts/ir-fallback-baseline.json` only via
`pnpm run check:ir-fallbacks -- --update` with the reason in the commit).

(e) Acceptance: p8c = 3; p8a/p8b/p8d unchanged; the row passes.

### S9 — a static accessor named `constructor` wins over the class-object `.constructor` fold (H2)

(a) Rows: `statements/class/elements/syntax/valid/grammar-static-ctor-accessor-meth-valid.js`,
`expressions/class/elements/syntax/valid/grammar-static-ctor-accessor-meth-valid.js`.

(b) `src/codegen/property-access-dispatch.ts` class-object `.constructor`
arms: `emitClassStaticMemberRead` (`:2299`) at `:2359`
(`propName === "constructor" && !ctx.staticMethodSet.has(fullName)`) and
`finalizeStructAndDynamicMemberGet` (`:4238`) at `:4450`
(`ctx.classSet.has(typeName)`). The `:547` arm inside
`tryConstructorPrototypeIdentity` is the AMBIENT-builtin identity fold and is
not touched.

(c) Add `&& !ctx.staticAccessorSet.has(\`${className}_constructor\`)` to both
so the ordinary static-accessor read (`C.sx`, #6767 p11) runs and `C.constructor`
answers the getter's value (`undefined` in the row). Then re-measure p10e
(`notSame(C.prototype.constructor, C.constructor)` through an untyped
2-parameter helper — the harness `assert.notSameValue` shape): if the
"illegal cast" persists it is the #6767 (b) family (call-site parameter
inference narrowing a `<Class>.prototype.constructor` argument to `$C`);
extend the withdrawal predicate in `class-proto-object.ts` (consumed by
`declarations/param-return-inference.ts`) to that spelling.

(d) ES5 risk: the standalone `.constructor` arms are shared with every
receiver — the added condition only narrows a CLASS-object arm. Pin ES5
`built-ins/Object/prototype/constructor/**`, `built-ins/Function/prototype/constructor/**`
and every ES5 `**/prototype/constructor/**` row currently passing; class
pins `tests/issue-5195-r3-restricted-properties.test.ts`,
`issue-6767-class-definition-reflective`.

(e) Acceptance: p10 = 7, p10c (harness form) = 7 without a trap; both rows pass.

### S10 — `Object.getOwnPropertyDescriptor(<RegExp>, "lastIndex")` (E, RegExp)

(a) Rows: `subclass/builtin-objects/RegExp/lastIndex.js`.

(b) `src/codegen/object-runtime-descriptors.ts` — the
`__getOwnPropertyDescriptor` carrier ladder (grep `__create_descriptor`
callers and the `$RegExp` `ref.test` arm `__hasOwnProperty` uses to answer
`true` for `lastIndex`, p13d bit 8; mirror that arm).

(c) When the receiver is a `$RegExp` carrier and the key is `"lastIndex"`:
`__create_descriptor(<lastIndex field as externref>, FLAG_WRITABLE)` —
§22.2.7.1: writable, non-enumerable, non-configurable. Dynamic key only
(the row calls `verifyProperty`, a helper with runtime receiver AND key).
`verifyProperty` also WRITES and DELETES to check the attributes — the
existing `lastIndex` [[Set]] on the carrier must honour the write
(`re.lastIndex = v` already works: `built-ins/RegExp/prototype/exec/**`
pass) and `delete re.lastIndex` must answer `false` (non-configurable); probe
both. Cross-reference #6770 (Object/Reflect residue, planned in parallel;
not published at plan time) — if it lands a general native-carrier gOPD
ladder first, put the arm there instead of duplicating.

(d) ES5 risk: `__getOwnPropertyDescriptor` is ES5-critical — pin every
currently-passing ES5 row under `built-ins/Object/getOwnPropertyDescriptor/**`
(15.2.3.3-*) and `built-ins/RegExp/**` (S15.10.*), plus
`tests/issue-4491*`, `issue-4098*`.

(e) Acceptance: p13d = 15; the row passes.

### S11 — a runtime heritage's `prototype` is read (once) at definition, with the §15.7.14 5.h check (I)

(a) Rows: `definition/prototype-getter.js`.

(b) NEW leaf `src/codegen/class-heritage-runtime-get.ts`; callers: the three
`emitStandaloneHeritageCheck` sites (`statements/variables.ts:62` import
site, `statements/nested-declarations.ts:59`, `expressions/new-super.ts:162`
— one line after each existing call). `class-heritage-check.ts` itself is
NOT edited (compile-time proof only — its F1 rule; `:482-486` documents that
in standalone nothing else evaluates a runtime heritage today).

(c) For a standalone class whose heritage `heritageExpressionNeedingRuntimeCheck`
declines, that is not `null`, not a resolved local class, not a builtin in
`classBuiltinParentMap`, not a linked-provider parent
(`classLinkedDynamicParentExpr`), i.e. exactly the
`classDynamicUnresolvedHeritageSet` members: compile the heritage expression
ONCE → `$v`; `__typeof_function($v)` else throw TypeError "Class extends
value is not a constructor or null" (IsCallable approximates IsConstructor —
an arrow heritage is not caught; record); `__extern_get($v, "prototype")` →
`$p` (the carrier supports accessor properties on a bound function, p17b);
`if $p is not null AND not (__typeof_object | __typeof_function) → throw
TypeError "Class extends value does not have valid prototype property"`
(message twin of class-heritage-check.ts:507). Stack-neutral; no prototype
link is created (the class stays a root struct, as today). Use
`withSpeculativeCompile` exactly as `emitStandaloneHeritageCheck` does so a
declined compile rolls back.

(d) Order: evaluate BEFORE the class binding is initialised (the check
throws before `C` exists). ES5 risk: none. Pins:
`tests/issue-5195-r3-heritage-check.test.ts`, `issue-6767` step-3 cases
(their heritages are PROVABLE and must keep taking the proof, not this arm —
assert bytes unchanged for `constructable-but-no-prototype.js`'s shape),
`issue-6640*`/`issue-6644*` (linked parents must decline here).

(e) Acceptance: p17 = 7; the row passes.

### S12 — static and instance accessors of one name get distinct function slots (F/R1)

(a) Rows: `definition/getters-restricted-ids.js` (expected to flip);
`definition/fn-name-accessor-get.js`, `definition/fn-name-accessor-set.js`
(measured — they additionally need the runtime-keyed static view, #6767 R3,
and `verifyProperty(getter, 'name', …)` on accessor closures whose names
are `"get id"` / `"get "` / `"get [test262]"`; name the first failing
assertion after this step).

(b) NEW leaf `src/codegen/class-static-accessor-keys.ts` (the key helper +
the instance-accessor name set); `src/codegen/class-bodies.ts` pre-population
loop `:1640-1650` (add non-static accessor func names to
`ctx.classInstanceAccessorFuncNames`), registration `:1839-1844` /
`:1882-1884` and the emit twins `:3688` / `:3803` (pass the kind);
`src/codegen/class-member-keys.ts::classMemberFuncKey` (`:64-66`): extend
the static-relocation condition to `ctx.classMethodSet.has(fullName) ||
ctx.classInstanceAccessorFuncNames.has(fullName)` so `C_get_eval` (static)
relocates to `__cm$static$C_get_eval` when the instance getter exists.

(c) Consumers — every STATIC accessor read/write/compound/update site that
looks the getter/setter up in `funcMap` must pass `"static"` to
`classMemberFuncKey`; the audit list is the 20 `staticAccessorSet.has` sites
across 13 files (property-access-dispatch.ts ×3, declarations.ts ×4,
assignment.ts ×2, call-builtin-static.ts ×2, class-proto-accessors.ts,
extern.ts, member-get-dispatch.ts, index.ts, object-runtime.ts,
regexp-legacy-static.ts, class-static-metadata.ts, property-access.ts,
class-static-descriptor.ts) plus `class-static-sidecar.ts`'s halves. The
INSTANCE key stays byte-identical (`C_get_eval`), which is what keeps every
class without the collision unchanged. The `#1983` `continue` guards at
`:1844`/`:1884` then no longer skip the second declaration.

(d) Residual: the inheritance loop (`:1948-1975`) strips only `__cm$`, so a
relocated static accessor is not aliased into a subclass (same as the
existing `__cm$static$` method relocation — record). ES5 risk: none. Pins:
`tests/issue-6767-class-definition-reflective.test.ts` (flip its R1
RESIDUAL pin), `issue-5318-r4/r5`, `issue-5195-r3-restricted-properties`,
`issue-4455`, `issue-5151-map-size-descriptor`.

(e) Acceptance: p12 bit 1 set (and bit 2 if the accessor `name` is
`"get id"`); `getters-restricted-ids.js` passes (`C.eval === 3`,
`C.arguments === 4`); the fn-name rows measured and recorded.

### S13 (optional, last) — runtime %ThrowTypeError% for `caller` / `arguments` on closure carriers (F/R2)

Rows: `definition/methods-restricted-properties.js` (8 of its 12 assertions
read the accessors off `gOPD(...).get/.set` VALUES, so only a runtime arm
closes it) and half of `strict-mode/arguments-callee.js`. Needs a
per-carrier "restricted" bit the closure struct does not carry today
(`function-poison-pill.ts` threads strictness per CALL, not per value), so:
append an `i32 flags` field to the closure struct (append-only, every
`struct.new` of it pushes the constant — the #6766 `$Object` field-append
precedent, whose byte-identity note applies) set at closure creation for
methods, accessors, arrows, generators, class bodies and strict functions
(`isStrictFunction` + `poisonMember`'s predicate), then a `__extern_get` /
`__extern_set` arm: closure carrier ∧ flag ∧ key ∈ {caller, arguments} →
TypeError. Sloppy ordinary functions keep today's answer (their own
`caller`/`arguments` are implementation-defined; test262 does not assert
them). Do this only if the S1–S12 controls are green with budget left;
otherwise record it as its own issue. ES5 pins if attempted: every
currently-passing ES5 row under `built-ins/Function/**` and
`language/function-code/**` (the strict `caller` rows, 15.3.5.4_2-*).

### Deferred — not realistically fixable in this slice (9 rows), with the reason

| row | reason | where it belongs |
| --- | --- | --- |
| `subclass/builtin-objects/GeneratorFunction/{regular-subclassing,instance-length,instance-name,instance-prototype,super-must-be-called}.js` (5) | `new GFn('a', 'yield a')` is CreateDynamicFunction through the QuickJS eval provider with a SUBCLASS NewTarget (prototype from `GFn.prototype`); the heritage is a runtime value (`Object.getPrototypeOf(function*(){}).constructor`), so it needs the linked-provider construct driver (#6640) generalised to the eval provider plus a generator-function carrier whose `length`/`name`/`prototype` are own reflective properties; the ReferenceError half of `super-must-be-called.js` already passes | a runtime-eval / provider-construct issue; cross-ref #6640, #4238 |
| `subclass/builtin-objects/TypedArray/regular-subclassing.js` | heritage is a function PARAMETER (`testWithTypedArrayConstructors(function(Constructor) { class Typed extends Constructor {} })`); the #6644/S66 identifier-parameter arm is link-consumer-only and the TA carrier work is #6769's (PR open) | measure after #6769 lands; then the dynamic-heritage construct driver for non-linked modules |
| `subclass/builtins.js` | `class ExtendedUint8Array extends Uint8Array { constructor(){ super(10); this[0] = 255; … } }`: `super(10)` builds the #3972 IDENTITY carrier (p13c: `length` undefined), and `this[i] = v` on a TA-subclass-typed receiver needs TA element dispatch — #6769's substrate | #6769 follow-up |
| `subclass/builtin-objects/ArrayBuffer/regular-subclassing.js` | same identity carrier (`byteLength` undefined even untyped, p13c bits 1/2), AND `sliced instanceof AB` needs the native `slice` to honour `constructor[@@species]` (#6769's `ctors/no-species` residual) | #6769 follow-up: add `ArrayBuffer` to `NEW_SITE_BUILTIN_PARENTS` + `NEW_SITE_ROUTED_PARENTS`, then species |
| `strict-mode/arguments-callee.js` | three mechanisms: the heritage FUNCTION EXPRESSION is never called by `super()` in standalone (compileSuperCall `:4484-4503` only calls a NAMED fnctor; an anonymous heritage function falls to `:4508`), so its `arguments.callee` poison never fires; `Object.getPrototypeOf(D)` for a fnctor parent (S6 covers user-class parents only); and R2 (S13) for `.arguments` on the function value | after S13; file the heritage-function-expression hoist separately |

`definition/methods-restricted-properties.js` is S13 (optional) — counted as
deferred unless S13 lands.

Expected after S1–S12: **22 rows flip** (S1a 1, S1b 2, S2 3, S3 1, S1b+S2+S3
1, S4 2, S5 4, S6 1, S7 1, S8 1, S9 2, S10 1, S11 1, S12 1) plus up to 2
more (`fn-name-accessor-*`) if their remaining assertions clear; 9–10 stay
red by construction of this slice.

### Overlaps found (cross-reference, do not re-plan)

- **#6767** (merged): its residuals R1 (S12), R2 (S13), R3 (runtime-keyed
  static view — not planned here), R4 (S6's fold) and its "recorded only"
  rows (`this-access-restriction{,-2}.js`, `this-check-ordering.js`,
  `side-effects-in-extends.js`, `prototype-getter.js`) are THIS issue's S1b,
  S6, S11. Its param-inference withdrawal (`param-return-inference.ts` /
  `class-proto-object.ts`) is the twin S9 may need.
- **#5350** (in-progress): S1b generalises its `__js2_super_done` flag
  (r3 S1) from `super.x` reads to `this`/`super.m()`/second-`super()`; its
  18 pins are S1b's regression floor. Do not touch `compileStandaloneSuperPropertyRead`.
- **#6769** (TypedArray, PR open on `issue-6769-typedarray-residue`): owns no
  `language/statements/class` row, but the three TA/ArrayBuffer rows above
  sit on its carrier work — deferred behind it.
- **#6766** (Proxy as prototype, in-progress): no row overlap; S10's gOPD
  arm must not touch its `$Object.$proto` walkers.
- **#6770 / #6771** (Object-Reflect / Array, planned in parallel; neither
  published at plan time — neither issue file exists on main or on any
  worktree at 2026-09-30 20:15 UTC): S10 (a native-carrier gOPD arm)
  and S9 (the `.constructor` fold) are the two places to coordinate; check
  again before starting either.
- `pre-dispatch-gate.mjs 6772` at plan time: CAUTION (no `gh` reachable;
  no claim on the ledger; no idiom-sharing issue found by hand — the closest
  is #5318's computed-property-name work, already landed).

## Acceptance criteria

- The 22 rows named per step pass on standalone, `--isolate`, on the branch
  with `origin/main` merged in; the 9 deferred rows are re-measured and
  listed with their first failing assertion.
- Every probe in `.tmp/6772/` answers the node oracle on the branch (p1 3,
  p2 63, p3 15, p4 63, p5c 15, p5e 2121, p6 15, p7d 3, p8c 3, p9/p9b 42,
  p9c 7, p10 7, p10c 7, p11 15, p12 ≥ 7 (bits 1,2,4), p13d 15, p17 7); the
  pin file `tests/issue-6772-class-residue.test.ts` carries each as a
  "RED on base" case (base verdict recorded) plus guards: a plain derived
  class with one `super()` (bytes identical to base), a non-overriding
  instance of an S2-marked class (`b.m()`, `b.x`, `b instanceof Base`), and
  a class with distinct static/instance accessor names (bytes identical).
- Controls, 0 pass → non-pass (per-path set diff, run once on the merged
  tree under the lock): (1) every currently-passing ES2015 standalone row
  under `language/{statements,expressions}/class/**` and
  `language/expressions/super/**` (~2,300 rows — rebuild #6767's list from
  `.test262-cache/test262-standalone-current.jsonl` with
  `scripts/generate-editions.ts::classifyEdition`); (2) **ES5 is a completed
  edition — ZERO regressions**: the union of the per-step ES5 pin sets
  (`language/arguments-object/**`, `language/statements/function/**`,
  `language/expressions/{this,new,call,assignment}/**`,
  `language/identifier-resolution/**`, `language/statements/variable/**`,
  `built-ins/Function/**`, `built-ins/Object/{getOwnPropertyDescriptor,getPrototypeOf}/**`,
  `**/prototype/constructor/**`, `built-ins/RegExp/**`), currently-passing
  rows only, run in full.
- Host lane byte-identical for p1/p4/p9 (`sha256` of `.binary`,
  `target: undefined`), except S5's shapes (documented).
- All gates green bare and with `LOC_GATE_BASE=$(git rev-parse origin/main)`;
  growth grants only in this file; `src/ir/select.ts` untouched unless S8
  takes route (i), in which case its selector outcome is pinned.
- Record appended to THIS file (`### 2026-09-30 — #6772 implementation (Opus)`):
  rows before/after, per-step probe table, pins' base verdicts, control
  diffs, gates, residuals with mechanisms; one-paragraph pointers in
  `plan/issues/6767-es2015-standalone-class-definition-reflective-residue.md`
  (R1/R4 moved here) and
  `plan/issues/6651-es2015-standalone-100pct-execution-plan.md`.

## Lane protocol

- Worktree under `/home/user/js2/.claude/worktrees/` (branch
  `issue-6772-class-residue` from `origin/main`); symlink `node_modules` and
  `test262` if the hook does not provision them; never edit `/home/user/js2`.
- Every `run-test262-paths.mts` invocation through
  `flock /tmp/claude-0/t262.lock …` (4 shared cores). Rebuild the QuickJS
  adapter after a `src/` change when a row reports "provider is not built".
- NEW `src/` files must be registered in `scripts/compiler-boundaries.json`
  (textual insert next to their siblings; entry shape `{ "path": …,
  "state": "unmigrated", "layer": "mixed-needs-split", "destination":
  "backend-wasmgc", "owner": "3518-coordinator", "nextBoundary": … }`), then
  `node scripts/check-compiler-boundaries.mjs --mode inventory --base origin/main`.
- Gate chain, bare, exit codes read directly:
  `LOC_GATE_BASE=$(git rev-parse origin/main) node scripts/check-loc-budget.mjs && LOC_GATE_BASE=$(git rev-parse origin/main) node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s check:dead-exports && node scripts/check-compiler-boundaries.mjs --mode inventory --base origin/main && npm run -s typecheck`
  (also `pnpm run check:ir-fallbacks` for S6/S8). `check:dead-exports`
  leaves ~80 MB in `.tmp/core-node-execution-*` — delete it after.
- Vitest pins: `VITEST_FORK_MAX_OLD_SPACE_SIZE=1024` (CI's value) for the
  pin file and the named neighbour suites, ≤3 files per batch. Pushes:
  `NODE_OPTIONS=--max-old-space-size=4096 VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 git push -u origin <branch>`
  (the pre-push #3765 vitest OOMs at the default 512 MB fork heap).
- Commits: `GIT_AUTHOR_NAME="Thomas Tränkler" GIT_AUTHOR_EMAIL="git@thomas.traenkler.com"`
  (the commit-msg hook blocks a Claude author), committer Claude, subject
  ending in ` ✓` (pre-commit checklist sign-off hook), trailers
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`,
  `Claude-Session: https://claude.ai/code/session_01FEGi3DmyPRPD5dx4kWU8hs`,
  `Model: Claude Opus 5.5 High`; one commit per step with its measurement in
  the body; never `--no-verify`; no `git stash` (A/B by file copy from
  `.tmp/6772/base-src`). Push early; do NOT open a PR — the lead verifies
  the pushed head and opens it.

### 2026-09-30 — #6772 implementation (Opus)

Running record, one entry per step (the commit body carries the full
measurement). Base for "base" values: `origin/main` @ `e303c5c794` unless an
entry names another; probes `.tmp/6772/*.js` (standalone, `imports: []`),
node oracle `.tmp/6772/oracle.mjs`; rows `--isolate --standalone` under the
shared lock.

| step | commit | probes base -> branch (node) | rows flipped |
| --- | --- | --- | --- |
| S1a | `23c6b10634` | p5e 0 -> 2121 (2121); p5d 21 guard | `arguments/access.js` |
| S1b | `db43fed38d` | p1 0 -> 3 (3), p2 0 -> 63 (63), p3 14 -> 15 (15), nested 133 -> 3333, g1 880 -> 1023 | `definition/this-access-restriction.js`, `definition/this-check-ordering.js` |
| S2 | `760fc7205c` | p4 8 -> 63, t2 4608 -> 8191, g6 4 -> 7, g11 10 -> 7, g8 7 -> 31, g2 63 -> 255, g5 63 -> 255; guards g13 63, g16 31, p15 15 | `subclass/class-definition-null-proto-contains-return-override.js`, `subclass/derived-class-return-override-with-object.js`, `subclass/default-constructor-2.js`, `definition/this-access-restriction-2.js` |
| S3 | `75220d3415` | p5c 0 -> 15 (15); s3a COMPILE-FAIL -> 2 (2); guards s3b 31 (31), p5d 21 | `arguments/default-constructor.js` |
| S4 | `d2fd895a37` | p9 / p9b / p9e invalid Wasm -> 42 (42), p9c invalid -> 7 (7), p9d invalid -> 127 (127), p9f invalid -> 63 (63), t9 (typed, IR-claimed) IR compile error -> 50 (both lanes); guard s4i 3 (3) | `{statements,expressions}/class/ident-name-method-def-new-escaped.js` |
| S5 | `9368ba74f9` | p6 14 -> 15 (15); s5/a 0 -> 1, s5/b 0 -> 2, s5/e 0 -> 1, s5/g 0 -> 1, s5/h (member order) 0 -> 1 (node equal); host lane p6 14 -> 15 too | the four `cpn-class-{decl,expr}[-accessors]-computed-property-name-from-assignment-expression-assignment.js` |
| S6 | `a086bbecc4` | p11 COMPILE-FAIL -> 15 (15); p11b COMPILE-FAIL -> 1015 (1015); p11d 448 -> 1023 (1023); p11g 2 -> 15 (15); p11c (plain `extends C`) 11 -> 15; guard p11e 0 -> 0 (declines; node 7) | `definition/side-effects-in-extends.js` |
| S7 | `8a6544f974` | p7d 0 -> 3 (3); p7 1 -> 1 (bits 2/4 are a separate `get [false]` gap, unchanged); guards s7/b 15, s7/c 7, s7/d 3, s7/e 3 (base = branch = node); s7/f 102 both (RESIDUAL, node 3) | `expressions/class/accessor-name-inst-computed-in.js` |
| S8 | (none) | p8c already 3 on origin/main `ce6631272c` (p8a 1, p8b 15, p8d 3 = node) — fixed on main by another lane | `name-binding/const.js` passes on main and branch (no change here; guard pinned) |
| S9 | `bb9e1bb060` | p10 3 -> 7 (7), p10c illegal cast -> 7 (7), p10e illegal cast -> 1 (1), s9/a 0 -> 5 (5), s9/c illegal cast -> 3 (3), s9/d illegal cast -> 1 (1), s9/e 0 -> 1 (1); guards p10d 3, s9/b 1 | both `grammar-static-ctor-accessor-meth-valid.js` |
| S10 | `3a35759bae` | p13d 8 -> 15 (15); s10/a 0 -> 15 (15); s10/b throw -> 63 (63) | `subclass/builtin-objects/RegExp/lastIndex.js` |
| S11 | `b71d3b14b0` | p17 0 -> 7 (7); s11/b 0 -> 15 (15); guards s11/a 27 = base (node 31, bit 4 pre-existing), p11 15, p11e 0 | `definition/prototype-getter.js` |
| S12 | `f78a4e57ad` | s12/a 3 -> 15 (15); s12/b 34 -> 63 (63); s12/d 3 -> 15 (15); p12 4 -> 39 (63; bits 8/16 are S13); s12/c 390 -> 455 (4095; the static symbol-keyed half is #6767 R3) | `definition/getters-restricted-ids.js`; `fn-name-accessor-{get,set}.js` stay red (first failing assertion: `Object.getOwnPropertyDescriptor(A, 'id').get` is undefined — A also declares symbol-keyed STATIC accessors, #6767 R3; s12/e 0, node 3) |
| S13 | (not attempted) | optional per the plan; skipped under the lead's token-budget instruction — `methods-restricted-properties.js` stays red (follow-up: per-closure restricted bit + `__extern_get`/`__extern_set` %ThrowTypeError% arm) | — |

S2 design note (deviates from the plan's "set only on an object return"):
`$__ctor_override` is a RETURN REGISTER written on EVERY exit of a marked
`_init`, so a stale value from an unrelated construction can never be read;
it is consumed only right after a call into a marked `_init`. A derived frame
whose parent is marked keeps the parent's answer in a frame local saved AFTER
BindThisValue (a second, throwing `super()` cannot replace it), and its
`this` / data-member reads use that object. `this-access-restriction-2.js`
passes at S2 already: a marked class's `.call` reaches the dynamic [[Call]]
TypeError (probe g17: base 200 -> 3, node 3); S3 covers unmarked classes.
S2 residuals (pinned `RESIDUAL`): declared-METHOD reads/calls on a foreign
override object resolve against the class (g3 13, node 31); in a derived
frame after an overriding `super()`, `this.m()` throws from the nominal
receiver guard and `this.x = v` writes the discarded struct (g12b 10011,
node 15); dynamic construct sites (`Reflect.construct`, class values) do not
read the register; a child collected before its parent is not retro-marked.

S3 note: the arm sits in `compileCallExpression`'s `call`/`apply` block right
after the two #4076/#5143 brand-throw arms, standalone-only, and declines when
the class chain (source classes only) declares a STATIC member of that name
(`static call() {}` wins — guard s3b) or the callee may be replaced by runtime
eval. `Function.prototype.call.call(C, {})` (s3a) is reshaped to `C.call({})`
before reaching it, so it now throws instead of crashing in `eval-source.ts`.
Residuals (pinned): `Reflect.apply(C, …)` does not throw (s3c 100, node 1 —
the dynamic closure-apply terminal has no class identity arm); `apply`'s
CreateListFromArrayLike on the argument array is not performed.

S4 note: `classMemberFuncKey` relocates a MEMBER (any caller that passes a
`kind`) whose legacy name is `<C>_new` / `<C>_init` for a class of this program
to `__cm$member$<C>_new`; the allocator / `_init` lookups pass no kind and keep
the bare key. Every member-lookup consumer that used to pass no kind now passes
`"instance"` (identical key for every other name): the receiver-call ladder's
own-shadow lookups, the tail-dispatch arms, the method-value reads
(member-get / property-access / property-access-dispatch), the prototype-object
and subclass method installs, the forward-class ABI finalizer, and the IR
class projection (`projectClassCallableTarget` for `*-method` units and
`memberFunc` in ir/integration.ts — the typed probe t9 is IR-claimed and failed
there on base). Not standalone-gated (the key is lane-independent): host bytes
of p1/p3/p4/g13/t2/p6/p12 are identical to the pre-S4 merged tree, p9/p9f
change (they were invalid Wasm). The plan's inheritance residual does not
occur: s4i (a subclass calling an inherited `new()` / `init()`) answers 3 on
base and branch.

S5 note: two halves. (1) `emitUnresolvedComputedAccessorNameEffects` keeps
skipping a member whose key folds, unless the key contains a plain assignment
(`computedKeyHasAssignment`, class-member-keys.ts — the literals.ts fold reads
through `x = v`); that key is compiled for effect and dropped, in member order,
and the folded name stays the property key. (2) The emitter never ran for a
TOP-LEVEL class whose keys all fold: the module-init collector routes a class
through `compileNestedClassDeclaration` only when
`classHasUnresolvedComputedMemberName` holds. `classHasComputedKeyAssignment`
now joins that gate for declarations and for `let C = class {…}` bindings
(declarations.ts). Lane-independent: host bytes move for exactly these shapes
(p6 sha changed; p1/p3/p4/p9/p9f/g13/t2/p11/p12 identical to S4). Separate
defect found, NOT fixed here (file it): an element-access KEY that folds drops
its write the same way — `o[x = 'a']`, `c[x = 1]`, `c[String(x = 'm')]()` leave
`x` unchanged on every lane (probe p6c 2, node 15). The rows pass anyway because
the class definition performs the write first. Neighbour suites
issue-5195-es2015-class-r2 / issue-5195-r3-review / issue-5318-r4: the same 6
cases fail on the pre-S5 tree AND on origin/main a895598841 (5 stale RESIDUAL
pins whose writes/compiles now succeed — w1 987 on main — and r3-review F1,
which throws on main too: f1 150 on main and branch); issue-5318-r5 /
issue-5195-r3-heritage-check 46/46.

S6 note: three parts. (1) IR planning (`requireIrPlanningOwnerUnitId`): a
node inside a class's HERITAGE clause, reaching the class node that keys a
top-level class's null-owner `class-implicit-constructor` support unit,
continues the walk to the enclosing owner — the heritage is evaluated in the
enclosing scope, never in the constructor (all lanes; it used to throw the
`unowned-planning-owner` invariant, so no previously-compiling program can
observe the change). (2) New leaf `class-heritage-comma.ts`: on standalone /
WASI, `collectClassDeclaration` peels `extends (e1, …, C)` to its identifier
tail, so `C` is linked exactly as for `extends C`; the leading operands are
evaluated, once and in order, at each ClassDefinitionEvaluation site right
after the #5195 r3-5 heritage check (which declines a comma heritage, so
nothing runs twice), and the module-init collector routes such a top-level
class / class-expression binding through `compileNestedClassDeclaration`. The
host lane keeps its dynamic-parent registration (p11 host 3, p11c/p11d host
bytes identical). (3) R4: `Object.getPrototypeOf(D)` for a derived class
spelled by an unwritten binding answers the parent's class object when the
heritage identifier is bound, uniquely and unwritten, to that parent's own
declaration (`heritageBindsParentClass`); a parameter heritage or a rewritten
binding declines to the old fold (p11e, pinned). #6767's R4 RESIDUAL pin
flipped to the fixed expectation. `check:ir-fallbacks` unchanged. Unrelated
pre-existing defect seen while probing (not fixed): a heterogeneous array
literal returned from a function loses its number elements (`[true, 7, 1]`,
p11h bit 8, base and branch).

Merge 2026-10-02 (origin/main `ce6631272c`, #6771/#6773/#6774/#6775 and
#6797's gates): three import-only conflicts, both sides kept. #6797's two
new gates failed on the plain merge — `src/codegen/*.ts` 829 -> 833 and the
largest import SCC 697 -> 702 (the four leaves plus
`externref-backed-class-rep.ts`, which imports `ctor-return-override`). Fix
(no baseline edit): the leaves moved to `src/codegen/classes/`, and the SCC
helpers they call (`classIdentityFromExpression`,
`compileObjectLiteralAsExternref`, `sourceClassForCallee`,
`runtimeEvalMayReplaceCallee`, `unwrapCallee`,
`bindingIsUniqueAndNeverWritten`) go through `helpers/core-delegates.ts`,
registered by `expressions.ts`; the throws use the existing
`buildThrowJsErrorInstrs` delegate and the late imports the `shared.ts`
twins. Gates after: SCC 697, flat 829/829, all others green. S6 re-checked on
the merged tree (not by the earlier run): p11 15, p11b 1015, p11c 15, p11d
1023, p11g 15, p11e 0 — as recorded; `side-effects-in-extends.js` passes;
pin file 34/34 at fork heap 1024. Plan prose below still names the old flat
paths; the S11/S12 leaves go under `classes/` too.

S7 note: `ctx.classExprAmbiguousNames` (context/types.ts) — the assignment-RHS
collector (declarations.ts) deletes the `classExprNameMap` entry and marks
the name when a SECOND, different class expression is assigned to it; the
#1394 var-name bridge no longer re-adds a marked name. Reads then take the
untyped dynamic path, which already resolves the right prototype accessor.
Not standalone-gated (the map is lane-independent): host answers for
p7d / s7/a / s7/b / s7/c are identical on main `ce6631272c` and the branch
(0 / 14 / 15 / 7). Pre-existing, unchanged, pinned RESIDUAL: constructing
the FIRST of two classes whose constructor writes a field throws (s7/f 102
on main and branch, node 3). Neighbour pins: issue-4770 / issue-5383 pass;
issue-5318-r4 has the same 4 stale RESIDUAL failures on main `ce6631272c`.

S9 note: two arms in property-access-dispatch.ts. (1) The class-object
`C.constructor` fold (`emitClassStaticMemberRead`) declines when a static
accessor owns `<C>_constructor`, so the ordinary static-accessor read below
calls the getter. (2) The "illegal cast" was not the #6767 param-inference
family the plan suspected: `finalizeStructAndDynamicMemberGet`'s INSTANCE
accessor arm tested `classAccessorSet` (which also holds static accessors)
and called the static `C_get_constructor` with `C.prototype` cast to the
instance struct. It now skips a `constructor` key that is a static accessor
(an instance accessor of that name is an early error, so the guard cannot
hide a real one). The plan's second site (`:4450` class-instance
`.constructor` arm) needed no change. Not standalone-gated: both conditions
require a class with a static accessor named `constructor`, which no ES5
program has. Neighbour pins issue-5195-r3-restricted-properties /
issue-6767 21/21.

S10 note: three parts. (1) `installRegExpLastIndexCarrierArms`
(regexp-lastindex-carrier.ts) splices a `__getOwnPropertyDescriptor` arm —
`(read(o), writable = !$lastIndexNonWritable)` through `__create_descriptor`,
§22.2.3.3 non-enumerable / non-configurable — and (2) a `__delete_property`
arm answering `false` (§10.1.10 step 4; the strict operator turns it into the
TypeError). #6770 had not published a native-carrier gOPD ladder, so the arms
sit with the other lastIndex MOP arms. (3) The typed gOPD fold in
`compileBuiltinStaticCall` declined the vestigial struct of an Array subclass
(#2917) but not of a new-site builtin subclass (`class RE extends RegExp {}`,
whose instance IS the `$RegExp` carrier): `newSiteBuiltinParent` now declines
it too, so a literal key reaches the dynamic native. ES5 control: every ES5
`built-ins/RegExp/**` + `built-ins/Object/getOwnPropertyDescriptor/**` row
that passes in the standalone baseline (805) still passes (non-isolated run;
the 9 rows that first reported "quickjs provider is not built" re-run
`--isolate` after building it: 9/9). Neighbour pins issue-4098 / issue-4491*:
the same 6 failures on main `ce6631272c` and the branch.

S11 note: new leaf `classes/class-heritage-runtime-get.ts`, called right after
the S6 comma-effects line at the three ClassDefinitionEvaluation sites
(nested-declarations.ts, variables.ts, new-super.ts). For a standalone class
in `classDynamicUnresolvedHeritageSet` (not linked, no builtin parent, not
already thrown for by the r3-5 check, heritage not an identifier bound to a
local function/class DECLARATION, whose `prototype` is a non-configurable data
property) it compiles the heritage value once (a comma heritage's tail only),
skips a null/undefined value, reads `__extern_get(v, "prototype")` and throws
"Class extends value does not have valid prototype property" when the answer
is neither null/undefined nor an object/function. The module-init collector
(declarations.ts) routes a top-level class declaration and a class-expression
binding of that shape through `compileNestedClassDeclaration` so the read
happens at definition (the row's first class is top-level). Deliberately
one-sided, recorded residuals: an `undefined` `prototype` (spec: TypeError) is
not thrown for, IsConstructor (step 5.f) is not re-checked, and a function
declaration whose `prototype` was reassigned to a primitive is not caught —
on this lane an unmodelled carrier also answers `undefined`, so throwing there
could reject valid programs. `ensureObjectRuntime` and
`heritageExpressionNeedingRuntimeCheck` join the core delegates (#6797, keeps
the leaf out of the codegen SCC: 697). Host bytes unchanged (standalone-gated).
Class control: all 209 baseline-passing ES2015 class rows that contain
`extends` still pass (non-isolated; 5 re-run `--isolate` after rebuilding the
QuickJS adapter: 5/5). Neighbour pins issue-5195-r3-heritage-check /
issue-6767 / issue-6640 / issue-6644 (both) pass.

S12 note: deviates from the plan in where the key logic lives — the helpers
went into `class-member-keys.ts` (already the funcMap-key module, outside the
SCC) instead of a new leaf. `ctx.classInstanceAccessorKeys` (`<C>_<p>` of every
INSTANCE class accessor) is filled in the pre-population loop before any key
is minted; `staticAccessorFuncKey` relocates a static half with an instance
twin to `__cm$static$<C>_get_<p>`; `staticReceiverAccessorKey` is what the
static-receiver consumer sites look up (relocated key for a twin, the site's
own legacy key otherwise); `isInstanceAccessorKey` replaces the
`classAccessorSet.has && !staticAccessorSet.has` spelling, which also said
"no" for an instance accessor with a static twin. Sites: registration and
body emission (class-bodies.ts), the static-`this` and class-object reads and
the instance dummy-receiver arm (property-access-dispatch.ts), `C.x = v`,
`C[k] = v`, `C.prototype[k] = v` (assignment.ts), `C[k]` / `C.prototype[k]`
(property-access.ts), the prototype install list (class-proto-accessors.ts),
the member-get dispatcher (member-get-dispatch.ts) and the static sidecar's
half lookup + closure-cache names (class-static-sidecar.ts — the instance and
static halves must not share a `emitCachedMethodClosureAccess` cache key).
The prepared-accessor predicates in declarations.ts were left alone: they
decline a twin, which is the conservative answer. Byte identity: for every
class without a static/instance twin, both lanes' binaries are identical to
S11 (p1, p4, p6, p10, p17, s9/c; sha256 A/B); only twin classes change, on
both lanes (host s12/a 3 -> 15, s12/b 2 -> 15, s12/d 0 -> 8). The #6767 pins
flipped: p12 now 511 (= node) and its R1 RESIDUAL now answers 3. Class
control: the 112 baseline-passing ES2015 class rows containing `static get` /
`static set` all pass. Neighbour pins issue-6767 / issue-4455 /
issue-5151 pass; issue-5318-r4 and -r5 keep exactly main's failures (4 and 3).
Residual (measured): a subclass's read of an inherited static twin is
still wrong — s12/f (`class Q extends P {}`, `Q.x`) answers 1 on main and on
the branch (node 3); the inheritance alias loop does not carry the relocated
static half.

#### Final measurement (2026-10-02, resume 5)

Base = `origin/main` @ `ce6631272c` (the merged sha; `src` snapshot by
`git archive`, its own QuickJS adapter built); branch = `f78a4e57ad` + docs.
All 34 rows, `--isolate --standalone`, shared lock:

| tree | pass | fail | compile_error |
| --- | --- | --- | --- |
| main `ce6631272c` | 1 (`name-binding/const.js`) | 32 | 1 |
| branch | 22 | 12 | 0 |

Every branch non-pass is also non-pass on main. Still red, first failing
assertion / cause:

| row | cause |
| --- | --- |
| `definition/fn-name-accessor-get.js`, `fn-name-accessor-set.js` | `gOPD(A, 'id').get` is undefined: A also declares symbol-keyed STATIC accessors, and the static reflective view then declines for literal keys too (#6767 R3) |
| `definition/methods-restricted-properties.js` | S13 not attempted: no %ThrowTypeError% `caller`/`arguments` on method values |
| `strict-mode/arguments-callee.js` | deferred: the heritage function expression is never called by `super()`; plus R2 |
| `subclass/builtin-objects/GeneratorFunction/{regular-subclassing,instance-length,instance-name,instance-prototype,super-must-be-called}.js` | deferred: CreateDynamicFunction through the eval provider with a subclass NewTarget |
| `subclass/builtin-objects/TypedArray/regular-subclassing.js` | deferred: parameter heritage over TA constructors (#6769 follow-up) |
| `subclass/builtins.js` | deferred: `super(10)` builds the TA identity carrier (`length` 2, not 10) (#6769) |
| `subclass/builtin-objects/ArrayBuffer/regular-subclassing.js` | deferred: identity carrier + species-aware `slice` (#6769) |

Controls, rebuilt from the fresh standalone baseline
(`.test262-cache/test262-standalone-current.jsonl`, fetched 2026-10-02,
41,999 passing rows) with `generate-editions.ts::classifyEdition`: 2,264
ES2015 class/super rows + 1,634 ES5 rows (the union of the per-step ES5 pin
sets). Run once on the branch, non-isolated, in 400-row chunks under the
lock: 3,894 / 3,898 pass. The 4 non-passes are all negative parse tests
("This statement should not be evaluated") and fail identically on main
`ce6631272c` re-run `--isolate`: class `definition/methods-gen-yield-star-
after-newline.js`, `definition/methods-gen-yield-weak-binding.js`; ES5
`expressions/call/S11.2.4_A1.3_T1.js`, `statements/function/invalid-
function-body-2.js`. They are listed `pass` in the baseline — not caused by
this branch; whether CI's sharded runner reproduces them was not checked
(ES5 is a completed edition, so they are worth a look on main).

Pins (fork heap 1024, ≤3 files per batch): `tests/issue-6772-class-residue`
51/51; issue-6767, issue-6644 (both), issue-6640, issue-5195-r3-heritage-
check, issue-5195-r3-restricted-properties, issue-4770, issue-5383-class-
value-dynamic-call, issue-4455, issue-5151, issue-4098, issue-5350 (both) all
pass; issue-5318-r4 (4), issue-5318-r5 (3), issue-5195-es2015-class-r2 (1)
and issue-5195-r3-review (1) fail exactly as on main `ce6631272c`.

Gates (bare, exit codes read directly): check-loc-budget and
check-func-budget (bare and `LOC_GATE_BASE=ce6631272c`), check-coercion-
sites, check:oracle-ratchet, check:dead-exports, check-compiler-boundaries
`--mode inventory`, check-import-cycles (SCC 697), check-flat-dir-budget
(829/829), check:ir-fallbacks, typecheck — all exit 0.
