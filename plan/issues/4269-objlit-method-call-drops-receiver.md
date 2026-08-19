---
id: 4269
title: "An object-literal method call does not bind its receiver — `obj.m()` reads `this === undefined`, on both lanes"
status: done
completed: 2026-08-09
assignee: ttraenkler/senior-dev
sprint: 78
created: 2026-08-09
updated: 2026-08-18
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: ES5
language_feature: this-binding, method-dispatch
goal: core-semantics
related: [4096, 4192, 4246, 4252, 4265, 3117, 1888]
loc-budget-allow:
  # calls-closures.ts (+61): the install has to be emitted at the `call_ref`
  # sites themselves — FOUR of them (three arms of compileCallablePropertyCall
  # plus compileCallableElementAccessCall), each with its own operand order —
  # and the receiver capture has to ride the ONE place the receiver is already
  # compiled. Moving either out would mean re-evaluating the receiver, which is
  # the thing this change exists to avoid. All decision logic lives in the two
  # satellites; what is left here is placement.
  - src/codegen/expressions/calls-closures.ts
  # call-tail-dispatch.ts (+11): two one-line call swaps at #4252's own
  # plain-object fallback arms plus their rationale comments. Those arms ARE
  # the dispatch's default; the wrapper they now call is a satellite.
  - src/codegen/expressions/call-tail-dispatch.ts
func-budget-allow:
  # The same edits at function granularity: three of the four install sites are
  # inside compileCallablePropertyCall, the fourth inside
  # compileCallableElementAccessCall, and the two swaps inside
  # compileTailDispatch. None can move without moving the dispatch.
  - src/codegen/expressions/calls-closures.ts::compileCallablePropertyCall
  - src/codegen/expressions/calls-closures.ts::compileCallableElementAccessCall
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
origin: "2026-08-09 — found while diagnosing #4252 (`obj[k]()` silent no-op); recorded there as an out-of-scope sibling defect"
---

# #4269 — an object-literal method call dropped its receiver

```js
var obj = { x: 42, m: function () { return this.x; } };
obj.m();          // undefined   ← the defect
obj.m.call(obj);  // 42          ← already correct
```

This is ordinary, everyday JavaScript. It was wrong on **both** lanes
(standalone AND gc/host), for every arity, for a nested receiver
(`outer.inner.m()`), for `obj["m"]()`, for `obj[k]()`, and for a method that
WRITES through `this`. Test coverage:
`tests/issue-4269-objlit-method-receiver.test.ts`.

The failure is silent. Nothing throws, nothing traps, no diagnostic is emitted —
the call answers `undefined` and execution continues. The **write** case is the
one that matters most: `this.x = 99` inside `obj.m()` landed nowhere observable,
so a program mutating its own object through its own method simply did not.

## Does it still reproduce? (verified 2026-08-09 on `upstream/main`)

Yes. Measured through `runTest262File`'s compile path, standalone lane, Node 25,
before any change:

