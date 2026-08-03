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

Either thread the transitive sibling captures into the fnctor twin's signature
(the same leading-capture-params contract lifted declarations use), or refuse
fnctor admission for constructors whose call graph reaches capturing siblings
declared in an enclosing function frame — a decline is strictly better than
emitting an invalid module.

## Acceptance

- acorn 8.18 UMD compiles to a **validating** module, or the fnctor admission
  declines with the generic path taking over (no `WebAssembly.compile` error).
