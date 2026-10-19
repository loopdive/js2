---
id: 6986
title: "Intl on the native regime: host `Intl_*` imports are emitted and fail at run time — needs a native stand-in or an explicit `intl` accelerator route before S7-b"
status: done
created: 2026-10-14
updated: 2026-10-15
completed: 2026-10-15
assignee: "ttraenkler/opus-6986-intl"
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler, runtime
language_feature: Intl
goal: architecture
sprint: current
parent: 5385
related: [6978, 6708, 6979, 6809]
loc-budget-allow:
  # 2026-10-15 (#6986): one routing call each — the locale-method/static-call
  # arm in compileCallExpression, the `Intl` value arm in compileIdentifierCore,
  # the no-host-Intl check in both module drivers, the accelerator boundary prep
  # in collectDeclarations. The logic lives in src/codegen/helpers/host-intl-*.ts.
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/index.ts
  - src/codegen/declarations.ts
func-budget-allow:
  # 2026-10-15 (#6986): the same single routing calls, inside these functions.
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
import-cycles-allow:
  - largestSccSize: 709 # 2026-10-15 (#6986, measured on the merge preview with main's #6982 helpers): src/codegen/helpers/host-intl-locale.ts compiles call operands through shared.js compileExpression and prepares the object runtime, so it joins the codegen SCC like the #6978 accelerator helpers
---

# #6986 — Intl is a regime gap, not an opt-in

Measured by the #6978 implementer (2026-10-14, upstream main `dd15b6d00c`):
under `semanticProviders: "native-first"` in a JavaScript environment, and
under `target: "standalone"` as well, every `Intl.*` use still emits the host
`Intl_*` imports, and the call fails at run time with
`Cannot convert object to primitive value`. Converting the string arguments
is not enough: options objects created in Wasm reach the host unconverted.
So today Intl on the regime is neither a native stand-in nor a compile
error — it is a silent run-time failure.

Consequences:

- #6978 deliberately did **not** gate the `Intl_*` imports behind the `intl`
  accelerator: after the #6708 default flip that would turn every program
  using `Intl` into a compile error on the default lane. Selecting
  `--host-accelerator intl` is refused ("not available yet").
