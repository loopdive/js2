---
id: 3978
title: "lit: make the published implementation and upstream batches emit valid Wasm"
status: ready
created: 2026-08-01
updated: 2026-08-11
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: compiler-internals
goal: dogfood
sprint: current
horizon: l
related: [3775, 3977]
---
# lit-html's published bytes compile to an invalid Wasm module

## 2026-08-11 continuation

The catalog's pinned `lit@3.3.3` entry now follows enough implementation code
to expose `@lit/reactive-element`'s class-initializer path. Its current first
failure was no longer the immutable-global signature documented below, but a
type-invalid `y_addInitializer` body:

```text
local.tee expected (ref null 2), found f64.const
```

The source is the generic Lit pattern:

```js
static addInitializer(initializer) {
  this._$Ei();
  (this.l ??= []).push(initializer);
}
```

`l` is not a collected class struct field. The logical-assignment lowering
treated an unknown property as a numeric `NaN` sentinel, skipped the required
dynamic get/set, and then used that f64 as the receiver of `.push`. Unknown
class/object properties under `??=`, `||=`, and `&&=` now use the ordinary
dynamic property path. The reduced regression is
`tests/issue-3978-dynamic-logical-property.test.ts`.

Measured catalog result after the fix:

- compile succeeds in about 2.03 seconds;
- the emitted binary is 98,116 bytes;
- `WebAssembly.Module` accepts it.

That does **not** complete this issue. The full pinned Lit source suite was run
unchanged after the fix. It admits 583 of 587 upstream tests and still scores
8/16. Two implementation files remain invalid before their tests can run:

| file | tests | current validation failure |
| --- | ---: | --- |
| `directives/async-append_test.ts` | 11 | `return_call[2]` expects `externref`, gets a GC ref |
| `directives/async-replace_test.ts` | 17 | `call[2]` expects `externref`, gets a GC ref |

The suite also reports 92 invalid test batches, primarily stale/mistyped
`global.set` operands in ReactiveElement tests plus async-resume stack errors.
Those are genuine remaining compiler failures, not missing browser
infrastructure. Keep this issue `ready` until `compile.implementationInvalid`
is empty and the invalid-batch frontier is assigned or fixed.

## Problem

`WebAssembly.compile` rejects the module js2wasm emits for lit-html's published
implementation. Nothing is wrong with the source, and no test code is involved —
this is the bundled published package **on its own**:

```
WebAssembly.compile(): Compiling function #94:"__anonClass_1_p" failed:
  immutable global #255 cannot be assigned @+21356
```

The compiler reports `success: true` and emits a 60 KB binary. The binary is
simply not valid Wasm, so every downstream stage — instantiate, run, diff —
never happens.

Measured against the pinned tarballs (`lit-html@3.3.3`,
`@lit/reactive-element@2.1.2`, `lit-element@4.2.2`, all sha1-verified — see
`tests/dogfood/lit-upstream-suite-pin.json`):

| bundled entry                      |  bytes | result                                          |
| ---------------------------------- | -----: | ----------------------------------------------- |
| `@lit/reactive-element`             | 11,512 | VALID                                           |
| `lit-html/is-server.js`             |  1,088 | VALID                                           |
| `lit-html/directives/choose.js`     |  1,189 | VALID                                           |
| `lit-html` (`html` + `render`)      | 11,794 | **INVALID** — immutable global #255              |
| `lit-html/directives/repeat.js`     | 15,357 | **INVALID** — immutable global #333              |
| `lit-element`                       | 23,474 | **INVALID** — immutable global #461              |

Anything that pulls lit-html's template machinery is invalid. That is the
majority of lit.

## Why this was invisible

`benchmarks/results/npm-compat.json` shows `lit` compiling and validating in
201 bytes. That is not a small module — it is the **whole** of what the `lit`
tarball contains:

```js
import "@lit/reactive-element";
import "lit-html";
export * from "lit-element/lit-element.js";
export * from "lit-html/is-server.js";
```

`lit/index.js` is a four-line barrel. The implementation ships in three
**separate** packages that are not in the `lit` tarball at all, so the
package-entry card compiles a re-export list and reports success. The green
card and the broken compiler output are both accurate about different things;
only one of them is about lit.

