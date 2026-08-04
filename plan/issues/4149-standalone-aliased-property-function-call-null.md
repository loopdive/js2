---
id: 4149
title: "standalone: property-function stored through one alias returns null when called through another"
status: in-review
sprint: Backlog
priority: high
goal: standalone-gap
feasibility: medium
horizon: m
created: 2026-08-04
requested_by: ttraenkler/claude-bench
related: [4088, 4144, 4145]
# The fix is two narrow arms in existing dispatch chains, both of which have to
# live where the decision is already made: the empty-object shape decision is in
# resolveWasmType, and the "resolved struct lacks this field" decision is the
# tail of compilePropertyAssignment. Moving either to a new module would leave a
# call at the same site plus an indirection, not less code in the god-file.
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/expressions/assignment.ts
func-budget-allow:
  - src/codegen/index.ts::resolveWasmType
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
trap-growth-allow:
  count: 2
  reason: "#3596 reclassification, fail -> fail, flavour only — neither test has ever passed. Landing undeclared-field writes (`set #m(v) { this._v = v; }`, where `_v` has no declaration) lets both brand-check tests run PAST their first assert, which previously failed as `Test262Error: Expected SameValue(<undefined>, <\"test262\">)` because the write was dropped outright. They now reach a PRE-EXISTING latent uncatchable `illegal cast` on foreign-receiver private access (section 7.3.28 PrivateBrandCheck should throw a catchable TypeError) — filed as #4154, which should make both files PASS and retire this declaration. Baseline status is `fail` in every arm, so this is the #3596 baseline-did-testify branch, not the #3595 never-instantiated class. Reproduced by local A/B on the single file `src/codegen/expressions/assignment.ts` via the real runner (runTest262File): upstream/main `Test262Error`, branch `illegal cast`, branch-with-that-one-file-reverted `Test262Error`. PR net +217 pass (31581 -> 31798), host stable-path fine-gate net +272 (279 improvements - 7 regressions); other trap categories flat or down (null_deref 1639 -> 1635, oob 52 -> 52, unreachable 3 -> 3)."
  tests:
    - test/language/statements/class/elements/private-setter-brand-check.js
    - test/language/statements/class/elements/static-private-setter-access-on-inner-class.js
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

## Root cause + fix (2026-08-04)

The WAT diagnosis above was one layer down from the real defect; three
distinct holes stacked:

1. **Bindings typed `{}` were pinned to a zero-field closed struct**
   (`__anon_N`) while the runtime value is a native `$Object`
   (`__new_plain_object`) — so the guarded cast at every binding boundary
   (`ref.test $__anon_N` → else `ref.null`) silently NULLED the alias. Both
   `e` and `a` were null; the write went nowhere, the read read nothing.
   Fixed in `resolveWasmType` (src/codegen/index.ts): an object type with
   zero properties, zero call signatures and zero construct signatures
   resolves to `externref`, all lanes — the same fact the field-level
   widening in `ensureStructForType` and the pure-index-signature guard
   already encode. No name gate: named classes/interfaces return through the
   structMap branch earlier; a `{}` type reached via a variable carries that
   variable's symbol name.
2. **`compilePropertyAssignment`'s generic struct path returned null when the
   resolved struct lacked the field** (`fieldIdx === -1`) — the caller's
   fallback evaluated the RHS and dropped it (the `extern.convert_any; drop`
   in the WAT). Now routes through `compilePropertyAssignmentExternSet`, the
   same dynamic terminal the unresolved-shape branch uses.
3. **gc/host lane: a closure stored via `__extern_set_strict` during the
   module's `start`** (module_init runs inside `WebAssembly.instantiate`,
   before `setInstance` wires callbackState) **was stored RAW** —
   `_maybeWrapCallableUnknownArity` had no exports to consult. Fixed in the
   host `__extern_method_call` (src/runtime.ts): wrap a raw wasm-closure
   property value lazily at call time, when exports ARE reachable.

Validated: 17 repro variants (alias / iife / capture / UMD-wrapper shapes ×
both lanes) all return 42; acorn 8.18 UMD in-factory probes (`getOptions`,
`wordsRegexp`, `new Parser`, `nextToken`, `parse`) all work on standalone;
`tiny()` (UMD tiny-parse) returns 1 on standalone. Equivalence A/B sweep:
failure lists byte-identical to clean branch HEAD (5 pre-existing failures
in 3 files, reproduced with and without the fix).

Still open beyond this issue: the full 233 KB self-parse `bench()` on the
UMD build throws further down the chain (next defect in the #4145 chain);
gc-lane UMD still fails compile at `__fnctor_Parser_new` (the known #4139
gc half — no `__constructor_identity` param on gc twins).

## Acceptance

- The repro returns 42 on --target standalone (and gc). ✅
- acorn 8.18 UMD tiny-parse (`acorn.parse("var x = 1;", {ecmaVersion:2020})`)
  returns 1 on standalone. ✅
