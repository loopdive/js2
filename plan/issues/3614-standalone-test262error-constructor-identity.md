---
id: 3614
title: "Standalone: a Test262Error instance's .constructor reads undefined, so assert.throws rejects correct throws (924 tests)"
status: done
completed: 2026-07-25
assignee: ttraenkler/opus-sa-assertfail
sprint: 77
created: 2026-07-25
updated: 2026-07-30
priority: high
horizon: m
feasibility: hard
task_type: bug
area: codegen
language_feature: error-constructors, exceptions
es_edition: multi
goal: standalone-mode
related: [2902, 3006, 3133, 3429, 3486, 3592]
origin: "Triage of the post-#3592 de-vacuification standalone `assertion_fail` bucket (12,038). Largest homogeneous cluster of the 5,114 newly-revealed pass→fail flips."
loc-budget-allow:
  - src/codegen/registry/error-types.ts
---

# #3614 — standalone `Test262Error` instance `.constructor` reads `undefined`

## Problem

`#3592` de-vacuified the standalone lane: `__apply_closure` had been
under-applying arguments, so `assert.sameValue(a, b)` (2 args into 3 formals)
never invoked the callee and ~5,000 tests reported a pass without executing a
single assertion. With the dispatch fixed, **5,114 tests flipped `pass`→`fail`**
(standalone `pass` 27,709 → 22,621). Those are the honest failures the fake
passes were hiding.

Clustering the 5,114 by their **actual assertion message** (not by the
`assertion_fail` bucket label, which is a symptom) produces one dominant
homogeneous group:

|   Count | Message                                                                             |
| ------: | ----------------------------------------------------------------------------------- |
|     938 | `Expected a TypeError to be thrown but no exception was thrown at all`              |
| **924** | **`Expected a undefined but got a different error constructor with the same name`** |
|     386 | `Expected a undefined to be thrown but no exception was thrown at all`              |
|     222 | `Expected SameValue(«"…"», «"…"») to be true`                                       |

The `…no exception was thrown at all` families are heterogeneous (one missing
throw each). The **924** are not: they are one defect. Split by the constructor
handed to `assert.throws`:

| Count | Expected constructor         |
| ----: | ---------------------------- |
|   854 | `Test262Error`               |
|    33 | `DummyError` + `TypeError`   |
|    14 | `DummyError`                 |
|     9 | `ExpectedError`              |
|     5 | `MyError`                    |
|     5 | `Test262Error` + `TypeError` |
|     3 | `CustomError`                |
|     1 | `StopReverse`                |

### Why the message says "undefined … with the same name"

Upstream `harness/assert.js`:

```js
} else if (thrown.constructor !== expectedErrorConstructor) {
  expectedName = expectedErrorConstructor.name;
  actualName = thrown.constructor.name;
  if (expectedName === actualName) {
    message += 'Expected a ' + expectedName + ' but got a different error constructor with the same name';
  }
```

Measured in standalone (probe `.tmp/probes/ctor2.js`, run through the CI-equivalent
pool path — see "Reproduction" below):

| Probe                                                  | before  | after   |
| ------------------------------------------------------ | ------- | ------- |
| `thrown.constructor === undefined`                     | `true`  | `false` |
| `thrown.constructor === expected` (via a parameter)    | `false` | `true`  |
| `expected === Test262Error` (identity via a parameter) | `true`  | `true`  |
| `Test262Error.name === 'Test262Error'` (static read)   | `true`  | `true`  |
| `expected.name === undefined` (read via a parameter)   | `true`  | `true`  |

So `thrown.constructor` is `undefined`; `undefined.name` does not trap in
standalone and yields `undefined`; `expectedErrorConstructor.name` read off a
**parameter** is also `undefined` — the two "names" compare equal and the
harness takes the "same name" branch. **The compiler threw exactly the right
error; only the `.constructor` back-pointer was missing.**

Note the identity substrate was already sound: `Test262Error === Test262Error`
holds, and holds **through a function parameter**. Only the back-pointer from
the instance was absent.

### Root cause

