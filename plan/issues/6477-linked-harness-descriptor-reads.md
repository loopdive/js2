---
id: 6477
title: "Linked test262 harness: property-descriptor reads on consumer values differ from the honest lane"
status: in-progress
sprint: current
created: 2026-09-14
updated: 2026-09-15
# (2026-09-15, #6477 P2) The descriptor read and the two enumeration imports
# gain a `_decoderExportsFor` redirect plus the comment that explains WHY the
# redirect belongs at `_readOwnDescriptor`'s top rather than at each caller.
# The growth is comment-dominated; the mechanism is three assignments.
loc-budget-allow:
  - src/runtime.ts
func-budget-allow:
  - src/runtime.ts::resolveImport
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: runtime
language_feature: property-descriptors
goal: test262-conformance
depends_on: [3451]
related: [3451, 5225, 6475]
# id reserved 2026-09-14 with pr_scan="degraded" (gh unreachable): verified
# against upstream main + the assignment ref, NOT against in-flight PRs.
---

# #6477 — descriptor VALUES read wrong across the linked-harness boundary

## Problem

~14 rows of the #3451 slice-3 sample (measured 2026-09-14, 404 rows) differ with
messages of the form

```
foo descriptor value should be foobar
property descriptor value should be
Expected obj[foo] to equal NaN, actually data
```

concentrated in `built-ins/Object/defineProperty`.

## Why it is NOT the known pre-existing gap

