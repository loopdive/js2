---
id: 4262
title: "Standalone error substrate: a minted TypeError must BE a TypeError, and err.constructor must be the value the NAME reads"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
completed: 2026-08-09
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: error-objects, try-catch
goal: error-model
related: [1104, 1536, 2025, 2902, 2962, 3130, 3468, 3614, 4249, 4251]
assignee: "ttraenkler/senior-dev"
loc-budget-allow:
  # property-access.ts +30: `typeErrorThrowInstrs` gains a no-JS-host arm plus
  # the WHY block that makes `forceInModuleCtor` (an index-shift-safety
  # requirement, not an optimisation) legible at the call site. The function is
  # called from nine files through this one entry point; splitting the four
  # instruction-building lines into a satellite would move the shift-safety
  # argument away from the code it constrains.
  - src/codegen/property-access.ts
---

# #4262 — the standalone error substrate

Two independent defects in how a host-free module represents a thrown error.
They share a symptom (`catch (e)` sees something that is not the error it should
be) and nothing else, so they are measured and gated separately.

Everything below is measured **sequentially** through the
`runTest262File(abs, tag, ms, "standalone")` seam under **Node 25**, on
`upstream/main@803a68c13`.

---

## Half 1 — `typeErrorThrowInstrs` threw a STRING

`typeErrorThrowInstrs` (`src/codegen/property-access.ts`) threw a native string
whose text merely *begins* with `"TypeError: "`. Reached from nine files, it is
the compiler's universal "property access on null/undefined" throw.