`emitStandaloneTest262Error` (#2902) lowers `new Test262Error(msg)` to the same
`$Error_struct` the WASI error constructors use, tagged `Error` with
`$name = "Test262Error"`. `fillExternGetErrorProps`
(`src/codegen/registry/error-types.ts`) is the reader that answers named keys on
an `$Error_struct` — and its `constructor` key arm answers **only** builtin
error constructors. Its `Error` arm is deliberately `$name === "Error"`-guarded,
with the comment _"Test262Error keeps today's miss"_, because Test262Error
SHARES the `Error` tag. Nothing else claimed the key, so the read fell through
to the standard miss and produced `undefined`.

## Fix

Add a `userCtorArms` block ahead of the builtin `ctorArms` in
`fillExternGetErrorProps`. When `$name` matches a
`USER_ERROR_CTOR_IDENTITY_NAMES` entry (today exactly `Test262Error` — the only
non-builtin `__new_<Name>` for which an `$Error_struct` is minted), answer with
`ctx.funcClosureGlobals.get(name)`: the **same** `__fn_closure_<Name>` global
(`method-trampolines.ts`) that a bare `Test262Error` mention resolves to. That
is the global the `expectedErrorConstructor` argument was itself read from, so
`===` holds by `ref.eq` — a genuine identity, not a null≡null tautology of the
kind #3006 replaced.

Two deliberate design constraints:

- **Read-only.** The arm only performs `global.get`; it never lazily
  materialises the closure. Materialising would require minting a `ref.func`
  trampoline at **finalize**, which is exactly the late-funcidx-shift hazard
  this file's own `ensureErrorCtorCarrierGlobal` note documents.

  The consequence, measured and pinned by a dedicated test rather than left
  implicit: `__fn_closure_Test262Error` is non-null only once the identifier
  has been **evaluated as a value** somewhere in the module. When it never is,
  the arm declines and `.constructor` keeps the historical `undefined`. That is
  harmless — with nothing holding the other side, no identity comparison is
  expressible — and it is exactly satisfied by the cluster this fixes, since
  `assert.throws(Test262Error, fn)` evaluates the identifier as its first
  argument.

- **Keyed on `$name`, not the tag.** Test262Error shares the `Error` tag, so a
  tag test would also claim genuine `new Error()` instances. The `$name` field
  is immutable and set at construction, and the existing `Error` arm already
  uses exactly this discriminator.

Scope gates: `__new_<Name>` must be present (the module actually lowered such a
constructor) **and** a `funcClosureGlobals` entry must exist. Every builtin
error name fails the second gate — builtins have no user function declaration
and therefore no closure singleton — so no builtin behaviour can shift.

## Acceptance criteria

- [x] `thrown.constructor === Test262Error` is `true` in standalone for a value
      thrown as `new Test262Error(...)` and compared **through a function
      parameter** (the harness's own shape).
- [x] The identity is genuine, not vacuous: `thrown.constructor === Error` and
      `thrown.constructor === someOtherFunction` stay `false`, and
      `thrown.constructor` is not `undefined`.
- [x] A genuine `new Error()` instance keeps answering the `Error` carrier —
      the `$name` guard is not bypassed.
- [x] JS-host lane untouched (the arm lives in a `ctx.wasi || ctx.standalone`
      guarded filler).

## Reproduction

`runTest262File` (`tests/test262-runner.ts`) is **NOT** the CI path and will
mislead: it renders thrown payloads via `originalHarnessThrownText`, which does
not call `tryNativeExnRender`, so every standalone `Test262Error` surfaces as
`uncaught Wasm-GC exception (non-stringifiable payload)` instead of its real
assertion message. The CI shard path is
`assembleOriginalHarness` → `CompilerPool(n, "unified")` →
`scripts/test262-worker.mjs`. The worker additionally imports two generated
bundles that are not in the tree:

```bash
npx esbuild scripts/compiler-bundle-entry.ts --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript --external:binaryen \
  --external:@typescript/native-preview '--external:@typescript/native-preview/*'
npx esbuild src/runtime.ts --bundle --platform=node --format=esm \
  --outfile=scripts/runtime-bundle.mjs --external:typescript --external:binaryen
```

Probe idiom: a `.js` file with test262 frontmatter that accumulates a `bits`
value and ends with `throw new Test262Error("BITS=" + bits)` — the thrown
message is what the runner records, so it is the only reliable output channel.

## Test Results

`tests/issue-3614.test.ts` — 7 cases, all green. Direct `compile({ target:
"standalone", nativeStrings: true })` + instantiate, asserting **observable
return values** (never "it compiles"); each module is additionally asserted to
carry an empty import manifest, so the verdicts come from the Wasm and not from
a JS host.

Two shape requirements are load-bearing and were established empirically —
getting either wrong makes the test pass vacuously against the wrong code path:

1. `new Test262Error(…)` must use a **bare identifier callee**.
   `new (Test262Error as any)(…)` is a parenthesized `AsExpression` and fails
   the `ts.isIdentifier` gate in `new-builtin-globals.ts`, so no
   `$Error_struct` is minted at all.
2. Every identity comparison must happen inside a **callee, on a parameter** —
   the shape `assert.throws` uses. A static identifier-to-identifier comparison
   takes a different, already-working path.

Confirmed to be a genuine regression test: with the `userCtorArms` spread
removed, the identity case returns `0` and the `.constructor === undefined`
case returns `1` (probe `.tmp/probe5.mts`: `test()` `1` with the fix, `2`
without).

## Follow-ups (filed separately, NOT in scope here)

- **#3617** — the 70 non-`Test262Error` members of the 924 (`DummyError`,
  `MyError`, `ExpectedError`, `CustomError`, `StopReverse`) are plain fnctor
  instances, not `$Error_struct`s, so they need the general fnctor
  `.constructor` back-pointer. Standalone counterpart of #3486.
- **#3618** — `expectedErrorConstructor.name` read through a parameter is still
  `undefined` in standalone (a static `Test262Error.name` read works). This
  flips no verdicts but corrupts failure MESSAGES — it is what collapsed 924
  heterogeneous-looking rows onto one string here — and is one of three
  independent mechanisms making message-derived bucket labels unreliable in
  this lane.