`Object.prototype.hasOwnProperty.call` / `in` / `Object.hasOwn` on a compiled
object already answer wrong in the HONEST single-module lane under `allowJs`
(measured during #3451 P2), and #3451's substrate tests assert only PARITY there
because both lanes fail alike.

**These rows are different: the honest lane PASSES them.** So a value that the
honest lane reads correctly through `Object.getOwnPropertyDescriptor` reads
wrong when the reader is the provider and the object is a consumer struct. The
#5225 cross-module decoder registry is the mechanism that is supposed to answer
here (`_decoderExportsFor`), so the first question is whether it is consulted on
the descriptor-VALUE path at all, or only on the presence path.

## Acceptance criteria

- [ ] A minimal body reproducing one of the three messages, with the runtime
      path named.
- [ ] It is established whether `_decoderExportsFor` is reached on the
      descriptor-value read, and the answer recorded here.
- [ ] The ~14 rows flip to agreement without changing the honest lane.

## Implementation Plan (2026-09-15, Fable lane; implementation: Opus)

### Root cause (measured, not inferred)

Instrumented `src/runtime.ts` + `src/runtime/cross-module-struct-owners.ts`
and ran four minimal bodies through `scripts/test262-linked-harness-smoke.mts`
(cases kept in `.tmp/p6477/cases2`, gitignored):

```
[6477] __getOwnPropertyDescriptor import foo object (struct)
[6477] decoderFor enabled: false modules: 1 local=null
[6477]   -> desc undefined
```

While the test body runs, **the consumer is not a registered decoder**: the
#5225 registry holds ONE module (the provider), so `enabled` is false and every
cross-module read the provider makes on a consumer struct — `_readOwnDescriptor`
step 3 (`__sget_<name>` / `_structHasOwnFieldName`), `_safeGet`'s
`_crossModuleCallbackState`, `_wasmStructHasOwn` — resolves with the
**provider's** exports, whose `__struct_field_names` answers `null` for a
struct it never minted. Result: `undefined` for a literal field, a `null`/`0`
miss-default for a boxed number/NaN, "should be an own property" for
`hasOwnProperty`.

Why the consumer is missing: `scripts/test262-import-object.mjs` registers it
in `wireCompiledInstance(importObj, instance, true)` **after**
`WebAssembly.instantiate` returns — but a test262 body is top-level code, and
in the JS lane top-level code runs in the wasm `start` section, i.e. DURING
instantiation (this is the #5193 window: "the wasm `start` section runs before
`instance.exports` exists"). The Temporal lane (#5225/#5353) never noticed
because its consumer bodies also run in `start`, but their cross-module reads
go through funcref-registered helpers or happen post-init; the harness lane
makes the provider read consumer structs on the hot path.

The honest lane passes the same rows because there is one module and the
decoder redirect is a no-op. So this is a lane defect, not a codegen defect,
and it answers the issue's first question: `_decoderExportsFor` IS reached on
the descriptor-VALUE path (via `_readOwnDescriptor` callers) — it just has
nothing to redirect to.

**Also found, same trace:** `__getOwnPropertyDescriptor` (runtime.ts ~L14449)
passes `callbackState?.getExports()` straight into `_readOwnDescriptor`; unlike
`_wasmStructHasOwn` (which applies `_decoderExportsFor` at its top) it never
redirects. Fixing registration alone leaves that import reading the provider's
exports.

### Fix — two parts, host-side only, honest lane byte-identical

**P1 — run the linked body AFTER the consumer is wired (the actual fix).**
The mechanism already exists: `CompileOptions.deferTopLevelInit` (#2796,
`src/index.ts` ~L905) exports `__module_init` instead of installing a `start`
section, and `tests/issue-4017.test.ts` shows the host shape:
`setInstance(instance)` then `exports.__module_init()`.

1. `src/test262-harness-provider.ts` `compileHarnessLinkedBody` (~L446): pass
   `deferTopLevelInit: true` alongside `canonicalRuntimeTypes` /
   `sharedExceptionTag`. Consumer only — the provider build (`compileProject`,
   ~L303) is unchanged.
2. `scripts/test262-import-object.mjs` `instantiateTest262Module` linked arm
   (~L268): after `wireCompiledInstance(importObj, instance, true)`, if
   `typeof instance.exports.__module_init === "function"`, call it. Keep the
   call INSIDE the linked arm so the honest lane's instantiate path is
   untouched. A throw from `__module_init` must propagate exactly like a
   start-section throw did (the worker classifies the row from that rejection).
3. Async rows (`$DONE`, #6476): `__module_init` returning does not mean the
   row is done; the worker already awaits the marker after instantiate, so
   nothing changes — but verify with `tests/issue-6476-linked-async-marker.test.ts`.
4. Anything else that instantiates a linked harness body must make the same
   call: `scripts/test262-linked-harness-smoke.mts` and the three
   `tests/issue-3451-*`, `tests/issue-6475-*`, `tests/issue-6476-*` suites all
   go through `instantiateTest262Module`, so step 2 covers them — confirm by
   grep for `compileHarnessLinkedBody(` callers.

**P2 — redirect the descriptor import through the decoder registry.**
`src/runtime.ts` `__getOwnPropertyDescriptor` import: compute
`const exports = _decoderExportsFor(obj, callbackState?.getExports())` once and
pass it to `_readOwnDescriptor` (and to the `_wrapForHost` on the static-method
branch below it). Same one-line treatment for `__getOwnPropertyNames` and
`__propertyIsEnumerable` if they take the raw `getExports()` (check; `has` /
`in` already redirect via `_wasmStructHasOwn`). Single-module behaviour is
unchanged because `_decoderExportsFor` returns `exports` when no linked project
is live.

Do NOT extend `INIT_MARSHAL_HELPERS` (#5193) to carry `__struct_field_names` /
`__sget_*` into the start window — that is the alternative design and it does
not scale (one funcref per field name per module); P1 removes the window
instead.

### Order and validation

1. Capture the before-state: `node --import tsx scripts/test262-linked-harness-smoke.mts .tmp/p6477/cases2 10`
   (recreate the four bodies from this issue's "Root cause" if `.tmp` is gone:
   `num`, `plainval`, `arr540`, `a67desc` — see git history of this file's
   lane notes) and the 13 rows named below via the real worker protocol
   (`tests/test262-local-shard1.test.ts`, `COMPILER_POOL_SIZE=1`,
   `TEST262_ORACLE_MODE=linked` vs honest).
2. P1, then P2. Rebuild BOTH bundles before measuring — the worker and the
   smoke load `scripts/runtime-bundle.mjs` (`pnpm run build:runtime-bundle`),
   not `dist/`; a `pnpm run build` alone leaves the lane on the old runtime.
3. New test `tests/issue-6477-linked-descriptor-reads.test.ts` modelled on
   `tests/issue-6475-linked-provider-realm.test.ts`: the four bodies above pass
   in the linked lane; plus a control asserting `__module_init` is exported and
   `startFuncIdx` is absent for a linked body, and present/absent the other way
   round for an honest compile (byte-identity guard for the honest lane).
4. `tests/issue-3451-*`, `issue-6475-*`, `issue-6476-*`, `issue-5225*`,
   `issue-5353*`, `issue-5364*`, `issue-5738*` green; equivalence gate clean.

### The 13 rows (2026-09-15 measurement, all honest=pass linked=fail)

- `built-ins/Object/defineProperty/15.2.3.6-4-{49,67,68,299-1,300,354-10,540-8}.js`
- `language/expressions/class/elements/multiple-{stacked-definitions-rs-static-async-method,stacked-definitions-rs-static-generator-method,stacked-definitions-rs-static-generator-method-…-alt,definitions-rs-privatename-identifier-initializer-alt,definitions-rs-static-privatename-identifier-alt,stacked-definitions-grammar-privatename-identifier-semantics-stringvalue}-privatename-identifier*.js`

### Acceptance

- [ ] The four minimal bodies pass in the linked lane (vitest).
- [ ] ≥ 12 of the 13 rows flip to agreement on the real worker; any that do
      not are named here with their remaining message.
- [ ] Honest lane byte-identical (no `deferTopLevelInit` outside
      `compileHarnessLinkedBody`; control test above).
- [ ] `plan/issues/3451-…md` measurement table gets a new row.