| form | before | expected |
| --- | --- | --- |
| `obj.m()` | `undefined` | 42 |
| `obj["m"]()` | callee RAN, `this` unbound → `undefined` | 42 |
| `obj[k]()` (runtime key) | callee **not invoked at all** (#4252) | 42 |
| `outer.inner.m()` | `undefined` | 7 |
| `obj.m(1, 2)` with `this.x + a + b` | `undefined` | 43 |
| `this.x = 99` inside `obj.m()` | `obj.x` stayed 1 | 99 |
| `obj.fact(4)` recursing through `this.fact` | **null-pointer deref** (hard crash) | 24 |
| `obj.m()` where `m` is a method SHORTHAND `m(){}` | 42 | 42 (already right) |
| `obj.m.call(obj)` | 42 | 42 (already right) |

The gc/host lane produced the identical wrong answers for the same rows.

## Root cause — pinned on the emitted WAT, not read off the source

`compileCallablePropertyCall` (`src/codegen/expressions/calls-closures.ts`)
lowers `obj.m()` to a `call_ref` whose first argument is the **closure ref** —
the lifted function's `self`/environment carrier. The receiver is compiled only
to read the field off it and is then unreachable. Emitted `$test` for the repro:

```wat
global.get $obj ; local.tee 0 ; … ; struct.get 44 1   ;; read the member
any.convert_extern ; ref.test/ref.cast …               ;; normalise to a wrapper
local.get 1 ; struct.get 45 0 ; ref.cast ; call_ref    ;; self = the CLOSURE
```

No `global.set $__current_this` anywhere in the module for this shape.

**The callee half was already correct and needed no change.** `m`'s lifted body
(`$__closure_0`) opens with

```wat
global.get $__current_this ; local.tee ; ref.is_null
(if (result externref) (then <undefined>) (else <the receiver>))
```

— it reads the global and falls back to `undefined` when nothing was installed.
`bodyReferencesOwnThis` is true for the function expression, so
`compileFunctionBody` sets `readsCurrentThis`, exactly as documented in #4192.
And `obj.m.call(obj)` works today *only* because `__apply_closure` installs that
global. So this is a **missing writer**, not a broken callee — the same finding,
and the same fix shape, as #4192's `.call`-on-a-variable-held-function-expression.

### Why the method SHORTHAND was already right

`{ m() { … } }` is compiled as a real method function `ObjLit_m(self_obj, …)`
whose parameter 0 IS the receiver, and the direct call resolves to it
statically. `{ m: function () { … } }` is compiled as a generic closure stored
in the object's field, which is what routes it through the closure dispatch
above. Same source-level construct, two different lowerings — which is why the
defect looked narrow while being ordinary.

## Why #4096 did not already cover this, and what changed

#4096 fixed the **expando** shape (`o.f = function(){…}; o.f()`) and built
`stored-member-closure-call.ts` for it. Its arm is gated on
`sourceHasMethodReassignment` — the #1397 per-module scan for a literal
`.<name> = …` assignment — and #4096's own resolution section states plainly why
that is the right gate *for that defect*: **the assignment is what creates the
shape**, and the arm sits at the very TAIL of `compileTailDispatch`, after every
static arm has declined, so nothing that already works can reach it.

A DECLARED object-literal property has no assignment. So the gate declines, and
— crucially — the call never reaches the tail arm at all: it is claimed much
earlier, by `compileCallablePropertyCall`, which finds a real struct field and
emits a static `call_ref`. #4096 did not "narrow itself out" of this shape by
choice; the shape is on a *different, earlier* path that #4096's instrument
(a chokepoint on `ref.null.extern` pushes) could not see, because this path
never pushes a null — it emits a perfectly good call with the wrong `self`.

**What was done about it:** nothing in #4096 was widened, moved or re-gated. Its
arm and its gate are untouched. The fix here is a *writer* added at the four
`call_ref` sites #4096 never reached, reusing the same `__current_this`
convention #4096's `__apply_closure` bridge relies on. The two changes compose
by construction: an expando member still reaches #4096's tail arm (verified
byte-identical, and its test case still passes here).

## The fix

One satellite, `src/codegen/object-literal-method-receiver.ts`, plus a thin
wrapper `src/codegen/expressions/plain-object-dynamic-receiver-call.ts` for the
runtime-key form. The emitted shape at each site:

```wat
<receiver>  local.tee $tmp ; local.get $tmp ; extern.convert_any
            local.set  $__objm_recv      ;; captured once, riding the field read
…           ;; self, arguments, funcref — unchanged
global.get  $__current_this ; local.set $__objm_prev
local.get   $__objm_recv    ; global.set $__current_this
call_ref                    ;; unchanged
[local.set $res] ; local.get $__objm_prev ; global.set $__current_this ; [local.get $res]
```

Three properties are load-bearing:

