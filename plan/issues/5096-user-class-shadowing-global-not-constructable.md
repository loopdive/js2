---
id: 5096
title: "A user class whose name shadows an ambient global is never constructed — `new X()` throws \"X is not a constructor\""
status: done
sprint: current
created: 2026-08-27
updated: 2026-08-28
completed: 2026-08-28
assignee: ttraenkler/opus-5096
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: class-shadowing
goal: correctness
origin: 3481
# 2026-08-28 (#5096): the fix adds ONE scope-consultation gate at each of the
# three name-claim points, plus the comment that records why each claim was
# wrong. `resolveWasmType` grows by the shared `builtinSymName` binding and its
# rationale (10 arms now read it instead of `sym?.name`);
# `tryCompileBuiltinGlobalNew` grows by a 3-line early return whose predicate +
# `Test262Error` exemption live at module scope. Both are the smallest edit that
# puts the check where the claim is made — moving either into a new module would
# split the claim from its guard.
loc-budget-allow:
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/index.ts::resolveWasmType
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
---

# #5096 — a global-shadowing user class is unconstructable

Split out of [#3481](https://js2wasm.loopdive.com/dashboard/issue.html?slug=3481-bigint-symbol-coercion-value-rep)
step 2 (PR #5101). The step-2 slice added a `new SharedArrayBuffer(length)`
Symbol guard in the generic `new` path, so it needed a test proving the guard
does not hijack a same-named user class. Writing that test surfaced something
larger: **the user class does not work at all**, with or without the guard.

**PRE-EXISTING and unrelated to #3481's fix** — identical on `origin/main` and on
the step-2 branch (A/B below). #5101's test asserts only that the failure is
still the pre-existing one and *not* the guard's message, with a comment
pointing here.

## Repro

```ts
class SharedArrayBuffer {
  v: number;
  constructor(_v: any) { this.v = 7; }
}
new SharedArrayBuffer(1).v;   // → TypeError: SharedArrayBuffer is not a constructor
                              //   spec: 7
```

The throw comes from the runtime's generic construct bridge
(`src/runtime.ts`, the `new Ctor(...args)` line in the extern-class /
`__construct_closure` path) — i.e. the call was routed to the **ambient global**
instead of to the user's class. In a JS-host lane the host `SharedArrayBuffer`
is not callable that way, so it surfaces as "not a constructor"; the underlying
bug is the routing, not the message.

## It is NOT SharedArrayBuffer-specific — that was the misleading first read

Every global-shadowing name behaves the same, and a name that shadows nothing
works. Measured in one module:

| declaration | `new X(...)` | verdict |
| --- | --- | --- |
| `class SharedArrayBuffer` | `TypeError: SharedArrayBuffer is not a constructor` | **wrong** |
| `class ArrayBuffer` | `TypeError: ArrayBuffer is not a constructor` | **wrong** |
| `class DataView` | `TypeError: DataView is not a constructor` | **wrong** |
| `class Map` | `TypeError: Map is not a constructor` | **wrong** |
| `class NotAGlobalAtAll` | `11` | ok |
| `const Local = class { v = 2 }` (non-global name) | `2` | ok |

Scope does not change it: a `class ArrayBuffer` declared **inside a function
body** fails the same way (`TypeError: ArrayBuffer is not a constructor`), so the
discriminator is purely "the binding's name matches an ambient global", not
"declared at module top level".

So the correct framing is a **shadowing-resolution bug in `new` dispatch**: the
builtin-global arms of `compileNewExpression`
(`src/codegen/expressions/new-super.ts` → `tryCompileBuiltinGlobalNew`
/ `tryCompileIndexedBuiltinNew`) claim the call by NAME before the local binding
is consulted, or `ctx.classSet` / `resolvesToAmbientGlobal` does not see the
user declaration for these names.

Worth checking as part of the same fix: the same name-first resolution likely
affects `function SharedArrayBuffer() {}`-style shadows and `let Map = class …`
re-bindings, and it is the mirror image of the guard conditions #5101 relies on
(`resolvesToNamedAmbientGlobal(ctx, expr.expression, "SharedArrayBuffer") &&
!ctx.classSet.has("SharedArrayBuffer")`) — if `classSet` were authoritative here,
those guards would already be doing the right thing for the shadowed case.

## A/B evidence

| side | commit | `class Map` → `new Map().v` |
| --- | --- | --- |
| `origin/main` | `220ce6c491` | `TypeError: Map is not a constructor` |
| #3481 step-2 branch | `923a35fe59` | `TypeError: Map is not a constructor` |

Identical, so #5101 neither caused it nor is masked by it.

## Why this matters beyond the repro

test262 shadows intrinsics routinely to test resolution and to stub hostile
globals, and any such file currently dies at the shadow rather than at the
behaviour under test. Impact was **not** sized here — sizing it needs a scan for
files that declare a class/function named after an intrinsic, which is the first
thing the implementer should do so the fix has a measured cohort rather than a
single repro.

## Acceptance

- `class X { … }` where `X` names an ambient global constructs the USER class;
  `new X()` returns the user instance.
- Works for a top-level declaration and for one inside a function body.
- The ambient global is still reachable where it is not shadowed, and the
  builtin fast paths (`new ArrayBuffer(8)`, `new Map()`, `new DataView(buf)`)
  are unchanged when no user binding exists — verify by byte-identity on a
  corpus, since these are the hottest builtin lowerings.
- Zero pass→fail overall.

## Notes for the implementer

#5101 added `tests/issue-3481-step2-symbol-arg-revalidation.test.ts` with a case
"the SharedArrayBuffer guard does not hijack a same-named user class", which
today asserts the failure is the pre-existing "not a constructor" one rather
than the Symbol guard's message. When this lands, that case should be tightened
to assert the user class's value (`7`).

---

## Resolution — 2026-08-28 (ttraenkler/opus-5096)

### Sizing first (the filer's step 1)

Scanned all **53,869** `.js` files under `test262/test` for a class / function /
`var`-`let`-`const` binding named after any spelling the compiler claims:
**9 files**. Against the fetched baseline (`test262-current.jsonl`, 48,735
entries, fetched 2026-08-28): **4 pass, 2 fail for unrelated reasons**
(`import.meta` in a GeneratorBody expects a SyntaxError;
`GeneratorFunction/instance-restricted-properties` expects a TypeError), **3
absent** (`staging/sm/*`, outside the run set).

    test/built-ins/Object/keys/15.2.3.14-2-3.js                     pass
    test/built-ins/GeneratorPrototype/constructor.js                pass
    test/harness/assert-throws-custom-typeerror.js                  pass
    test/harness/asyncHelpers-throwsAsync-custom-typeerror.js       pass
    test/language/expressions/import.meta/syntax/goal-generator-…   fail (SyntaxError expectation)
    test/built-ins/GeneratorFunction/instance-restricted-…          fail (TypeError expectation)
    test/staging/sm/{JSON/regress-459293, object/regress-459405,
                     generators/create-function-parse-before-…}     absent

**So the conformance upside is ~0.** Reporting it plainly, as asked: the value
of this fix is correctness / dogfooding (a user class named `Map`, `Date`,
`Error`… is ordinary application code), not the conformance number. Anyone
weighing follow-ups on this axis should price it that way.

### Root cause — THREE claim points, one defect

Not one bug in `new` dispatch. Three independent places decide what a value IS
by matching its symbol's **spelling** against an intrinsic-name set, each
*before* consulting the binding the name resolves to. §9.1 says the opposite:
any lexical/var binding in scope shadows the global.

1. **`src/checker/oracle.ts` — `TsCheckerOracle.factOfType`** *(the one the
   filed symptom comes from, and by far the widest)*. The
   `BUILTIN_NAMES.has(t.symbol.name)` arm ran **before** the
   call/construct-signature test, so a user `class Map`'s own constructor type
   classified as `{kind:"builtin", name:"Map"}`.
   `isFreshlyConstructedNonCallable` (calls-guards.ts) reads a `builtin` fact as
   "carries no [[Construct]]", so `tryNonConstructableNewTarget` emitted a
   compile-time `TypeError: Map is not a constructor` — the message in the issue
   is a **baked string constant in the module**, not the runtime bridge's throw.
   Fixing this one arm alone repaired 12 of the 18 broken spellings.
2. **`src/codegen/expressions/new-builtin-globals.ts` —
   `tryCompileBuiltinGlobalNew`**. Its arms key on `expr.expression.text` /
   `builtinName` with no scope check (only the Error family, via #4394's
   `errorCtorNameIsUserShadowed`, and `Promise` had one). Accounted for
   `Number`, `String`, `Boolean`, `Object`, `Proxy`, `Function`,
   `AggregateError`, `SuppressedError`.
3. **`src/codegen/index.ts` — `resolveWasmType`**. Maps a type by symbol name to
   the builtin Wasm **representation**. A user `class Date` instance was typed
   `ref $__Date` (one i64 timestamp), so the ctor's real user struct failed the
   `ref.test` on the way into that slot, became null, and the next read trapped
   ("dereferencing a null pointer"). This is why `new Date(5).v` worked while
   `const o = new Date(5); (o as any).v` did not — same construction, different
   slot type. Accounted for `Date`, the TypedArrays and `Array`.

### The fix — scope consultation AT each claim point

One shared predicate, `symbolShadowsBuiltinGlobal` in the new
`src/checker/builtin-shadow.ts`, consulted at all three sites. It answers
"does this symbol have a USER **value** declaration outside a `.d.ts`?".

The *value-binding* qualifier is load-bearing, not a detail: a global
**augmentation** (`declare global { interface Map<K,V> { … } }`) puts a
user-file declaration on the intrinsic's own merged symbol without introducing
a binding. Treating that as a shadow would drop every `Map`/`Array` lowering in
a program that merely augments a lib type — a far larger blast radius than the
bug. So interface / type-alias / namespace / enum merges deliberately do NOT
count; only class, function, `var`/`let`/`const`, parameter, destructured
binding and imports do.

`tryCompileBuiltinGlobalNew` additionally **exempts `Test262Error`**: it has no
ambient declaration at all (sta.js / the #2902 wrapped-harness injection
declares it in the module under compilation), and the standalone
`$Error_struct` interception that makes ~2,779 wrapped tests host-free exists
precisely to claim that user declaration. Its own narrower #4394 guards already
choose between the two lowerings.

Nothing was removed. The builtin arms are intact; they now decline only when a
user binding owns the name.

### Evidence

- **Byte-identity, unshadowed** (`.tmp/digest-5096.mts`): 40 builtin-constructor
  and builtin-typed-slot shapes × host / standalone / wasi = **120 sha256
  digests, all identical** between the base commit and this branch. This is the
  acceptance criterion "the builtin fast paths are unchanged when no user
  binding exists", measured rather than argued.
- **All filed shapes fixed**: every one of the 4 proven names plus 20 more,
  top-level and inside a function body, with `instanceof` and method calls
  correct. `tests/issue-5096-global-shadow-class.test.ts` (31 cases).
- **Blast radius, A/B**: ran every test file in the repo that declares a binding
  named after a claimed intrinsic (38 files, the exact set where behaviour *can*
  change). Base **55 failed / 793**; branch **55 failed / 824** (+31 = the new
  file). The failing test-name sets are **identical** — zero pass→fail, zero
  fail→pass.
- **Equivalence**: all 8 shards green, no new regressions.
- Gates green: typecheck, lint, `check:coercion-sites`, `check:oracle-ratchet`,
  `check:dead-exports`, `check:ir-fallbacks` (unchanged), LOC/func budgets under
  the grants declared in this file's frontmatter.

### Deliberately NOT fixed here (each with evidence)

- **TDZ.** Measured in node 22 (`.tmp/tdz-node.mjs`): with `class Map {}` later
  in the same scope, an earlier `new Map()` throws
  `ReferenceError: Cannot access 'Map' before initialization`; the `var Map =
  function(){}` form throws `TypeError`. Either way the intrinsic never wins.
  js2wasm now binds the **user class** in that position but does not throw — it
  does not model class TDZ at all, which is a general gap well outside this
  issue. The test pins the half this issue owns (the intrinsic must not win the
  name) and records the measured V8 answer next to it.
- **A nested shadow leaking to the outer scope.** `function f(){ class Map {} }`
  plus a module-scope `new Map()` answers `undefined` — `ctx.classSet` is keyed
  by bare NAME with no scope, so the inner declaration claims the name
  program-wide. **Verified pre-existing**: identical on the base commit
  (`.tmp/tdz-js2.mts`, A/B'd). It needs a scoped class registry, not a claim-point
  guard; worth its own issue.
- The `fnctor` projection in `src/ir/select.ts` and the #3521 surfaces were not
  touched, per the dispatch constraint. The `function F(){}` shadow shape is
  improved incidentally by the oracle fix (its fact becomes `function` instead of
  `builtin`), but no fnctor lowering changed — the 38-file A/B above includes
  every fnctor test that declares such a name.
