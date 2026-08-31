---
id: 5241
title: "A compiled-class method with a declared parameter, reached through the host bridge on an Object.create-built instance, answers undefined — Temporal .from(…).add({days:1})"
status: done
completed: 2026-08-31
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-31
# Growth grants, 2026-08-31 (#5241). This branch is STACKED on the not-yet-
# merged #5221→#5239 chain, so every gate baseline is still main's: growth that
# predecessor PRs already granted in their own issue files re-surfaces here
# until those PRs land and the baselines refresh post-merge. The first three
# entries are that INHERITED set (this fix touches none of class-bodies.ts or
# runtime.ts); the annotated ones below are this fix's own.
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/index.ts
  - src/runtime.ts
  # +1 line: the linked-import accessor prefixes move to their own module
  # (src/linked-import-getter-names.ts) so codegen can RECOGNISE the shape the
  # linker GENERATES. One import statement; the four builders shrink.
  - src/package-linker.ts
  # +14 lines: the boolean-result boxing arm in the closed-method dispatcher's
  # result coercion (an `if` around the existing number-boxing lines plus the
  # comment that records the measurement). It belongs next to the ARGUMENT
  # coercion three lines above, which has honoured the same `boolean` ValType
  # marker all along; hoisting it out would separate the pair.
  - src/codegen/closed-method-dispatch.ts
func-budget-allow:
  # Same change, seen per-function. `emitMethodDispatch` +12 is the identical
  # arm in the OTHER bridge (`appendResultBoxing`); `fillClosedMethodDispatch`
  # +1 is the single `boxBoolIdx` initializer. Splitting either for one boxing
  # choice is #3399's job, not this fix's.
  - src/codegen/index.ts::emitMethodDispatch
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/index.ts::emitIteratorMethodExport
  - src/codegen/index.ts::generateModule
  - src/runtime.ts::resolveImport
---

# #5241 — arity-selected host bridge drops parametered method calls

## Problem

After #5239 (PR #5347), zero-argument members on an
`Object.create(C.prototype)`-built instance dispatch correctly (`.toString()`,
getters), but a method WITH a declared parameter answers `undefined` instead
of calling: `Temporal.PlainDate.from("2020-03-04").add({days: 1})` →
`undefined`. Control (dev-5239): identical on the long-standing *syntactic*
`Object.create(C.prototype)` path (`makeStatic(…).add(1)`, plain
single-module program), so it predates #5239 and is a distinct defect in the
arity-selected `__class_call_<key>_<n>` dispatch surface — the n>0 arm is
either not emitted for these members or not selected by the host resolver.

test262 Temporal arithmetic rows (`add`/`subtract`/`with`/`until`/`since`)
all take arguments, so this now bounds provider conformance alongside
#5225/#5226.

## Direction

Reduce with a plain class (`class K { add(n) { return this.v + n; } }`),
instance built via `Object.create(K.prototype)` (both spellings), method
called through the host bridge. Inspect which `__class_call_add_<n>` exports
exist and what `_resolveClassMember` selects for a 1-arg call; fix at the
emission or selection site, whichever is missing. Mind #5237's
`selectBridgeReceiver` (receiver must be the instance) and the #3903 hot
path.

## Acceptance criteria

1. Plain-class reduction answers correctly for 1- and 2-arg methods, both
   Object.create spellings, single-module and linked lanes; new
   `tests/issue-5241-*.test.ts` failing on base with controls.
2. `Temporal.PlainDate.from("2020-03-04").add({days: 1}).toString()` →
   `"2020-03-05"` through the provider; flip/assert harness rows.
3. No regressions in issue-5239/5237/5223/5221/4628 + linker family;
   equivalence gate at baseline. Gates green.

## Notes

- Found by dev-5239 (PR #5347 "Reported, NOT fixed") with the pre-existing
  control. Related family: #5223 (accessor-read bridge), #5237 (receiver
  selection), #5239 (instance minting).
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.

## Implementation notes (2026-08-31)