> **Attribution correction, up front.** #4249 and #4251 size this lever at "42
> ES5 files" (23 raw `TypeError: Cannot access property on null or undefined` +
> 19 `e instanceof TypeError`). That is a **signature match, not a causal
> one**, and the measurement below says so: of the 44 files carrying an
> error-substrate signature, **4** actually key on this throw site. The 19
> `e instanceof TypeError` files are the *native-proto brand-check* lever
> (`Number.prototype.toString.call(new String())` throws nothing at all, so the
> test's own `Test262Error` is what gets caught) — a different subsystem, named
> as sub-lever 2 in #4249's own "biggest lever" section. The 23 raw ones are
> mostly spurious throws from unrelated bugs (`Function()` dynamic code,
> `Array.prototype.concat` on a plain object). Sizing the substrate at 42 files
> would have been padding.

Measured on the base, in standalone (`tests/issue-4262-error-substrate.test.ts`,
which fails on the base and passes after):

| expression, inside `catch (e)` | base | after |
| --- | --- | --- |
| `e instanceof TypeError` | `false` | **`true`** |
| `typeof e === "object"` | `false` | **`true`** |
| `e.name === "TypeError"` | `false` | **`true`** |
| `e.constructor === TypeError` | `false` | **`true`** |
| `typeof e === "string"` | `true` | **`false`** |
| `String(e)` | `"TypeError: Cannot access property on null or undefined"` | *unchanged* |

The rendered text is deliberately **unchanged**: `__error_to_string` (#2962,
§20.5.3.4) renders `$name + ": " + $message`, so moving the `"TypeError: "`
prefix out of the message and into the struct's `$name` reproduces the old
string exactly. That keeps the runner's `classifyError` signature stable, which
matters because #3468 F1 buckets on message prefixes.

### Why it is safe to mint the constructor mid-body

`buildThrowJsErrorInstrs(..., { forceInModuleCtor: true })` resolves
`__new_TypeError` purely through `ctx.funcMap` after `emitWasiErrorConstructor`
has minted it, so **no `ensureLateImport` runs**. That is load-bearing, not an
optimisation: `typeErrorThrowInstrs` returns an `Instr[]` that callers splice
into half-built `then:` arrays, with no `fctx` to flush a shift against — an
import registration there is precisely the #1839/#117/#1886 index-shift trap.
A *defined* function minted by `mintDefinedFunc` carries a STABLE handle
(#1916 S3) that no shifter renumbers and that `resolveLayout` maps exactly once
at emit, so appending one cannot move an index already baked into a partially
built body. `ensureNullThisTypeError` (#2025) leans on the same property.

### Why JS-host mode is deliberately excluded

In host mode `__new_TypeError` is an `env` **import**, so the safety argument
above does not hold. The gc lane keeps the string throw and is byte-identical —
verified, see "Byte identity" below.

---

## Half 2 — `err.constructor` answered the WRONG carrier

`fillExternGetErrorProps` (`src/codegen/registry/error-types.ts`, the #3614 arm)
answered `<Test262Error instance>.constructor` from `ctx.funcClosureGlobals`.

A user function read as a VALUE lives in **one of two** module globals, and
`compileIdentifierValueRead` (`src/codegen/expressions/identifiers.ts`) picks
between them with a fixed precedence:

1. `ctx.moduleGlobals` (`$__mod_<name>`) — taken whenever the declaration is a
   reassigned live binding (`ctx.liveFuncBindingGlobals`, #2931) **or is
   closure-backed** (`ctx.closureMap`);
2. `ctx.funcClosureGlobals` (`$__fn_closure_<name>`) — the cached captureless
   singleton (#1340).

`fillExternGetErrorProps` always read (2). The literal upstream harness is
always in case (1), because `assert.js` closes over `Test262Error`. Two live
carriers means two distinct closure identities, and the closure PROPERTY BAG
(#3468) is keyed by identity — so the wrong carrier is both `!==` the name and
missing every static the source assigned to it.

Measured on the assembled literal harness (`.tmp/ph-ident2.js`, a synthetic
`includes: [propertyHelper.js]` probe that reports through its own throw):

| expression | base | after |
| --- | --- | --- |
| `Test262Error === Test262Error` | `true` | `true` |
| `e.constructor === e.constructor` | `true` | `true` |
| `e.constructor === Test262Error` | **`false`** | **`true`** |
| `Test262Error.name` | `"Test262Error"` | `"Test262Error"` |
| `typeof e.constructor.thrower` | **`undefined`** | **`"function"`** |
| `f = Test262Error; f === e.constructor` | **`false`** | **`true`** |
| `e.name` | `"Test262Error"` | `"Test262Error"` |

The WAT confirms the mechanism directly — the assembled harness carries
**three** `Test262Error` globals, `$__mod_Test262Error`,
`$__fn_closure_Test262Error` and `$__fnctor_proto_Test262Error`, and the first
two were being read by different consumers.

`userErrorCtorCarrierGlobal` (`src/codegen/error-ctor-carrier.ts`, a new
dependency-light leaf so the registry layer can import it without a cycle)
resolves the carrier with the identifier read's own precedence.

---

## The recorded RC1 fix in #4251 is WRONG — do not apply it

#4251 recommends giving the `Test262Error` arm of `tryCompileBuiltinGlobalNew`
a shadow guard so a module that DECLARES `Test262Error` falls through to the
fnctor path, on the evidence that a byte-identical constructor compiled under a
different name behaves correctly.

**Re-measured on `upstream/main@803a68c13`, the renamed control is WORSE, not
better.** Compiling sta.js's exact constructor shape twice in one probe, once as
`Test262Error` and once as `T262`:

| | `Test262Error` (intercepted) | `T262` (fnctor path) |
| --- | --- | --- |
| `typeof C === "function"` | ✔ | ✔ |
| `C.name === "<name>"` | ✘ | ✘ |
| `typeof C.prototype === "object"` | ✘ | ✘ |
| `e.message === "m"` | ✔ | ✔ |
| `e.name === "<name>"` | **✔** | **✘** |
| `e.constructor === C` | ✔ | ✔ |
| `String(e) === "<name>: m"` | **✔** | **✘** |

So removing the interception would trade two working behaviours for nothing,
across the ~2,779 tests #2902 made host-free. The parts of #4251's RC1 that
still hold are the *symptom* (`err.constructor !== Test262Error`,
`err.constructor.name === undefined`) — this issue supplies the actual cause.

`.tmp` probes are gitignored; the reproductions are re-derivable from the two
probe shapes described above and are pinned permanently in
`tests/issue-4262-error-substrate.test.ts`.

---

## Measured deltas

### Harness self-tests (`test262/test/harness/*.js`, 116 files, standalone)

| | pass | Δ |
| --- | --- | --- |
| base (`upstream/main@803a68c13`) | 49 / 116 | — |
| + Half 2 | 60 / 116 | +11, 0 lost |
| + Half 1 + Half 2 | **60 / 116** | **+11, 0 lost** |

Gained: the six `propertyhelper-verify{not,}{writable,enumerable,configurable}`
negative helpers plus `verifyProperty-arguments`, `-noproperty`, `-same-value`,
`-undefined-desc`, `-value-error`.

### ⚠ The ratchet file is NOT on `main` — it must be flipped when #4251 lands

`tests/es5-standalone-harness-selftests.test.ts` exists only on
`claude/test262-es5-pass-rate-vdseyg` (commits `12bfadd79` / `a8b078457`),
which was still in the merge queue when this was written, so this change could
not update it (branching off a queued branch is forbidden — CLAUDE.md
"Branch base"). **The ratchet fails in the improve direction by design**, so
whichever of the two lands second must flip these six entries from `"fail"` to
`"pass"` in the same PR:

```
propertyhelper-verifynotwritable-writable.js
propertyhelper-verifynotenumerable-enumerable.js
propertyhelper-verifynotconfigurable-configurable.js
propertyhelper-verifywritable-not-writable.js
propertyhelper-verifyenumerable-not-enumerable.js
propertyhelper-verifyconfigurable-not-configurable.js
```

and may additionally pin these five, now passing and previously unlisted:
`verifyProperty-arguments.js`, `verifyProperty-noproperty.js`,
`verifyProperty-same-value.js`, `verifyProperty-undefined-desc.js`,
`verifyProperty-value-error.js`.

Still failing there, with the reason: `sta.js` (RC2, `Test262Error.prototype`),
`compare-array-samevalue.js` (renders `expectedErrorConstructor.name`, the
dynamic-`.name` residual below) and `assert-throws-custom-typeerror.js` (a user
constructor NAMED `TypeError` shadowing the builtin — a different interception).

### Byte identity (26 modules × 2 lanes, `website/playground/examples/`)

`sha256` of the compiled binary, base vs. after:

- **gc / JS-host lane: 13 / 13 identical.** Half 1 is gated on `noJsHost`;
  Half 2 only runs under `ctx.wasi || ctx.standalone`.
- standalone lane: 9 / 13 identical. The 4 that differ
  (`benchmarks/helpers.ts`, `js/algorithms.ts`, `js/async.ts`, `js/classes.ts`)
  are exactly the modules that emit a null-check TypeError throw — the intended
  demand gate.

### Broad conformance sweep — 1,179 files, sequential, standalone

Corpus: the 44 ES5 files carrying an error-substrate failure signature; the
whole of `language/statements/try` (201), `built-ins/Function/prototype/call`
(49) and `built-ins/RegExp/prototype/exec` (79); and deterministic samples
(fixed LCG seed 20260809) of `built-ins/Object/defineProperty` (260),
`built-ins/Object/getOwnPropertyDescriptor` (120), `built-ins/Object` (150),
`language/expressions` (220) and `language/statements` (90).

```
TOTAL  A 935 -> B 939    gained 4    lost 0    (compared 1179)
  built-ins/RegExp/prototype:   60 -> 62  (n=83)
  language/statements/function:  0 ->  2  (n=9)
error-substrate signature set:   2 ->  6  (of 44)
```

Gained — and each is a file whose failure genuinely keyed on the string throw:

| file | why |
| --- | --- |
| `built-ins/RegExp/prototype/exec/S15.10.6.2_A2_T10.js` | bare `exec("s")` — the exact case #4249 called out from the emitted WAT |
| `built-ins/RegExp/prototype/test/S15.10.6.3_A2_T10.js` | its `test` twin |
| `language/statements/function/S13_A17_T1.js` | `assert.throws(TypeError, …)` — was `Thrown value was not an object!` |
| `language/statements/function/S13_A17_T2.js` | same |

**Zero regressions.** Half 2 contributes nothing to this corpus (the harness
self-tests are where it lands) and Half 1 contributes nothing to the harness
self-tests; the two are genuinely independent.

---

## Not done, and what it needs

- **`F.prototype` is not materialised for a user function** (`typeof
  Test262Error.prototype === "undefined"`). This is #4251's RC2 and it is
  **general**, not `Test262Error`-specific — the renamed `T262` control fails it
  identically, and so does a function that IS `new`'d (the base measurement in
  #4251 attributing it to "unless `new` is called" no longer holds). It gates
  the `sta.js` self-test. Out of scope here: it is a fnctor-prototype
  representation change, not an error-substrate one.
- **`F.name` read DYNAMICALLY** (`e.constructor.name`) still reads `undefined`
  while the static `Test262Error.name` reads correctly — the static site is
  answered by a compile-time fast path, the dynamic one falls through the
  closure property bag. It no longer gates the self-tests (Half 2 makes the
  identity comparison succeed before `.name` is ever rendered), but it will
  surface in any harness message that quotes `expectedErrorConstructor.name`.
- **`e instanceof <user fnctor>` leaks `env::__instanceof_check` in
  standalone** — the module does not instantiate at all. Reproduced with a
  two-line probe; unrelated to the error substrate, but it is the reason the
  `instanceof` half of the acceptance criteria in #4251 cannot be pinned for a
  user constructor.
- **Assigning a catch binding to a module-scope `var`** loses the value: in
  `var caught: any; try {…} catch (e) { caught = e }` the module global reads
  back as boolean `false`. Pre-existing (reproduced on the base); it is why the
  tests here answer every question *inside* the catch clause.
- **`typeErrorThrowInstrs`' siblings** — the many `emitThrowTypeError(ctx, fctx,
  "TypeError: …")` sites pass the class-name prefix *inside* the message, so
  they render as `"TypeError: TypeError: …"`. Not touched: each is a separate
  message-text change with its own signature-churn risk, and none of them is on
  the measured ES5 failing set.
- **`emitObjectArgNullGuard`** (`src/codegen/object-ops.ts`) is the same string
  throw in a different function, and two harness self-tests
  (`propertyhelper-verifyconfigurable-configurable-object.js`,
  `verifyProperty-configurable-object.js`) surface its text. Not converted: in
  those two the guard fires **spuriously** and the value is never caught, so a
  real TypeError changes nothing, while routing it through
  `emitThrowTypeError` would add a `__new_TypeError` **env import** to host-mode
  modules that have none today.
- **The cold-first-read ordering residual.** `fillExternGetErrorProps` only
  READS `__fn_closure_<name>`; that global is materialised lazily by the first
  identifier read, so a `.constructor` read that PRECEDES the first evaluation
  of the name anywhere still answers `undefined`. Pinned (as a `toBe(0)` that
  fails in the improve direction) in
  `tests/issue-4262-error-substrate.test.ts`. It does not affect the harness —
  `assert.js` evaluates `Test262Error` during module init. Fixing it means
  either seeding the singleton at module init or minting a `ref.func`
  trampoline at finalize, which is the shift hazard
  `ensureErrorCtorCarrierGlobal` documents.
- **A synthetic reproduction of the carrier SPLIT.** Every shape tried
  (self-referencing constructor, nested declarations, closure-captured
  thrower, two sibling constructors) produces `$__fn_closure_<name>` alone; the
  `$__mod_<name>` twin only appears in the assembled multi-include harness. So
  the discriminating pin for Half 2 is a real harness self-test, not a
  synthetic — stated explicitly in the test file rather than papered over.

## Permanent repros

- `tests/issue-4262-error-substrate.test.ts` — both halves, with cross checks
  that a naive always-true implementation fails.
- `tests/es5-standalone-harness-selftests.test.ts` — the ratchet.
