---
id: 6839
title: "standalone: Wasm-native Intl.ListFormat (en data) instead of env.Intl_ListFormat_* host imports (prettier)"
status: done
sprint: current
created: 2026-10-05
updated: 2026-10-05
completed: 2026-10-05
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: intl
goal: standalone
requested_by: ttraenkler/wave9-prettier-intl
related: [6731, 6717, 5355, 5381, 6442, 2961, 3146, 6849, 6850]
# 2026-10-05: +6 lines in compiler.ts — one call per compile entry point
# (single-source + multi-file) plus the import and position-map compose step;
# all logic lives in src/intl-listformat-prelude.ts.
loc-budget-allow:
  - src/compiler.ts
---

# #6839 — standalone `Intl.ListFormat` leaks `env.Intl_ListFormat_*`

## What you will see

Measured 2026-10-05 on upstream/main `b6324ee6d1`:

```
npx tsx scripts/generate-npm-compat-report.mjs --only prettier --no-write --perf-only --lane standalone-dynamic
standaloneDynamic: compile-error — Host import leak (warning, #2961): host import
"env.Intl_ListFormat_format" survives into the finished --target standalone binary
```

The full leak list of the same compile (unoptimized probe, all warnings):
`env.Intl_ListFormat_format`, `env.Intl_ListFormat_new`,
`env.Navigator_get_platform`. `env.Promise_all` (listed in #6731's notes) no
longer leaks on this base.

## Root cause

`Intl.ListFormat` is registered unconditionally as an extern class
(`src/codegen/extern-declarations.ts`, pre-#2961), so `new Intl.ListFormat(..)`
and `.format(..)` lower to `env.Intl_ListFormat_new` / `_format` on every
target. Prettier reaches it from its doc-printer error path:

```js
var ho = e => new Intl.ListFormat("en-US", { type: "disjunction" }).format(e);
```

(only built when an invalid doc is printed, so the sample op never runs it —
but its mere presence makes the module uninstantiable host-free).

## Implementation Plan

Wasm-native, not a throw: the en list patterns are four separators per
(type, style), so carrying them is proportionate (unlike DateTimeFormat's
calendar/tzdata, #5355).

1. New `src/intl-listformat-prelude.ts`, modelled on the #3146
   `iterator-statics-prelude.ts`: a source prelude (plain JS that also
   type-checks as TS) defining `class __js2wasm_Intl_ListFormat`, injected only
   when a file references `Intl.ListFormat` with the GLOBAL `Intl` (top-level
   `Intl` declaration ⇒ no rewrite), and every such `Intl.ListFormat` access is
   rewritten to the prelude binding, with a `PositionMap` edit list and
   compiler-origin spans (new producer `intl-listformat-prelude`).
2. Semantics (ECMA-402 §13): `CanonicalizeLocaleList` (string / array-like,
   structural BCP 47 validation → `RangeError`, case canonicalisation, dedupe),
   `GetOptionsObject` (non-object → `TypeError`), option read order
   `localeMatcher` → `type` → `style` with `RangeError` on out-of-range values,
   `LookupMatcher` over available locales `en`, `en-US` (default `en-US`),
   `StringListFromIterable` via `for…of` (non-string → `TypeError`, iterator
   closed), `format` / `formatToParts` / `resolvedOptions` /
   `supportedLocalesOf`, brand checks (`TypeError`).
3. Locale data: CLDR `en` listPatterns only, measured against Node's ICU —
   conjunction long `and`/short `&`/narrow `,`; disjunction `or` for all
   styles; unit `, ` (long/short) and ` ` (narrow). Every other locale resolves
   to the `en-US` default per `ResolveLocale` (documented, not an error).
4. Wire it in `compileSourceSync` (after the Iterator-statics prelude) and per
   file in `compileMultiSource`, both gated on `environment === "none" | "wasi"`;
   gate the `ListFormat` extern-class registration off standalone/WASI so no
   residual spelling can register `Intl_ListFormat_*` imports. JS-host lane is
   untouched (byte-identical).
5. Regression test (fails on parent: leaked imports; passes: zero imports and
   en outputs equal Node's for 9 type×style combos), anti-vacuity control
   (host lane still uses the host import), scoped standalone test262 over
   `intl402/ListFormat`, prettier before/after.

Out of scope (documented): non-en locale data (`es-ES` tests stay failing),
locale alias canonicalisation, `Intl.ListFormat` reached through a non-`Intl.`
spelling (`globalThis.Intl.ListFormat`, destructuring) — the `Intl` namespace
itself is still absent in standalone (#5206/#6717).

## Resolution

Implemented as planned, with two deviations measured during implementation:

- `StringListFromIterable` uses the #3146 `__j2w_iter_*` native-iterator
  intrinsics instead of `for…of` (same GetIterator ladder, explicit
  IteratorClose with the TypeError winning over a throwing `return`). A TS
  unit gets ambient `declare function` signatures for them; a JS unit cannot
  carry `declare` and does not need it.
- The helpers coerce every input with a template literal and compare
  `| 0`-typed numbers, return `""` (never a `string | undefined` mix) and use
  number-valued predicates, because an untyped parameter widened to `any`
  miscompiles `.length`-bounded loops in standalone — filed as
  [#6850](./6850-standalone-any-param-length-loop-miscompile.md).
- Class fields carry string initialisers so a TS unit types them as `string`
  (an untyped field read inside a template-concatenation loop raised
  `illegal cast`).

Measurements (2026-10-05, `b6324ee6d1`):

| | before | after |
| --- | --- | --- |
| prettier standalone-dynamic | compile-error: `env.Intl_ListFormat_format` leak (also `_new`, `Navigator_get_platform`) | compile-error: `env.Navigator_get_platform` leak (next blocker, [#6849](./6849-prettier-standalone-navigator-leak-closure-validation.md)) |
| `intl402/ListFormat` standalone (81) | 2 pass / 28 fail / 51 CE | 47 pass / 32 fail / 2 CE |
| JS-host bytes (single gc, gc native-first, multi `.mjs` fixture) | — | sha256 identical |

`env.Promise_all` no longer leaks on this base (nothing to fix).

Remaining `intl402/ListFormat` non-passes, by cause: the harness's
`Intl.NumberFormat` host-import leak (2 CE, `locales-invalid`); no `Intl`
namespace object / property descriptors / `name` / `length` / `toStringTag` in
standalone (#5206/#6717, ~10); `es-ES` data not carried (6, by design);
`locales-valid` expects `de` to be available (1); function-constructor custom
iterables (`CustomIterator.prototype[Symbol.iterator]`) are "not iterable" in
the standalone iterator runtime — plain `for…of` fails the same way (10);
`.call` on an extracted prelude method traps in the method trampoline (3,
`branding`); `new X(...[])` passes `null` for a missing argument
(`options-undefined`); object-literal `[[Prototype]]` (`resolvedOptions/type`);
`supportedLocalesOf.length` is 2 (fixed params; a rest parameter broke
`.call(thisValue)` in `branding`); the quickjs-provider rows are environment.
