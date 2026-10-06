---
id: 6754
title: "tailwindcss standalone-dynamic lane: `class extends Map` with a field breaks the struct hierarchy (`U` / `__anonClass_70` no longer an exact mutable-field prefix of `Map`)"
status: done
completed: 2026-10-05
sprint: current
created: 2026-09-29
updated: 2026-10-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone-mode
# 2026-10-05 (#6754): the carrier lives in the new standalone-collection-carrier.ts;
# these are the one-line hooks into the existing call/layout sites, plus the
# reserved `$Map` field-name comment in map-runtime.ts.
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
  - src/codegen/map-runtime.ts
func-budget-allow:
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/class-bodies.ts::compileSuperCall
---

## Problem

With tailwindcss's generators lowered natively
([#6731](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6731-native-generator-residual-shapes),
2026-09-29), the tailwindcss 4.3.3 `standalone-dynamic` lane fails first on

```
struct hierarchy layout became invalid before finalization: subtype #196 (U) supertype #93 (Map) is no longer an exact mutable-field prefix
```

(`npx tsx scripts/generate-npm-compat-report.mjs --only tailwindcss --no-write --perf-only --lane standalone-dynamic`).
A second diagnostic names `__anonClass_70`, another `Map` subclass. The source
(`package/dist/lib.mjs`):

```js
var U=class extends Map{constructor(r){super();this.factory=r}factory;get(r){let t=super.get(r);return t===void 0&&(t=this.factory(r,this),this.set(r,t)),t}};
```

A class extending the builtin `Map` that adds an own field (`factory`) and
overrides `get` with a `super.get` call.

## Other errors in the same compile (reported, not this issue)

- stack-balance invariant: `__anon_87_parseCandidate` references local 37, but
  only 2 params + 11 locals are declared;
- host-import-leak warnings `env.Intl_ListFormat_new`,
  `env.Intl_ListFormat_format`, `env.Promise_all`.

## Acceptance

A minimal `class extends Map { f; constructor(){ super(); this.f = 1 } get(k){ return super.get(k) } }`
compiles and runs host-free in standalone (regression test failing on its
parent); the tailwindcss lane moves past this diagnostic (report the next one
verbatim).

## Implementation Plan

Written 2026-10-05 after reproducing on `upstream/main` b6324ee6d1.

### Root cause (measured)

Two defects compose:

1. **Order dependence.** `ensureMapRuntimeTypes` publishes the native `$Map`
   runtime struct as `ctx.structMap.get("Map")`. `collectClassDeclaration`
   resolves `class U extends Map` through `ctx.structMap.get(parentClassName)`,
   so whenever ANY earlier declaration typed something as a `Map`
   (tailwindcss's `chunk-5JIJA4QV.mjs` class `p` with
   `constructor(e = new Map) { this.values = e }`), the builtin heritage
   resolves to the runtime struct and `U` is registered as an ordinary
   WasmGC subtype of `$Map` with NONE of `$Map`'s fields — the layout the
   final hierarchy audit rejects. With no earlier `Map` type the same class
   instead hits the explicit #2620/#3972 refusal ("declared property … not yet
   supported"). Two-line fixture (`.tmp/m7.mjs` shape):
   `var P = class { constructor(e = new Map()) { this.values = e } };` before
   the `U` declaration flips the diagnostic.
2. **No own-field storage on a native-collection subclass.** The standalone
   Map/Set/WeakMap/WeakSet subclass is externref-backed: `super()` returns a
   bare branded `$Map`, and `this.f = …` has nowhere to live (the #3972 note
   in `standalone-subclass-ctors.ts`).

Rejected alternative (measured): make `U` an ordinary struct subclass of
`$Map` (copy the prefix, treat it like a user parent). It compiles but fails
validation as soon as `instanceof` runs — class structs are assumed to carry
`__tag` at field 0, which a `$Map` prefix makes impossible.

### Fix — a `$Map`-subtype carrier for the externref-backed representation

New module `src/codegen/classes/standalone-collection-carrier.ts` (standalone/WASI
only; the JS-host lane never reaches it):

- `$Map` is never a user-class parent: when the heritage is a native
  collection builtin that resolved to no user class, `collectClassDeclaration`
  ignores the runtime struct (fixes defect 1 in every mode — the old path could
  only produce an invalid module, so no successful binary changes).
- A standalone `class X extends Map|Set|WeakMap|WeakSet` with a declared
  instance FIELD becomes a *carrier* class: still externref-backed (so every
  measured-working inherited-method/brand path is untouched), but its
  registered struct is `$Map`'s exact field prefix + `__tag` + own fields with
  `superTypeIdx = $Map`. `ref.test $Map` therefore still accepts the instance.
- `super(...)` (explicit and implicit) keeps calling the existing
  `__new_<Parent>@N` (iterable seeding unchanged) and wraps the result with a
  per-class `__<X>_collection_carrier(externref) -> externref` that copies the
  five `$Map` fields into `struct.new $X` (brand `kind` copied, so Set/Weak*
  work too).
- `$Map`'s field names become reserved (`__map_*`): names are not encoded in
  the binary, but the carrier puts them in `ctx.structFields`, where a
  structural scan for a user `x.entries()`/`x.kind` must not match them.
- Own-field reads/writes on a carrier take the ordinary struct path
  (`externrefBackedOwnFieldBacking` → `"collection-struct"`, which the
  plain-object `__extern_get/__extern_set` fallback skips). Declared field
  initializers run after `super()` via `struct.set` on the cast receiver.
- Still refused (CE, not a trap): a declared accessor on a collection
  subclass and a subclass OF a carrier class (its `super()` would bypass the
  carrier constructor).

### Acceptance / measurement

- `tests/issue-6754-standalone-map-subclass-fields.test.ts`: the issue's
  minimal class and the tailwind `U` shape compile with zero imports and run
  correctly in standalone, in both declaration orders; anti-vacuity control:
  the fixture fails on the parent commit.
- Scoped standalone test262 over `built-ins/Map`, `built-ins/Set`,
  `language/statements/class/subclass`, `language/expressions/class/subclass`
  before/after.
- tailwindcss `standalone-dynamic` lane before/after; JS-host fixture binaries
  byte-identical.

## Resolution

Implemented as planned, plus one defect found on the way. In a standalone
Map/Set/WeakMap/WeakSet subclass, `super.<m>(…)` had no compiled `Map_<m>`.
The host bridge is refused in standalone, so the call silently folded to
`undefined`: tailwind's `super.get(r)` cache never hit. It now calls the native
collection helper on `this` (`compileCollectionSuperMethodCall`).

Measurements, 2026-10-05:

- **tailwindcss `standalone-dynamic`.** Before: compile-error `struct hierarchy
  layout became invalid … (U) supertype #93 (Map) is no longer an exact
  mutable-field prefix`. After: still compile-error, but the hierarchy
  diagnostic is gone. The next and only error is `stack-balance invariant
  (entry): '__anon_87_parseCandidate' references local 37, but only 2 params +
  10 locals are declared`, filed as
  [#6862](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6862-tailwind-standalone-parsecandidate-stack-balance).
- **Scoped standalone test262.** Covered `built-ins/Map`,
  `language/statements/class/subclass` and every test262 file containing
  `extends Map|Set|WeakMap|WeakSet`: 336 rows, each run in-process in its own
  call, on base b6324ee6d1 and on the fix. Before: 282 pass, 41 fail, 13
  compile_error. After: identical, with zero per-row flips.
- **JS-host lane.** Six probe fixtures (`.tmp/h1`, `m1`, `m7`, `b2`, `m8`,
  `f5`) produce byte-identical binaries. Every new arm is gated on
  standalone/WASI, and `$Map` field names are not encoded in the binary.
- **Regression test.** `tests/issue-6754-standalone-map-subclass-fields.test.ts`
  passes 10/10. On the parent, 8 tests fail; the field-less control and the
  JS-host compile pass on both.

Residuals, filed separately:
[#6856](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6856-standalone-map-get-override-strict-eq-fold)
(a TS `get(k: any)` override folds `Map#get(...) === n` to false; this was
already the case on base) and
[#6857](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6857-standalone-map-subclass-iteration-dispatch-gaps)
(for-of destructuring CE, forEach, spread and any-typed override dispatch on a
Map subclass; all already failing on base). Still refused with a clean CE: a
declared accessor on a collection subclass, and a subclass of a field-bearing
collection subclass.
