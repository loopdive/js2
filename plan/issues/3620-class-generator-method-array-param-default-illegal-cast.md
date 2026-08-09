---
id: 3620
title: "Standalone: a class generator method with an ARRAY binding-pattern parameter that has a DEFAULT traps `illegal cast` (~91-test uncatchable-trap bucket)"
status: done
assignee: ttraenkler/opus-3620
sprint: 77
priority: high
horizon: m
feasibility: hard
goal: standalone-gap
related: [3610, 3592]
created: 2026-07-25
completed: 2026-07-25
# +32 lines in registerNativeGenerator, of which ~24 are the comment recording
# WHY the state field must be typed at the runtime rep (the checker-tuple vs
# widened-externref divergence that produced the trap) — the exact knowledge a
# future edit would otherwise undo. The ~8 executable lines type that
# function's OWN state fields; there is no subsystem module to move them to.
loc-budget-allow:
  - src/codegen/generators-native.ts
---

## Problem

In the standalone lane, a **class generator method** whose parameter is an
**array binding pattern with a parameter default** traps with an uncatchable
`WebAssembly.RuntimeError: illegal cast`. A trap aborts the whole module and
escapes `try`/`catch`, so nothing after it can report.

```js
class C {
  *m([x] = [1]) {
    /* ... */
  }
}
new C().m().next(); // → RuntimeError: illegal cast
```

This is the second-largest single frame-signature bucket in the standalone
trap census (see "Census" below): **~91 rows** carrying
`illegal cast [in C_method() ← __module_init]` (69),
`[in __anonClass_0_method() ← __module_init]` (19),
`[in __anonClass_1_method() ← __module_init]` (4) and
`[in C_method() ← __closure_… ]` (3). Nearly all of them are
`test/language/{statements,expressions}/class/dstr/gen-meth-*`.

## Minimisation — measured, not assumed

Verified by direct compile + `WebAssembly.instantiate` + call (raw
`RuntimeError` observed from the engine; **not** via `runTest262File`, whose
payload renderer and frame enrichment are not trustworthy for classification):

| shape                                                                  | result           |
| ---------------------------------------------------------------------- | ---------------- |
| `class C { *m([x] = [1]) {} }`                                         | **illegal cast** |
| `class C { static *m([x] = [1]) {} }`                                  | **illegal cast** |
| `class C { *m([x = 23] = [,]) {} }`                                    | **illegal cast** |
| `class C { *m([x] = [1]) {} }` called _with_ an argument               | **illegal cast** |
| `class C { *m([x = 23]) {} }` — element default, **no param default**  | ok               |
| `class C { *m(x = 7) {} }` — scalar param default                      | ok               |
| `class C { *m({ a } = { a: 9 }) {} }` — **object** pattern + default   | ok               |
| `class C { m([x] = [1]) {} }` — **non-generator** class method         | ok               |
| `const o = { *m([x] = [1]) {} }` — **object-literal** generator method | ok               |
| `function* g([x] = [1]) {}` — plain generator **function**             | ok               |

So the trap requires the conjunction: **class** + **generator** method +
**array** binding pattern + **parameter default**. Object patterns, scalar
defaults, non-generator class methods, object-literal generator methods and
plain generator functions with the identical shape all work — which localises
the defect to the class-generator-method parameter lowering, not to
destructuring or to generators in general.

## Census context (why this bucket, and a correction)

Standalone baseline JSONL (fetched fresh 2026-07-25, 48,088 rows: pass 23,546 /
fail 17,408 / compile_error 7,002) — **739 trap rows**: illegal_cast 406,
null_deref 297, oob 36.

> **Correction to the earlier #3610 census.** That pass grepped the runtime
> message for `/null reference/`; the runner actually emits
> `dereferencing a null pointer`, so **null_deref was undercounted to zero**
> and the reported total (461) was ~280 low. Classify from the row's own
> `error_category` field — it is what the #3189 trap ratchet consumes — not
> from a hand-rolled message regex.

Top frame signatures (post-correction):

| frame signature                                                                      | count | assessment                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `null_deref [in __module_init()]`                                                    |   230 | **not one defect** — `__module_init` is just "top-level code"; the paths span object method-definition (66), class (45), Array.prototype (20), Function.prototype (12), Temporal, Proxy… No shared root cause to attack. |
| `illegal_cast [in __module_init()]`                                                  |    79 | same — a frame, not a cause                                                                                                                                                                                              |
| `illegal_cast [in C_method()/__anonClass_N_method() ← __module_init]`                |   ~91 | **this issue** — one syntactic shape, minimised above                                                                                                                                                                    |
| `illegal_cast [in __then_fulfill_#/__then_reject_# ← __drain_microtasks]`            |   115 | async CPS continuations — **entangled with #1373b (IR async CPS lowering), claimed in-progress in another lane**                                                                                                         |
| `illegal_cast [… ← __call_accessor_get ← __extern_get]`                              |    30 | compound-assignment poisoned accessor                                                                                                                                                                                    |
| `illegal_cast [in __closure_# ← __closure_# ← __call_fn_method_# ← __apply_closure]` |    28 | abrupt-completion payload (incl. the `Array.prototype.*` return-abrupt family from #3610)                                                                                                                                |

### Why this target and not the two larger counts

- The 230 `null_deref [in __module_init()]` rows share a _frame_, not a _cause_
  — `__module_init` is the top-level-code frame, so the bucket is a
  cross-section of unrelated defects. Counting it as one target would be the
  "population as forecast" error.
- The 115 async-continuation rows are one real signature, but they live in the
  CPS machinery **#1373b is actively rewriting** (claimed `in-progress` on
  `origin/issue-assignments`, branch `issue-1373-ir-async-cps`). Fixing the
  symptom in parallel would collide with that rewrite.
