---
id: 4149
title: "standalone: property-function stored through one alias returns null when called through another"
status: ready
sprint: Backlog
priority: high
goal: standalone-gap
feasibility: medium
horizon: m
created: 2026-08-04
requested_by: ttraenkler/claude-bench
related: [4088, 4144, 4145]
---

# #4149 — aliased property-function call answers null on standalone

## Problem

Four lines, no throw, silently wrong:

```js
var m = { exports: {} };
var e = m.exports;
e.f = function () { return 42; };
var a = m.exports;
export function t() { return a.f(); }   // standalone -> null (node: 42)
```

The direct form (`o.f = fn; o.f()` through the SAME binding) returns 42, so
the write and the call each work — they fail to MEET across aliases of the
same object. The IIFE variants (with and without captures) fail identically,
which is exactly the CommonJS/UMD wrapper shape:
`(function (exports) { exports.parse = ...; })(m.exports)` followed by
`m.exports.parse(...)`.

## Why it matters

This is **defect #6 in the acorn UMD chain** (#4145) — the module now
compiles and VALIDATES (after #4088/#4139/#4144's tee fix), and this is what
it dies on at runtime: every `acorn.<fn>()` call dispatches through the
alias and answers null; `acorn.parse` then throws a module-level exception
off the null. Injected in-factory probes confirmed: calls on the aliased
exports object return null for ALL stored functions, input-independent.

It also explains the silent-wrong fnctor probe recorded in #4139
("expected 20, got null").

## Notes for diagnosis

Likely the whole-program member analysis routing the WRITE (member-set
dispatch / sidecar keyed off `e`'s view of the shape) somewhere the aliased
READ (`__call_fn_method_*` / property-call dispatch on `a`) never
consults. The empty-literal shape (`{}`) plus post-hoc function-valued
property writes is the trigger shape.

## Diagnosis (WAT-level, 2026-08-04)

Dumped the golden repro's standalone module to WAT (`.tmp/alias-wat.mjs`) and
read both sides:

- **Read side is CORRECT.** `t()` lowers to
  `__apply_closure(__extern_get(<global for a>, "f"), …)` — dynamic $Object
  property fetch through the alias, then generic closure application. If the
  property were ever stored, this would find and call it.
- **Write side DROPS the value.** In `module_init`, `e.f = function(){…}`
  computes the closure struct, then ends in `extern.convert_any` followed by
  `drop`. The member-set shape-test dispatch chain has **no `__object_set`
  terminal** (and no `__extern_set` arm) for the statically-`$Object`
  receiver — every guarded arm falls through and the converted value is
  discarded. Nothing is ever written, so every aliased (and even same-binding
  dynamic) read later answers null.

So this is a single-sided defect: fix locus is the member-**assignment**
dispatch for `$Object`-typed receivers — either add the missing
`__object_set`/`__extern_set` terminal arm to the chain, or route the write
directly when the receiver is statically known to be `$Object` (mirroring how
the read side already routes through `__extern_get`).

The direct form (`o.f = fn; o.f()`) only works because the read is answered
from a static/devirtualized path that never consults the (never-written)
dynamic store — masking the dropped write.

Diagnosis aside: `__exn_render_prepare`/`__exn_render_char` were absent
from this module even with `hostBridge: "always"` although the emitter ran
and pushed them — the exception-payload path could not be used. Possibly a
separate small defect; worth a look while in here.

## Acceptance

- The repro returns 42 on --target standalone (and gc).
- acorn 8.18 UMD tiny-parse (`acorn.parse("var x = 1;", {ecmaVersion:2020})`)
  returns 1 on standalone.
