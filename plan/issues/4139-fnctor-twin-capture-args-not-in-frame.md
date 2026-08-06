---
id: 4139
title: "fnctor constructor twin passes sibling-capture arguments its own frame never received"
status: ready
sprint: Backlog
priority: medium
goal: core-semantics
feasibility: hard
horizon: m
created: 2026-08-03
requested_by: ttraenkler/claude-bench
related: [4088, 2043]
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
  - src/codegen/context/types.ts
  - src/codegen/closures.ts
---

# #4139 — `__fnctor_<C>_new` forwards captures its frame does not hold

## Problem

When a constructor function expression is admitted as a write-once fnctor and
its body calls **capturing sibling functions**, the devirtualized twin
(`__fnctor_<C>_new`) emits the sibling call with capture arguments sourced via
`cap.outerLocalIdx` — slots of the frame that *declared* the captures. The
fnctor twin's own frame has neither those slots nor same-named locals
(`fctx.localMap.get(cap.name) === undefined`), so PR #4088's cross-frame
capture-slot fix cannot rescue it: there is nothing in-frame to redirect to.

Observed on acorn 8.18's **UMD** bundle (`dist/acorn.js` — every top-level
binding lives in one IIFE, so `getOptions`/`wordsRegexp`/`hasOwn`/`isArray`
are frame locals of the IIFE):

```
WebAssembly.compile(): Compiling function #384:"__fnctor_Parser_new" failed:
call[0] expected type (ref null 125), found local.get of type anyref
```

Instrumented capture-slot misses during that compile (all with
`inFrame=undefined`):

```
fn=__fnctor_Parser_new callee=wordsRegexp cap=regexpCache outer=26 max=13
fn=__fnctor_Parser_new callee=getOptions  cap=isArray     outer=25 max=6
fn=__fnctor_Parser_new callee=getOptions  cap=hasOwn      outer=24 max=5
```

## Repro

Compile acorn 8.18 `dist/acorn.js` (UMD) with a `bench()` export on either
target — after PR #4088, compile succeeds and validation fails at
`__fnctor_Parser_new`. The ESM entry (module-level bindings, no IIFE) does not
reach this: same functions, but the captures resolve as module bindings.

## Direction (not prescribed)

Thread the transitive sibling captures into the fnctor twin's signature (the
same leading-capture-params contract lifted declarations use).

**The decline alternative was tried on 2026-08-03 and does NOT work.** A
post-compile audit (flag any capture-argument prepend that sources a foreign
frame slot; abort the twin, `unreachable` body, no cache, fall through to the
generic `new` path) produced strictly worse results on both probes:

- a WORKING minimal fnctor-with-capturing-sibling case regressed 6 → 0: the
  generic standalone `new` path over a function-expression constructor does
  not deliver the fnctor semantics the working twin did;
- acorn UMD then failed in a DIFFERT function (`__closure_0`:
  `local.set[0] expected (ref null 7), found local.tee of type (ref null 6)`)
  — the generic path has its own invalid-emission defect on this shape.

So the fallback is not a safe landing zone; only capture threading fixes this.
An adjacent silent-miscompile exists in the same family: a fnctor ctor calling
a sibling that reads a captured `hasOwn`-style binding through `.call` returns
wrong values (probe expected 20, got null) without any validation error.

## Progress

**Capture threading landed 2026-08-03** (standalone): the twin's prologue
casts the `__constructor_identity` param — which call sites already load with
the constructor's closure VALUE — to the closure struct recorded per AST node
(`ctx.closureStructByNode`) and spills every capture field into a frame local
registered under the capture's own name (cells register in `boxedCaptures`).
Sibling-call prepends then resolve in-frame via `capture-source-slot.ts`.
Guarded by `ref.test`; a null/foreign identity keeps the old behaviour.
acorn UMD's `__fnctor_Parser_new` validation failure is gone; the 39
fnctor/new/constructor test files show byte-identical failure lists with and
without the change (25 pre-existing). gc-target twins remain uncovered (no
identity param there).

acorn UMD now proceeds to the NEXT defect in its chain: `__closure_0` fails
validation with `local.set[0] expected (ref null 7), found local.tee of type
(ref null 6)` — a stack-balance arg-coercion temp (`$sn_tmp_*`,
stack-balance.ts) typed off inference that disagrees with the real value type.
Separate defect, not this issue.

## Acceptance

- acorn 8.18 UMD compiles to a **validating** module, or the fnctor admission
  declines with the generic path taking over (no `WebAssembly.compile` error).
