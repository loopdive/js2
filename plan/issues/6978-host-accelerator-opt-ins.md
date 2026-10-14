---
id: 6978
title: "S6-B: per-family opt-in host accelerators (js-string, regexp, date, intl) for the native semantic regime"
status: in-progress
sprint: current
created: 2026-10-14
updated: 2026-10-14
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: feature
area: compiler, cli, runtime
language_feature: compiler-internals
goal: architecture
parent: 6708
related: [5385, 4396, 4397, 4401, 679, 682]
assignee: "ttraenkler/opus-6978-b"
loc-budget-allow:
  # 2026-10-14 (#6978): option/profile plumbing (one field or one forwarding
  # line each) and the accelerator routing lines; the logic lives in
  # src/target-profile.ts, src/host-import-policy.ts and
  # src/codegen/helpers/host-date-parse.ts.
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/context/types.ts
  - src/runtime.ts
  - src/compiler.ts
  - src/index.ts
  - src/package-linker.ts
  # 2026-10-14 (#6978): regexp accelerator hooks — one wrapper return in
  # native-regex.ts, one register call per RegExp construction site; the
  # engine wrapper lives in src/codegen/helpers/host-regexp-search.ts.
  - src/codegen/native-regex.ts
  - src/codegen/regexp-standalone.ts
func-budget-allow:
  # 2026-10-14 (#6978): one routing call each into the date accelerator helper.
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
  # 2026-10-14 (#6978): regexp accelerator — import registration, one register
  # call in the dynamic compiler, and the host engine import resolution.
  - src/codegen/declarations/import-collector.ts::finalizeUnifiedCollector
  - src/codegen/regexp-standalone.ts::ensureDynamicStandaloneRegExpCompiler
  - src/runtime.ts::resolveImport
import-cycles-allow:
  - largestSccSize: 706 # 2026-10-14 (#6978): src/codegen/helpers/host-date-parse.ts (compiles the Date.parse argument through shared.js compileExpression) and src/codegen/helpers/host-regexp-search.ts (native-strings bridge + registry, called from native-regex.ts / regexp-standalone.ts) join the codegen SCC like every call-site helper
---

# #6978 — S6-B: per-family opt-in host accelerators