- This bucket is one signature _and_ one minimised syntactic shape _and_
  unowned (no merged commit, no open PR, no claim).

## Root cause (measured from the emitted WAT, not inferred)

Diffing the emitted WAT for `*m([x] = [1])` against the working `*m([x])`:

- The generator state struct is `$__GenState_C_m` with field
  `param___genarg0 (ref null 59)`, where type 59 is `$__tuple_0
(struct (field $_0 f64))` — the **tuple struct** `resolveWasmType` mints for
  the checker-inferred parameter type `[number]` (TypeScript infers that tuple
  _from the default initializer_ `[1]`).
- The factory `$C_m` has wasm signature `(param (ref null 56) externref)` — the
  defaulted parameter is **widened to `externref`** at the wasm boundary so the
  callee can detect "argument absent". That widening removes the call site's
  conversion to the tuple struct.
- The in-callee default materialization emits the array literal in its natural
  shape: `f64.const 1 / array.new_fixed / struct.new 4` — type 4 is
  `$__vec_f64`, **not** the tuple.
- The factory tail then packs the parameter into the state struct via
  `any.convert_extern ; ref.cast null (ref null 59) ; struct.new 62`.

So the field type says `$__tuple_0` while the value is always a `$__vec_f64`
(or an arbitrary externref) — and `ref.cast null` still traps on a non-null
value of the wrong type. Hence `illegal cast`, uncatchably, before the method
body runs. Without a default the parameter is not widened, the call site does
convert to the tuple, and the cast succeeds — which is exactly why the
neighbouring shapes pass.

**This is the same defect shape as #3610**: an unconditional `ref.cast`
justified by a static type that no longer describes the runtime value. See
"The reusable generalisation" in `3610-*.md`.

## Fix

`registerNativeGenerator` (`src/codegen/generators-native.ts`) now types a
**binding-pattern** parameter's state field at `externref` — the value's actual
wasm-boundary representation — instead of at the checker's inferred type. Keyed
off the synthetic `__genarg{i}` name minted for binding-pattern params (#2920),
the one place that already distinguishes them, so the name/type arrays cannot
drift. `info.paramTypes` carries the state-field types so the resume prelude's
`param_*` locals agree with the field it `struct.get`s.

No cast is emitted at all now; the resume prelude's destructuring reader
already dispatches dynamically over tuple-struct / vec / generic-iterable
receivers (a `ref.test` cascade), so `externref` is exactly what it is built to
consume.

## Measured reach

Against the **96**-row `illegal_cast [in C_method()/__anonClass_N_method()]`
bucket (all 96 run before/after on this branch):

|                       | before |  after |
| --------------------- | -----: | -----: |
| trap (`illegal cast`) | **96** |  **0** |
| pass                  |      0 | **80** |
| honest non-trap fail  |      0 |     16 |

**80 of 96 flip trap → pass (83%); the other 16 become ordinary catchable
assertion failures** (`assert.sameValue(x, 44)` on
`gen-meth-*-ary-ptrn-elem-obj-{id,prop-id}-init` / `elem-id-init-skipped` —
nested object patterns inside the array pattern, a separate binding gap). Zero
trap rows remain in the bucket.

No vacuous pass was converted into a failure: every one of the 96 was already
a trap-category failure, so no `trap-growth-allow` / de-vacuification
declaration is needed.

### Regression evidence

- 100-test stride sample of currently-PASSING standalone tests across the
  generator blast radius (class/object-literal/free generators, `dstr`,
  `gen-method`, `method-definition` — 2,036 passing tests in scope): **98
  pass, 2 fail**. Both failures (`use-strict-with-non-simple-param`) reproduce
  **identically on the unmodified base** — pre-existing baseline drift, not
  this change.
- Local generator suites: `generator-method-destructuring`, `generators`,
  `issue-2571-native-method-generators`,
  `issue-2079-standalone-generator-control-flow`,
  `issue-2169-destructure-native-generator`,
  `issue-2170-yield-star-delegation`, `issue-2172-nested-native-generator`,
  `issue-1665-standalone-generator-forof`, `generator-yield-contexts`,
  `generator-iife` — **70/70 pass**.

## Acceptance criteria

- [ ] `class C { *m([x] = [1]) { … } }` runs and binds `x` correctly in
      standalone (no trap), for both instance and `static` generator methods,
      with and without an explicit argument.
- [ ] The element-default form (`[x = 23] = [,]`) binds the default correctly.
- [ ] Controls unchanged: object-pattern defaults, scalar defaults,
      non-generator class methods, object-literal generator methods, plain
      generator functions.
- [ ] The `illegal_cast` trap category shrinks by the affected rows; no new
      trap rows.
- [ ] Tests assert observable BOUND VALUES, never "it compiles".
