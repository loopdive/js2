---
id: 4642
title: "codegen: a LIFTED function that falls off its end completes with null, not undefined — Function(\"\")() === null (filed as a runtime-eval provider bug; the provider was not involved)"
status: done
assignee: dev-4647
sprint: current
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: eval
goal: standalone-gap
related: [4639, 4637, 4624, 2928]
loc-budget-allow:
  # +15 lines in a 3318-line god-file, all of it the WHY comment on
  # `appendDefaultReturn` plus the `ctx` parameter the fix needs. The gate's
  # remedy ("add code to the subsystem module") does not apply: the natural
  # home is `src/codegen/closures/param-emit-helpers.ts` next to its sibling
  # `emitDefaultReturnValue`, but that module documents itself as a LEAF that
  # imports only IR/context types precisely to stay cycle-free, and the fix
  # needs `canonicalUndefinedExternInstrs` from the heavy `any-helpers.ts`.
  # Moving it would trade a 15-line budget overrun for an import cycle risk.
  - src/codegen/statements/nested-declarations.ts
origin: "dev-4639/dev-4637 three-lane investigation (2026-08-23), both dead ends recorded in #4639's issue file under '## Handed to another lane'. Owner: runtime-eval provider."
---

# #4642 — implicit completion value crosses as null

## Problem (measured by dev-4639 + dev-4637, jointly narrowed)

```js
function h(){}; var g = Function("");
String(h()) + "|" + String(g())   // "undefined|null"  — spec: "undefined|undefined"
```

Established by the two lanes' A/B exchange (full chain in #4639's issue
file):

- An EXPLICIT `return undefined;` through the same conversion decodes
  correctly — the decode arm and the classifier are both faithful
  (`classifiedValue` tags the singleton `_UNDEFINED` and a bare
  `ref.null.extern` `_NULL`, correctly, both times).
- The wrong value is TIER-INDEPENDENT: identical under the quickjs
  provider AND `JS2WASM_EVAL_ENGINE=interpreter` — which rules out both
  engines and their marshalling in one measurement.
- The shared piece is NOT in `src/`: `__runtime_apply_interpreted` is a
  host import whose body lives in the provider artifact
  (`scripts/runtime-eval-provider.mjs` ~L233, returns
  `[ok, __runtime_eval_wrap_result(exposeRuntimeEvalValue(value))]`).

Leading hypothesis, EXPLICITLY NOT MEASURED (both lanes declined to fix
blind): the provider is itself a js2wasm-compiled module, so a JS
`undefined` for an implicit completion materializes as `ref.null.extern`
crossing into its wasm — i.e. the envelope encoding of an implicit
completion, provider-side.

## Permanent repro references (#2093)

Affected conformance rows (the #4637-A5 family, all requiring the eval
tier): `test262/test/built-ins/Function/S15.3.2.1_A1_T10.js`,
`test262/test/built-ins/Function/S15.3.2.1_A3_T15.js`. The minimal probe
above belongs in a `tests/issue-4642.test.ts` when implemented.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Verify the
   hypothesis FIRST: instrument the provider's wrap path for an implicit
   vs explicit completion; find where undefined degrades to null.
2. Fix in the provider build (`scripts/runtime-eval-provider.mjs` /
   `scripts/build-quickjs-eval-provider.mjs` land) — encode the implicit
   completion as the undefined envelope the decode arm already handles.
3. Verification surface is a PROVIDER REBUILD plus an eval-dependent
   corpus sweep (the reason both wave-3 lanes declined): rebuild both
   tiers, re-run the eval-dependent ES≤5 rows before/after (own runs),
   plus the affected #4637-A5 `built-ins/Function` S15.3.2.1 rows.
4. Pins: extend tests with the `"undefined|undefined"` probe both tiers.

## Root cause — the provider hypothesis was FALSE

Measured on this branch's base (campaign HEAD `52cb0a6a6`), quickjs tier and
`JS2WASM_EVAL_ENGINE=interpreter`, identical both times:

| probe | base | spec |
| --- | --- | --- |
| `Function("")()` | `null` | `undefined` |
| `Function("return;")()` | `undefined` | `undefined` |
| `Function("var x = 1;")()` | `null` | `undefined` |
| `Function("1+2;")()` | `null` | `undefined` |
| `new Function("")()` | `null` | `undefined` |
| `Function("a","")(5)` | `null` | `undefined` |
| **`for (i…) Function(bodies[i])()`** (loop-carried, unfoldable) | **`undefined`** | `undefined` |

The last row is the measurement that killed the hypothesis. Making the body
string **unfoldable** already answered `undefined` **on base**. So the wrong
value is produced only when the body is a compile-time CONSTANT — and a
constant-body `Function(...)` **never reaches the provider at all**: #2924's
`tryStaticNewFunction` (`src/codegen/expressions/eval-inline.ts`) synthesizes
`function __new_function_N(<params>) { <body> }`, hoists it through
`hoistFunctionDeclarations`, and compiles it AOT. Confirmed structurally: the
module for `var f = Function(""); f()` declares **no `js2wasm:runtime-eval`
import**, and its WAT contains