Slice B of [#6708](6708-s6-flip-default-policy-to-native-first.md) (parent
plan: #5385 "Implementation Plan v2", S6). Slice A (`opus-6708-a`) flips the
default `semanticProviders` to `native-first` and adds the `host-assisted`
rollback spelling; this slice adds the named opt-ins that keep selected host
implementations available once native-first is the default.

## Problem

Stakeholder constraint (2026-09-07): `wasm:js-string` strings, host RegExp,
Date and Intl stay available as named opt-ins when a JS runtime is present;
everything else host-semantic retires in S7. Today the only way to get any
host semantic family is the whole host-assisted profile. There is no
per-family switch, no policy class for "selected on purpose", and no error
when an accelerator is requested where it cannot apply.

## Plan

1. Option and profile: `hostAccelerators?: readonly ("js-string" | "regexp" |
   "date" | "intl")[]` on `CompileOptions` / `TargetProfileInput`; the
   resolved list on `CompileTargetProfile`; CLI `--host-accelerator <name>`
   (repeatable). Unknown names, a non-JavaScript environment, a strict
   no-host-imports build, or a host-assisted policy are compile errors.
2. Policy: `src/host-import-policy.ts` classification becomes profile-aware
   for the four families (selected ⇒ `host-accelerator`, family named in the
   reason; unselected ⇒ today's class). `check:host-import-policy` gains one
   probe per family.
3. `regexp` and `date` end-to-end; `js-string` one time-boxed investigation;
   `intl` classification plus a measurement of what the regime does today.
4. Docs: `docs/cli.md`, `docs/architecture/codegen-axes.md`.

## Implementation notes (why, not just what)

- **Profile field is a sorted array, absent when empty — not a `ReadonlySet`.**
  The profile is embedded in the JavaScript adapter manifest, which is
  `frozenClone`d and `JSON.stringify`d into the generated imports helper; a
  `Set` would serialize as `{}`. Omitting the key when nothing is selected
  keeps every default profile, manifest and helper byte-identical (and keeps
  the existing `toEqual` profile pins in #4396 untouched). Query it with
  `hasHostAccelerator(profile, family)`.
- **Validation lives in `resolveCompileTargetProfile`**, after the existing
  selection logic, reading only its result (`semanticProviders`,
  `environment`, `capabilityPolicy`). Slice A changes the default selection;
  this slice adds no edits to that logic, so `{ hostAccelerators: [...] }`
  alone is an error before A lands (host-assisted default) and valid after it.
- **regexp swaps the engine, not the object model.** Measured first: making
  `selectNativeRegExpEngine` return `null` under the regime (the plan's
  premise) does NOT select a host RegExp path — the regime's RegExp arms
  refuse ("standalone RegExp engine does not support RegExp without an enabled
  standalone engine", "String.prototype.replace(...) with a RegExp ... not
  supported in --target standalone"). The legacy host RegExp arms also cannot
  run on native strings: host-assisted + `nativeStrings: true` already fails
  at run time (`Invalid flags supplied to RegExp constructor '[object Object]'`).
  Every regime RegExp surface reaches matching through ONE function,
  `__regex_search` (10 call sites, all via `ensureRegexSearch`), so the
  accelerator wraps that function (`src/codegen/helpers/host-regexp-search.ts`):
  each `$NativeRegExp` construction registers its program array with the host
  (static literal, the simple and full dynamic compilers; clones copy the
  program array and so stay registered), and the wrapper asks the host to
  match. An unregistered program (e.g. the poisoned out-of-subset placeholder)
  runs on the native VM, so a missed registration costs speed, never
  semantics. Host side: `src/runtime/regexp-host-accelerator.ts` (per-instance
  WeakMap keyed by program-array identity; one-entry subject cache keyed by
  the string data array + offset + length, so a global replace / matchAll loop
  marshals its subject once; captures via the `d` flag's `indices`).
- **The engine imports are registered up front** by the import collector when
  the source contains a RegExp literal or the `RegExp` identifier, exactly
  like `__date_parse_host` (#2678): registering them lazily inside
  `ensureRegexSearch` would shift function indices that callers such as
  `emitRegexSearchCall` already hold (the #2043 late-import class). Without
  the up-front imports nothing is wrapped.
- **date is the parser only.** Measured: under host-assisted, Date formatting
  (`__date_format`) renders UTC exactly like the native formatter, and the
  `date_new`/`date_method` intents are never emitted by codegen. The one real
  host-vs-native delta is parsing: `Date.parse("Thu, 01 Jan 1970 00:00:00
  GMT-0500")` is `18000000` on the host and `0` in the native parser. So
  `date` routes string-typed `Date.parse(x)` / `new Date(x)` through
  `__date_parse_host`, marshalling the native string with the existing string
  bridge; non-string arguments keep the native path.
- **js-string and intl refuse selection** (`not available yet`) instead of
  compiling as a no-op; the policy already classifies both families.

## Measurements

- `pnpm run check:host-import-policy` (2026-10-14, this branch): default
  native-first probes 33, imports 446, legacy-semantic 0, unknown 0;
  compatibility control 23 legacy imports (non-vacuity holds); new accelerator
  probes: `regexp` 4 host-accelerator imports (`__regexp_host_register`,
  `_exec`, `_subject`, `_capture`), `date` 1 (`__date_parse_host`); none of
  them appear without selection; `js-string`/`intl` selection refused.
- `runtimeTsLines` ceiling in `plan/audit/host-import-policy-baseline.json`
  raised 20222 → 20225: runtime.ts grows by 4 lines over its 20221-line base
  (one import, the binder's accelerator list field, its forwarding from the
  target profile, and the one-line `__regexp_host_*` dispatch). The engine
  state machine lives in `src/runtime/regexp-host-accelerator.ts`.
- regexp spy run (13 constructions, 39 searches over 8 surfaces: exec loop,
  named groups, replace with `$1` and a callback, m/s/y flags, split, search,
  matchAll, match, dynamic `new RegExp`): every search answered by the host
  (no `-1` fallback), 13 subject hand-overs, output identical to the native
  regime and to the host-assisted lane.

### js-string (time-boxed investigation, follow-up)

Removing the `native-first` + `nativeStrings: false` conflict and compiling
three small programs (string methods; object keys + array map/reduce; sort,
join, JSON, number formatting, template literal) fails all three at compile
time:

- `ir/integration: prepared string.len has no exact wasm:js-string.length import`
  (the IR's string ops are prepared for the native string struct);
- `stdlib-selfhost: __str_trimStart needs string.len but the compilation is
  not in native-strings mode` and the same for `__sh_num_toString_radix`
  (the self-hosted string/number stdlib lowers only in native-strings mode).

Scale of the assumption (2026-10-14): 1,654 `ctx.standalone` regime arms in
`src/codegen` + `src/ir`, 853 of them in the 223 files that address the native
string types (1,374 references to `anyStrTypeIdx`/`nativeStrTypeIdx`), plus
492 `ctx.nativeStrings` reads in 143 files. Not a bounded change, so the error
stays; its message now names the planned `js-string` accelerator.

### intl (measured, follow-up)

`new Intl.NumberFormat("en-US").format(1234.5)` today:

| profile                    | imports                                        | result                                            |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| host-assisted (default)    | `Intl_NumberFormat_new` / `_format` (extern class) | `"1,234.5"`                                    |
| native-first regime        | the same two imports, classified `platform-capability` | run-time `Cannot convert object to primitive value` |
| `--target standalone`      | the same two imports                           | (not run: `env` imports in a host-free target) |

So under the regime Intl is neither a native stand-in nor a compile error: it
emits the host extern-class imports and fails at run time because native
strings and Wasm-owned option objects reach the host unmarshalled (wrapping
the import's arguments with the primitive converter fixes the locale string
but not the options object). Gating emission behind the accelerator would turn
every such program into a compile error on the default lane once #6708 slice A
flips, so emission is unchanged here. Follow-up: marshal Intl arguments and
results through the JS value boundary, then gate emission on `intl`.

### Other findings

- A pre-existing regime defect, unrelated to accelerators: reading
  `m.groups!.year` inside a `while ((m = re.exec(s)) !== null)` loop traps
  with `dereferencing a null pointer` under native-first with or without the
  `regexp` accelerator (host-assisted is fine).

## Acceptance

- [x] Option/profile/CLI plumbing with the four error cases tested.
- [x] Profile-aware classification; per-family policy probes.
- [x] `regexp` and `date`: host provider only when selected (module imports),
      native otherwise, standalone/wasi selection errors, identical output for
      a small program under both spellings.
- [x] `js-string`: the conflict error names the planned path; findings above.
- [x] `intl`: classified; current regime behaviour measured and recorded.
