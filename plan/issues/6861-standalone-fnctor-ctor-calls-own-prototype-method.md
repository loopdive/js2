---
id: 6861
title: "standalone: a function constructor that calls its own prototype method (`function Hash() { this.clear(); }`) throws when its only `new` sites are object-literal values"
status: done
completed: 2026-10-05
sprint: current
created: 2026-10-05
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/wave9-lodash-6736
related: [6736, 6738, 2660, 4261, 6751]
loc-budget-allow:
  # 2026-10-05 (#6861): +2 lines in analyzeFnctorEscapeGate — one import and the
  # seeded `sawDynamic`. The predicate itself lives in the new
  # analysis/fnctor-ctor-self-dynamic.ts.
  - src/codegen/fnctor-escape-gate.ts
---

# #6861 — fnctor constructor calling its own prototype method

## Problem

lodash 4.18.1, npm-compat **standalone-dynamic** lane, on main `b6324ee6d1`:

```
runtime-error (phase: module-init): TypeError: called value is not a function
```

This is no longer [#6736](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6736-standalone-fnctor-prototype-length-reads-number).
Module init now dies much earlier, at `lodash.js:6830`
(`var stringToPath = memoizeCapped(…)`). Trapping `__new_TypeError` in the
unoptimized binary gives this stack:

`__module_init` → `memoize` → `MapCache` → `this.clear()` → `mapCacheClear` →
`__fnctor_Hash_new` → `this.clear()` → `__extern_method_call` → TypeError.

### Bisect

The probe is a lodash copy that throws `RangeError` right after line 6830.
First-parent bisect over the src-touching commits:

| Commit | Result |
|---|---|
| `bc93377394` (#6301) | passes line 6830 |
| `9506a81421` (#6307, [#6738](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6738-standalone-new-of-logical-or-callee-null)) | TypeError |

#6738 is correct. Before it, `new (memoize.Cache || MapCache)` evaluated to
`null`, so init never built a `MapCache`. Now it does, and that exposes a bug
that already existed.

### Root cause

The #2660 escape gate classifies each `new F()` site by how the instance is used
afterwards. lodash's only `Hash` sites are object-literal values
(`{ 'hash': new Hash, … }`). The use-site ladder rates them neutral, so `Hash`
becomes `keep-static`. A `keep-static` instance is a bespoke struct with no
prototype link (the gate's own #4123 note says so). `Hash`'s constructor calls
`this.clear()`, which is on `Hash.prototype`, so the call finds nothing.

The gate never looks inside the constructor. But a constructor that calls
`this.m()` for an `m` it does not own uses every instance dynamically before any
caller sees it.

Minimal reduction (standalone, 0 imports; Node 3, standalone traps):

```js
function ric() {
  function Hash() { this.clear(); }
  function hashClear() { this.size = 0; }
  Hash.prototype.clear = hashClear;
  function make() { return { h: new Hash }; }
  var d = make(); out += 1; if (d.h.size === 0) out += 2;
}
```

The same program with `var x = new Hash(); x.size` passes, because that bound
read is already dynamic.

## Implementation Plan

1. New module `src/codegen/analysis/fnctor-ctor-self-dynamic.ts`:
   `fnctorCtorCallsInheritedThisMethod(ctorSym, ownFields)` walks the
   constructor body (the declaration forms `collectFnctorOwnFields` accepts).
   - It skips nested ordinary functions, classes, methods and accessors, which
     bind their own `this`.
   - It descends into arrow functions.
   - It answers true on a call `this.m(…)` where `m` is not an own field the
     constructor assigns.
   - Calls only. A plain `this.x` read can name a field that a method assigns
     later, so it is not evidence of prototype dispatch.
2. In `analyzeFnctorEscapeGate`, seed each site's `sawDynamic` from that
   predicate, standalone only (`standalone === true`). The existing ladder then
   applies unchanged:
   - dynamic alone → `reconstruct`;
   - dynamic plus typed → `reconstruct` (#4261);
   - host/WASI keep their classification, so the JS-host emit stays
     byte-identical.
3. Pin: `tests/issue-6861-fnctor-ctor-calls-proto-method.test.ts` has the
   literal-site reduction, lodash's memoize/MapCache/Hash/ListCache stack, and a
   bound-site control that passes on both sides.
4. Measure: lodash standalone-dynamic before and after, plus scoped standalone
   test262 over the fnctor, `new`, `arguments`, `Object.create` and `harness`
   directories.

## Resolution

Implemented as planned. The predicate is
`fnctorCtorCallsInheritedThisMethod` in `src/codegen/analysis/fnctor-ctor-self-dynamic.ts`.
The gate change is two lines in `analyzeFnctorEscapeGate`.

- **Pin.** `tests/issue-6861-fnctor-ctor-calls-proto-method.test.ts`. On the
  parent the two subject cases throw (`WebAssembly.Exception`); the bound-site
  control passes. With the fix all three pass, answering 3, 15 and 3, which are
  Node's answers.
- **lodash, unoptimized standalone binary, 0 imports.** The parent throws
  `TypeError: called value is not a function` in module init at
  `lodash.js:6830`. With this change plus the
  [#6736](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6736-standalone-fnctor-prototype-length-reads-number)
  re-land, module init completes. With this change alone, init still throws
  `called value is not a function`. The throw was not traced to a line;
  #6736's `isArrayLike(LazyWrapper.prototype)` is the expected site. The next link is the
  checksum,
  [#6751](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6751-standalone-lodash-checksum-called-value-not-function),
  whose root cause is now recorded in that issue: the UMD export goes through an
  alias of `module`.
- **Scoped standalone test262.** Same 2503 rows as #6736: 2146 / 292 / 65 on
  both sides, zero flips.
- **JS-host.** The new arm needs `standalone === true`. Binaries are
  byte-identical (see #6736).
- **Nearby unit tests.** These fail identically on the parent:
  - `issue-1053`, 1 test;
  - `issue-2660-s2`, the "no `new`" case;
  - `issue-4506`, two stale `it.fails` residuals that already pass on main;
  - `issue-5093`, the host-only boolean/null carrier.