1. **The receiver is captured at the one point it is already compiled**, so it
   is evaluated exactly once. A getter-backed or side-effecting receiver cannot
   run twice. (The two element-access forms are the exception and are gated to
   an identifier receiver precisely because they cannot do this — see below.)
2. **The install is emitted AFTER the arguments.** An argument expression can
   read the CALLER's `this`, which goes through the same global; installing
   first would corrupt it. `tests/issue-4269-…` pins this with
   `inner.n(this.y)` → 509, a case that fails on an otherwise-correct fix.
3. **The `__current_this` global index is re-read at every emit point, never
   baked at plan time.** Registering a string-constant import inserts an IMPORT
   global and shifts every module-global index; `fixupModuleGlobalIndices`
   repairs the cached index and every already-emitted `global.get`/`global.set`,
   but it cannot repair a plain number a caller is holding. This is not
   hypothetical — the first cut baked it, a string literal compiled in between,
   and the install landed on the module-object global instead:
   `global.set[0] expected type (ref null 8), found local.get of type externref`
   on the gc lane. Same family as #2023 / #2001-S1 / #3032 / #3933, which is
   now five instances of one hazard.

Save/install/restore is inline, matching `closure-receiver-install.ts` (#4192),
`__call_fn_method_N` and `fillDirectCallTrampolines` — **including their
documented limitation that an exceptional unwind skips the restore**. Being the
one path that differs is worth less than matching the established sequence.

### Admission — each gate is a refusal, not a guess

Static forms (`obj.m()`, `obj["m"]()`): every declaration of the member symbol
must be an object-literal `PropertyAssignment` whose initializer is a plain
`FunctionExpression` that references its own `this`.

- **`FunctionExpression`, never an arrow** — an arrow's `this` is lexical;
  binding a dynamic receiver would replace a correct answer with a wrong one.
- **The body must reference its own `this`** — the SAME predicate
  (`bodyReferencesOwnThis`) the body used to decide it would read the global, so
  writer and reader cannot disagree. A `this`-ignoring method stays
  byte-identical.
- **Not a generator, not `async`, no explicit `this` parameter.**
- **A `MethodDeclaration` is NOT admitted** — already correct via the static
  object-method path, so admitting it would buy blast radius for nothing.
- **Every declaration must qualify** — a symbol declared by two literals, one
  arrow-valued, is refused rather than half-bound.
- An unresolvable member (`any` receiver, no symbol) has no declarations and is
  refused, which keeps the whole `any` surface on its existing lowering.

`obj["m"]()` additionally requires an **identifier receiver**: the
element-access lowering fuses receiver and key, so the receiver must be compiled
a second time, and only an identifier makes that free. Same admission #4096 used
for the same reason.

`obj[k]()` (runtime key) has no property symbol to interrogate, so the gate is
asked of the receiver's literal instead: identifier receiver bound to an
**object literal**, **no arrow-valued property anywhere in it** (with a runtime
key any property could be the callee), at least one `this`-reading function
property, and **neither the key nor any argument references `this`**. That last
one is the ordering gate and it cannot be satisfied by moving the install — the
dynamic dispatch evaluates the whole callee and its own arguments — so
`obj[this.k]()` / `obj[k](this.y)` are refused rather than given a new wrong
answer.

## Demand gate — measured, not asserted

sha256 of the compiled binary, file-copy A/B against `upstream/main`, **both
lanes**:

| module shape | standalone | gc/host |
| --- | --- | --- |
| no object literal at all | identical | identical |
| object literal, data properties only | identical | identical |
| method that ignores `this` | identical | identical |
| arrow-valued property, called | identical | identical |
| method shorthand reading `this` | identical | identical |
| class method call | identical | identical |
| array of callables, variable index | identical | identical |
| `arr.push(x)` / `re.test(s)` hot path | identical | identical |
| expando stored member (#4096) | identical | identical |
| `this`-reading property READ but never called | identical | identical |
| primitive receiver, element call | identical | identical |
| runtime-key call, data-only literal | identical | identical |
| runtime-key call, literal containing an arrow (refused) | identical | identical |
| runtime-key call, argument reads `this` (refused) | identical | identical |
| **`obj.m()` on a `this`-reading property** | changed | changed |
| **`obj["m"]()`, same** | changed | changed |
| **`obj[k]()`, same** | changed | changed |
| **factory-returned literal, `o.m()`** | changed | changed |

The factory row is a genuine target, not an over-fire: `function mk() { return
{ x, m: function () { return this.x; } }; }` has the identical defect, and it is
fixed (13, was `undefined`).

One honest exception to the byte-identity claim, stated because it is a real
deviation: on the runtime-key path, a shape the plan ADMITS but #4252's dispatch
then DECLINES keeps every instruction it had before plus an inert capture and a
balanced save/restore pair. It is not rolled back, because truncating would also
discard the callee evaluation the dispatch itself emitted before declining, and
that evaluation is observable. Byte-identity is claimed for every shape the plan
*refuses*.

## Kill-switch attribution

Reverting only these files (`git show upstream/main:…`, never `git stash` — it
is one shared stack across every worktree of the repo): exactly the fix cases in
`tests/issue-4269-objlit-method-receiver.test.ts` fail and every
anti-regression control stays green. Measured at the 16-case revision: **10
failed, 6 passed**, the 6 being precisely the controls (arrow property, method
shorthand, `this`-ignoring method, `arr.push`/`re.test`, expando #4096, `.call`).
The recursive-`this` case does not merely answer wrongly on the base — it
null-derefs.

## Measured blast radius

Standalone lane, `runTest262File(abs, tag, 30000, "standalone")`, **sequential**
(a parallel sample reports a TIMEOUT as `compile_error` and manufactures phantom
regressions — the method note #4221/#4243/#4246 all record), file-copy A/B on
the same file list, Node 25 on both arms. Runtime-eval tier: **NONE** on both
arms (`runtime-eval tier: NONE — refusal provider missing`), so eval-mentioning
standalone modules stay unlinkable identically on each side.

| bucket | files | base pass | new pass | fail→pass | pass→fail |
| --- | --- | --- | --- | --- | --- |
| `built-ins/Function/prototype` | 309 | 61 | 61 | 0 | 0 |
| `language/expressions/call` | 92 | 42 | 42 | 0 | 0 |
| `language/statements/function` | 451 | 330 | 330 | 0 | 0 |
| `built-ins/Object` (1-in-6) | 569 | 368 | 368 | 0 | 0 |
| **total** | **1421** | **801** | **801** | **0** | **0** |
| shape-matched sample (1-in-8 of the 4,117 files carrying `name: function (`) | 515 | 241 | 241 | 0 | 0 |

**Zero regressions — and zero gains. The zero-gain half is not a null result, it
is a POPULATION result, and it took a fired positive control to tell the two
apart.** A byte-level control over the same 515-file sample reported **0 of 515
modules changed bytes**, which under the #4096 rule ("a negative sweep with no
fired positive control rules out nothing") makes the conformance reading of that
sample vacuous on its own.

Chasing that produced the actual finding. A syntactic scan of all 4,117
shape-matched files for BOTH a `this`-reading `name: function () {…}` property
AND a direct call of that name yields **29 candidates**, and reading them shows
those are **name collisions, not the shape**: `Reflect.get(o1,'x',receiver)`
matching a `get:` descriptor property, `iter.next(9876)` on a generator matching
a `next:` spy property, the `Proxy/*/call-parameters` handlers, and so on. The
29 were run in full (base 7/29, new 7/29, 0 flips) and **0 of 29 changed bytes**.

So: **test262 barely contains this defect.** It writes its callables as function
declarations, `Object.defineProperty` descriptors and class syntax. The idiom
this fixes — `var o = { m: function () { … this … } }; o.m()` — is the dominant
*pre-ES6 application* pattern, so the value lands in the npm-compat / dogfood
corpus, not in the conformance number. Stated plainly rather than padded: this
change buys **correctness on ordinary JavaScript at 0 measured conformance
delta**, with regressions constrained by 1,936 A/B'd files.

The instrument itself IS proven, by two controls that DID fire: the demand-gate
sha table above (4 of 18 synthetic shapes change, deterministically, on both
lanes) and the kill-switch below.

### Equivalence suite (the gc/host lane's own gate)

Full suite, 1,661 assertions: **1,637 pass / 24 fail** on this branch. The same
24 fail on `upstream/main` — compared **by failing-test name**, not by count (a
same-count comparison hides a swap): `PASS→FAIL 0`, `FAIL→PASS 0`. They span
`tdz-reference-error` (6), `null-dereference-guards` (5),
`logical-conditional-identity` (3), `new-non-constructor` (2),
`optional-direct-closure-call` (2) and 6 singletons — all pre-existing.

`tests/class-method-calls.test.ts` also has 3 failures ("callable property calls
on class instances"). File-copy A/B: identical 3 on `upstream/main`,
pre-existing. Every other suite run (`issue-4096`, `issue-4252`,
`es5-standalone-this-and-construct`, `call-expression-patterns`,
`computed-props`) is green: 72/75 across the set, the 3 being those pre-existing.

### Harness-fidelity ratchet (#4251)

`tests/es5-standalone-harness-selftests.test.ts`: **19/19 pass**, no entry
moves. Nothing pinned there flips `"fail"` → `"pass"`, so no ratchet entry needs
updating — consistent with the population finding above (the upstream harness
writes its helpers as function declarations and descriptors, not as
`{ m: function () { … this … } }` called through the object).

### Re-verified after merging `upstream/main` (through #4262 / #4281)

#4262 reworked the error substrate and touched `property-access.ts`, which this
change's call sites import (`emitNullCheckThrow`, `emitExternrefToStructGet`).
Re-ran on the merged tree: `tsc --noEmit` clean, the 18-case suite green, all
gates green, and the demand-gate byte-identity table re-measured end to end —
**28 of 36 cells (18 shapes × 2 lanes) identical, and exactly the 4 target
shapes changed on both lanes**, unchanged from the pre-merge measurement.

## Deliberately NOT done, with the mechanism named

1. **`return typeof this` / `return "ab" + this.x` from an object-literal method
   answers `undefined`.** This is NOT this defect and is not fixed by it: it
   reproduces identically through `obj.m.call(obj)`, which binds the receiver
   correctly, and `this === obj` from the same method answers `true`. The
   mechanism is the **string/externref return** of a callable-property dispatch,
   not the receiver. Filed as a separate observation rather than folded in —
   folding it in would have replaced a provably non-displacing arm with a change
   to return-type marshalling.
2. **`Function.prototype` `S15.3.4.{3,4}_A{3,5}_T6`** belong to another lane's
   report (#4265, `in-progress`) and are not touched here.
3. **The exceptional-unwind restore.** An inline sequence cannot use a
   `catch_all` without wrapping an arbitrary sub-expression in a `try`. Every
   existing `__current_this` install in the tree has the same hole; closing it is
   a change to the convention, not to this call site.
4. **Widening the admission to `MethodDeclaration` members read dynamically.**
   Their trampoline already resolves `this` from `__current_this` and would
   benefit, but they are correct today through the static path, so the gain is
   unmeasured and the risk is not.
5. **A real-world (npm-compat / dogfood) measurement.** That is where this
   defect's population actually lives — see the blast-radius section — and it is
   the honest gap in this issue's evidence. It was not run because the corpus is
   tens of minutes per arm and the generator refuses focused runs
   (`--only <pkg>` never writes). The next session should A/B the dogfood
   packages that predate ES6 method shorthand (`moment`, `lodash`) rather than
   re-measuring test262, which has been shown here to contain ~0 instances.