```wat
(func $__new_function_73 (type 60)   ;; (func (result externref))
  ref.null extern
)
```

That `ref.null.extern` is the whole bug. It comes from `appendDefaultReturn`
(`src/codegen/statements/nested-declarations.ts`) — the tail every **lifted**
function declaration gets when its body does not end in `return`:

```ts
else if (returnType.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
```

Under the standalone value model a bare `ref.null.extern` **is** JS `null`
(#2864: the tag-1 `$undefined` singleton is reserved in every
standalone/native-strings module and `undefined === null` is false there). The
TOP-LEVEL tail in `src/codegen/function-body.ts` had already been routed
through `emitUndefined`; this lifted tail was the straggler. It is not
eval-specific at all — a plain nested `function nd(a) { if (a) return {}; }`
answered `null` for `nd(0)` on base, with no `Function` anywhere.

Why the tier-independence and the "explicit `return undefined;` is correct"
evidence both pointed the wrong way: the fold is in the compiler, so it is
identical under either provider; and an explicit `return;`/`return undefined;`
takes the *return-statement* path, which already emitted the singleton.

## Fix

`appendDefaultReturn` now takes `ctx` and emits
`canonicalUndefinedExternInstrs(ctx)` for an `externref` return slot. Two
deliberate choices:

- **`canonicalUndefinedExternInstrs`, not `emitUndefined`** — it is a READ-ONLY
  `funcMap` lookup and never registers a late import mid-body, which would
  shift funcidxs under the lifted body's caller. `emitUndefined` can call
  `ensureGetUndefined`, which does.
- **Scope kept to the one measured site.** The sibling
  `emitDefaultReturnValue` (`src/codegen/closures/param-emit-helpers.ts`) has
  the same hardcoded `ref.null.extern`, but its only caller
  (`emitClosureDefaultReturnValue` in `src/codegen/closures.ts`) already
  intercepts the `externref` case and routes it through `emitUndefined` — so
  that arm is dead for `externref` and was left untouched. Verified by probe:
  function expressions, arrows and `Array.prototype.map` callbacks all already
  answered `undefined` on base.

## Test Results (runs executed on this branch)

`tests/issue-4642.test.ts` — **6 passed** (quickjs tier) and **6 passed**
(`JS2WASM_EVAL_ENGINE=interpreter`, refusal provider). Every pin verified to
FAIL on base by file-copy revert of `nested-declarations.ts` alone.

Scoped standalone sweep, `built-ins/Function` **flat** (179 files), both arms
run by this lane's own driver, base arm = file-copy revert of both source files
**plus a freshly-built base-source provider adapter** (see the artifact-staleness
note below):

| arm | pass | fail |
| --- | --- | --- |
| base (52cb0a6a6) | 166 | 13 |
| this branch | 168 | 11 |

**+2, zero regressions**, and the two flips are exactly this issue's named
rows: `built-ins/Function/S15.3.2.1_A1_T10.js` and
`built-ins/Function/S15.3.2.1_A3_T15.js`, both of which failed on base with
`Expected SameValue(«null», «undefined»)`.

The 309-file `built-ins/Function/prototype` sweep is shared with #4647; see its
`## Test Results`.

### Artifact-staleness correction — worth reading before quoting any eval-lane number

The FIRST base arm of the flat sweep read **154 pass**, and diffing it against
this branch showed **14** flips. Twelve of those were not this change-set at
all: the shared `/home/user/js2wasm/.test262-cache` quickjs **adapter**
(`quickjs-eval-adapter-1429ec7ecf2163fd.wasm`, built 2026-08-15) is compiled by
whatever compiler built it, and it was eight days stale relative to campaign
HEAD. Rebuilding the *unmodified* provider source against the current compiler
turned all twelve (`15.3.2.1-10-6gs`, `15.3.2.1-11-{1,3,5}-s`,
`S15.3.2.1_A1_T{8,13}`, `S15.3.2.1_A3_T{6,9,10}`, `S15.3_A2_T{1,2}`,
`StrictFunction_reservedwords_with` — all `SyntaxError`-expectation rows) green
with no source change at all.

Consequences for anyone else in this campaign: **a base arm that reuses the
shared cache measures a stale provider**, which inflates apparent flips and —
worse — can HIDE a real regression (a row that would pass on a true base and
fails after reads as "already failing"). CI is unaffected: it rebuilds the
adapter from source per run, keyed on `sha256(adapter source ∥ compiler bundle
hash)`. Local lanes should either rebuild
(`npx tsx scripts/build-quickjs-eval-provider.mjs` — ~9 s once the QuickJS
artifact is cached) or state that they did not.

## Residuals

- A lifted function whose return slot is a **concrete typed ref** (e.g. a
  native string `(ref null 3)`) still falls off the end as `ref.null <typeidx>`,
  which reads as `null`, not `undefined` — `function top(a){ if (a) return "z"; }`
  then `top(0)` answers `null`. That is a different defect (a typed slot cannot
  represent `undefined` at all; it needs the slot widened to `externref` or an
  option-typed lowering), deliberately NOT fixed here. Owner: value-rep
  (#2660 family).