**The direction in this file was wrong about the mechanism, and that is the
finding worth keeping.** The issue reads "a method WITH a declared parameter
answers `undefined`" and proposes inspecting which `__class_call_add_<n>` arms
exist. Arity has nothing to do with it. On the same instance, in the same
program, on base:

| member | base |
| --- | --- |
| `zero()` — 0 args | works |
| `add(n)` — 1 arg | **`undefined`** |
| `subtract(n)` — 1 arg | works |
| `two(a, b)` — 2 args | works |

The one thing `add` has that `subtract` does not is a **name collision with a
builtin**. `tryExternClassMethodOnAny` (`calls-closures.ts`) binds the FIRST
registered extern class declaring the method name for an `any`-typed receiver,
and it returns *before* the compiled-class dispatcher in
`call-receiver-method.ts` is reached — so `add` became `env::Set_add` (`Set`
being the first extern class declaring it) and the `__class_call_add_1` bridge
was never even DEMANDED. The issue's own hypothesis ("the n>0 arm is not
emitted") described a real symptom whose cause was one layer up.

Why it looked arity-shaped: every member that failed (`add`, and the
`get`/`set`/`has`/`delete`/`clear` collection family) collides with a builtin,
and every Temporal arithmetic member is in that set and takes arguments. The
correlation was perfect and causally backwards.

**Why the guard stopped working across modules.** The anti-hijack guard
`sourceDefinesFunctionMember` (#3033) is scoped to ONE `ts.SourceFile`. A
provider/consumer pair — the ordinary polyfill shape — puts the class and the
call site in different files, so the guard silently stopped applying. The fix
asks the same question of the whole program (`ctx.classSet` ×
`ctx.classMethodSet`), plus a receiver-origin question for the linked lane,
where the linker has already rewritten the import to a
`__js2wasm_get_<name>_<hash>()` accessor and the provider's declarations are not
in the consumer's program at all.

**Two things were deliberately NOT done, both for measured reasons:**

1. The linked-lane arm is restricted to the branded-collection family
   (`get`/`set`/`has`/`add`/`delete`/`clear`). An unrestricted version — decline
   the extern binding for EVERY method on a linked-import receiver — changed
   `Temporal.PlainDate.from(…).equals("2020-03-04")` from `true` to `1` through
   the provider. Declining also changes RESULT MARSHALLING, so a blanket refusal
   trades one wrong answer for another.
2. Widening `sourceDefinesFunctionMember` itself to every file of the program
   was rejected: it would also change the host lane's answer for object-literal
   and prototype-assignment shapes that #3033/#4439 deliberately scope per file
   and per receiver.

**A pre-existing defect had to be fixed to avoid a regression.** Both class
bridges boxed an `i32` result via `__box_number`, so a boolean-returning method
answered `1`/`0`. Measured on base with a NON-colliding name (never hijacked, so
this is independent of everything above): `String(inst.bigger(0))` → `"1"` on an
`any` receiver, `"true"` on a typed one. The `ValType` already carries a
`boolean` marker — the closed dispatcher's ARGUMENT coercion has honoured it all
along — so both result sites now read it. Without this, this fix would have
turned `Temporal…equals(…)` into `1`.

**Temporal is NOT fixed (acceptance criterion 2 not met).**
`Temporal.PlainDate.from("2020-03-04").add({days:1})` throws through the
provider on BOTH sides of this change. The control that says the hijack is
nevertheless gone: in the single-module lane (polyfill + consumer in one module,
`linkedModules === 0`) the same call moved from `undefined` — never invoked — to
a real in-polyfill `TypeError`. What is left there is two other defects: a
missing **constructor** bridge for a compiled class reached as a value
(`compiled class constructor Duration bridge unavailable`, adjacent to #5239 but
on the construct path) and a null destructure in the polyfill's options
handling; the object-literal ARGUMENT crossing the provider seam is #5225's
lane. All recorded as `KNOWN_GAPS` rows in
`tests/dogfood/temporal-global-harness.mjs` with per-lane base/after tables, and
asserted present by `tests/issue-4628-temporal-global.test.ts`.