This is a general lesson for the npm-compat catalog, not a lit quirk: for any
package whose tarball is a barrel, "entry compiles + validates" measures the
barrel. #3977 fixes it for lit by compiling the three real packages.

## Diagnosis so far — and what is NOT established

The offending function is the `p` method of lit-html's `TemplateInstance`
(minified to class `R`):

```js
p(t2) {
  let i2 = 0;
  for (const s2 of this._$AV)
    void 0 !== s2 && (void 0 !== s2.strings
      ? (s2._$AI(t2, s2, i2), i2 += s2.strings.length - 2)
      : s2._$AI(t2[i2])), i2++;
}
```

Emptying that one method body makes the whole module VALID, so `p` is
genuinely where the bad instruction is emitted.

**What was ruled OUT** (each tested by editing `p` inside the real bundle and
recompiling — all still INVALID, at the identical function index, global index
and byte offset, so none of these is the trigger):

- the local's NAME — renaming `i2` changes nothing, so it is not a collision
  with a module-level binding;
- the comma-expression loop body — rewriting it as a block changes nothing;
- `let` vs `var` for the counter.

**What was ruled out as the mechanism:**

- **Not a global-count threshold.** Padding a known-valid variant with 400
  extra top-level `let` bindings kept it VALID.
- **Not a string-constant/import-shift threshold.** Padding with 80 distinct
  string literals — which do add imported globals — also kept it VALID. This
  matters because the module has **237 imported globals and only 23 declared
  ones**, so global #255 is a *declared* global (index 18 of 23) that the
  validator says is immutable. An import-count shift was the obvious
  explanation and it does not hold up.

**The narrowest reproduction found** — replacing `p`'s body with this keeps the
module INVALID, while the sequential (non-ternary) version of the same two
calls is VALID:

```js
p(t2) {
  let i2 = 0;
  for (const s2 of this._$AV) { void 0 !== s2.strings ? s2._$AI(t2, s2, i2) : s2._$AI(t2[i2]); i2++; }
  return i2;
}
```

So the trigger involves a **ternary in statement position whose two branches
call the same method at different arities** (`_$AI` is declared with two
parameters, one defaulted, and is called here with three and with one).

**This does NOT reduce to a standalone snippet.** Five hand-written standalone
programs with exactly that shape — including one using anonymous class
expressions, matching lit's minified output — all compile to VALID modules.
The bug needs the surrounding module context, and I did not isolate which part
of that context. Anyone picking this up should start from the real bundle, not
from the snippet above.

## Relationship to #3775

Same signature family: a `global.set` against an index that is wrong only in
context, invisible to every construct-level reduction. #3775's title still
claims a missing coercion; #3958 already recorded that this is wrong and that
the evidence points at a stale global index. This issue is the second
independent sighting, and adds a hard data point #3775 lacks: the failing index
is a **declared** global, and neither the declared count nor the imported count
is what moves it.

Worth fixing together. If one root cause explains both, the React suite's
invalid batches (`INVALID_BATCH_CEILING` in
`tests/dogfood/react-upstream-suite.test.ts`) should drop at the same time.

## Reproduction

```bash
pnpm run dogfood:lit-upstream-suite
```

The report at `tests/dogfood/report/lit-upstream-suite.json` lists every
affected file under `compile.implementationInvalid`, each with the validator's
own message. The bundle can be regenerated standalone from the pinned tarballs
via `setupLitImplementation()` in `tests/dogfood/setup-lit-upstream-suite.mjs`.

## Acceptance criteria

- [ ] `lit-html` (`html` + `render`) compiles to a module `WebAssembly.compile`
      accepts.
- [ ] `lit-element` and `lit-html/directives/repeat.js` likewise.
- [ ] `compile.implementationInvalid` in the lit suite report is empty, and the
      suite's `implementationInvalidTests` floor in
      `tests/dogfood/lit-upstream-suite.test.ts` is lowered to 0.
- [ ] The root cause is stated in terms of which index is computed where —
      not "made the symptom go away" — and #3775 is re-checked against it.