- S7-b (#6979) deletes the `legacy-semantic` emitters. `Intl_*` must be
  reclassified before that — either as `host-accelerator` behind `intl`
  (JS environment) or as a `platform-capability` with a declared-global
  contract — or every `Intl` program breaks on S7-b.
- The stakeholder constraint (2026-09-07) keeps host Intl available as an
  opt-in; it does not promise a native Intl. The #6809 locale kernel
  (merged 2026-10-12, PR 6436) is the only native piece today.

## Plan

1. Inventory: list the `Intl_*` import names the regime emits
   (`src/codegen/extern-declarations.ts`, `to-locale-string-element.ts`,
   `array-tolocalestring.ts`, `call-namespace-static.ts`, `new-super.ts`)
   with the argument shapes each passes; record which carry Wasm-created
   objects (options bags) across the boundary.
2. Route, JS environment: when `accelerators` contains `intl`, marshal every
   argument through the value adapter (`src/runtime/platform-arg-marshal.ts`
   from #6708 already converts carrier arguments of `extern_class` imports;
   extend it to options objects via the boundary object hooks) and classify
   the imports `host-accelerator` (family `intl`). Lift the "not available
   yet" refusal in `src/target-profile.ts` once a focused test proves
   `new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" })
   .format(1234.5)` and `toLocaleString` round-trip under the regime.
3. Route, no accelerator: decide and implement ONE of (a) a native stand-in
   limited to the #6809 locale kernel plus `en-US` number/date formatting
   with a documented "unsupported locale/option" TypeError, or (b) a
   compile-time error naming `--host-accelerator intl` when `Intl` is used
   without it on a native-regime build. (b) is the honest minimum and is
   what standalone/WASI get in any case; (a) is a follow-on if the
   stakeholder wants `Intl` without a JS host.
4. Acceptance: `check:host-import-policy` default probe stays at 0
   legacy/unknown and the `intl` probe shows the imports only when selected;
   no `Intl_*` import is classified `legacy-semantic` any more; the test262
   `intl402` rows that pass on the host-assisted lane today are measured
   under the regime with `intl` selected and the count recorded here;
   S7-b's keep-list names the `intl` family.

## Inventory (2026-10-15, upstream main `5109a8a019`, before this change)

"Wasm-created objects" = values the module builds and hands to the host:
native strings, boxed numbers, object literals (options bags), arrays,
compiled `Date` carriers.

| Import(s) | Emitted by | Arguments after `self` | Wasm-created objects crossing | host-assisted | regime (native-first, JS) | standalone / WASI |
| --- | --- | --- | --- | --- | --- | --- |
| `Intl_NumberFormat_new`, `_format`, `_formatToParts`, `_resolvedOptions` | `extern-declarations.ts` (unconditional) | `new(locales?, options?)`; `format(n)` | locale string/array, options bag, boxed number | works | emitted; `format` answers **null** | emitted with a #2961 leak warning; unsatisfiable |
| `Intl_ListFormat_new`, `_format`, `_formatToParts`, `_resolvedOptions` | `extern-declarations.ts` (JS environment only) | `new(locales?, options?)`; `format(list)` | options bag, string array | works | emitted; `format` answers **null** | not emitted: #6839 prelude |
| `Intl_DateTimeFormat_*` (5 methods) | `extern-declarations.ts` (`!standalone && !wasi && !nativeStrings`) | `new(locales?, options?)`; `format(date?)` | options bag, compiled `Date` | works | not emitted; `new-intl-host-bridge.ts` throws a run-time TypeError that says "standalone/wasi" | same run-time TypeError |
| Collator, PluralRules, RelativeTimeFormat, DisplayNames, Segmenter, Locale | nothing (no extern class) | — | — | "Unsupported new expression" warning → **null** | same | same |
| `Intl` as a value (`Intl.getCanonicalLocales`, `Intl.X.supportedLocalesOf`) | `identifiers.ts` (`__get_globalThis` + `__extern_get`, host lane only) | — | locale arrays | works | **null** → "Cannot access property on null" | same |
| `toLocaleString`, `localeCompare`, `toLocaleUpperCase`, `__extern_toLocaleString` (string_method / builtin) | `to-locale-string-element.ts`, `array-tolocalestring.ts`, `builtins.ts` date modes 6–8 | `(locales?, options?)` | receiver, options bag | host methods | native, locale-free lowering (no Intl import) | same |

`call-namespace-static.ts` (the `Reflect.construct(Intl.DateTimeFormat, …)`
padding note) and `new-super.ts` (the `tryCompileIntlHostOnlyNew` arm) emit no
`Intl_*` import of their own. No `Intl_*` import was ever `legacy-semantic`:
the extern classes classify `platform-capability` (`extern:<Class>`).

## Implementation notes (why, not just what)

- **One predicate decides, `hostIntlAvailable(profile)`** (`src/target-profile.ts`):
  host-assisted lane or the `intl` accelerator ⇒ a host Intl; every other
  WasmGC build ⇒ none; the linear backend keeps its behaviour. The extern-class
  registration (`src/codegen/helpers/host-intl-classes.ts`), the ListFormat
  prelude gate and the compile-time check all read it, so they cannot drift.
- **No accelerator: option (b), a compile error.** The first reference to the
  global `Intl` in a file is reported, with a message per environment (JS
  regime: names `--host-accelerator intl`; standalone/WASI: names the missing
  ICU data and the accelerator; strict: names `strictNoHostImports`). Only value
  references count: type positions (`Intl.NumberFormatOptions`), member names
  and local bindings called `Intl` (the Temporal provider's shim, user code)
  pass — binding identity comes from `ctx.oracle.declarationsOf`. The one native
  stand-in, the `Intl.ListFormat` prelude (#6839), now also serves the
  JS-environment regime: it rewrites those accesses before codegen, so no global
  `Intl` reference is left for the check. The #6809 locale kernel is not lowered
  anywhere yet, so it serves no call.
- **The accelerator marshals at the import, not in codegen.** Codegen emits the
  same extern-class imports as the host lane; `src/runtime/intl-host-accelerator.ts`
  wraps each `Intl.*` import (selected by `isIntlAcceleratedImport`) so every
  argument goes through the boundary's `toHost` (a compiled `Date` first, as its
  #5208 host Date view — the struct facade read as `Invalid time value`) and the
  result through `fromHost`; a host ARRAY result is copied into the object
  runtime's exported native vector (`_nativeBoundaryVector`), because an admitted
  host array is not readable by the typed `.length`/index lowering. This needs
  the carrier exports (`__unbox_number`, `__box_number`, …, `__objvec_new`), which
  `prepareIntlAcceleratorBoundary` ensures once per file that calls into Intl.
  The #6708 `platform-arg-marshal.ts` pattern (still only on the flip branch) was
  not copied: it converts primitives only, and the Intl calls need options bags,
  Dates and array results too.
- **Locale-sensitive builtin methods route under the accelerator.**
  `(1234.5).toLocaleString("de-DE")`, `date.toLocale{,Date,Time}String(...)`,
  `bigint.toLocaleString(...)`, `str.localeCompare(...)` with a statically typed
  receiver compile to `__intl_<method>(receiver, a, b, c)`; `Intl.getCanonicalLocales`,
  `Intl.supportedValuesOf` and `Intl.<Class>.supportedLocalesOf` to
  `__intl_static_*`. The source writing that method onto a prototype keeps the
  native path (the call must reach the user's override). The global `Intl` read
  as a value is `env.global_Intl` (declared-global intent), admitted at the
  boundary so member reads use the boundary object MOP.
- **Policy.** `__intl_*` builtins and `global_Intl` join the `intl` family in
  `acceleratorFamilyOfEnvImport`; selected, every Intl import classifies
  `host-accelerator`/`intl`. The `intl` accelerator no longer refuses selection.

## Measurements (2026-10-15)

- **Focused surfaces, regime + `intl`, compared with Node 22 in-process**
  (`tests/issue-6986-intl-regime.test.ts`, 17/17): NumberFormat with a currency
  options bag, `Number#toLocaleString(locale)`, `Date#toLocaleDateString(locale,
  { timeZone })`, `Collator#compare`, `String#localeCompare(that, locale)`,
  `BigInt#toLocaleString`, `DateTimeFormat#format(compiled Date)`, ListFormat,
  PluralRules, RelativeTimeFormat, `formatToParts` + `resolvedOptions`,
  `Intl.getCanonicalLocales`, `Intl.NumberFormat.supportedLocalesOf` — all equal.
- **test262, CI rows the compile error can affect: 0.** `intl402` (3,357 files)
  is not part of either 48,735-row CI run (`test262-current.jsonl` and
  `test262-standalone-current.jsonl`, fetched 2026-10-15: 0 `intl402` rows).
  Outside `intl402`, 1 row references the global `Intl`; it fails in both
  baselines. The `toLocale*`/`localeCompare` path rows (standalone 179 pass /
  26 fail, host 136 / 69) do not emit `Intl_*` imports and are unchanged: without
  the accelerator their native lowering is untouched.
- **`intl402` under the regime, approximate** (`.tmp` probe, NOT the official
  runner: harness prefix + body compiled as one JS unit, negative/async/module/raw
  and prototype-tainting rows skipped; deterministic stride sample of 300 → 297
  run): host-assisted 38 pass; regime + `intl` 11 pass (7 of those 38 plus 4 the
  host lane fails); regime without `intl` 7 pass and 108 compile errors naming
  the accelerator; standalone 108 such compile errors. The host-passing rows the
  accelerator does not reach are reflective: property descriptors
  (`prop-desc`), branding / `this`-value checks, `toStringTag`, `Intl.Locale`
  and `Intl.Segmenter` (not registered), `toLocaleLowerCase(locale)` (not
  routed) — i.e. the host `Intl` object model, not its formatting. 20 Temporal
  rows are compile errors in both regime lanes for an unrelated reason (no
  Temporal provider in the probe).
- **`check:host-import-policy`:** default native-first probes 33, imports 446,
  legacy-semantic 0, unknown 0; compatibility control 23 legacy imports;
  accelerator probes `regexp` 4, `date` 1, `intl` 4 (`Intl_NumberFormat_new`,
  `_format`, `__intl_toLocaleString`, `__intl_static_getCanonicalLocales`) —
  without selection the `intl` probe is the compile error, so none appear.
  `runtimeTsLines` 20219 (ceiling 20225, unchanged).
- **Equivalence gate:** 22 failing, 1748 passing, all 22 known; "No new
  equivalence regressions". The suite has no `Intl`/`toLocale*` rows at all, so
  nothing there depends on host Intl under the default profile.
- **npm-compat packages:** only prettier references `Intl` (16 ×
  `Intl.ListFormat`), served by the prelude on every lane without a host Intl.

## Left out (follow-ups)

- Reflective use of the host `Intl` under the accelerator (descriptors,
  prototypes, `instanceof`, `Intl.X` passed around as a value and then
  constructed) goes through the generic boundary MOP and is not exercised.
- `Intl.Locale`, `Intl.Segmenter` (iterables), `Intl.DurationFormat` are not
  registered; `toLocaleUpperCase`/`toLocaleLowerCase(locale)` and
  `Array#toLocaleString(locales)` are not routed.
- A pre-existing native gap, not an Intl import: on the regime without the
  accelerator `(1234.5).toLocaleString("de-DE")` answers null (the no-argument
  form answers `"1234.5"`). Belongs to the native Number provider.
- After #6708 flips the default to native-first, every program that uses
  `Intl` without `--host-accelerator intl` becomes this compile error; the
  equivalence suite has no such rows, the npm-compat set none beyond prettier's
  prelude-served ListFormat.
