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
func-budget-allow:
  # 2026-10-14 (#6978): one routing call each into the date accelerator helper.
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
import-cycles-allow:
  - largestSccSize: 705 # 2026-10-14 (#6978): src/codegen/helpers/host-date-parse.ts joins the codegen SCC (compiles the Date.parse argument through shared.js compileExpression, like every call-site helper)
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

## Measurements

(filled in as the slices land)

## Acceptance

- [ ] Option/profile/CLI plumbing with the four error cases tested.
- [ ] Profile-aware classification; per-family policy probes.
- [ ] `regexp` and `date`: host provider only when selected (module imports),
      native otherwise, standalone/wasi selection errors, identical output for
      a small program under both spellings.
- [ ] `js-string`: implemented, or the conflict error names the planned path
      and the findings are recorded below.
- [ ] `intl`: classified; current regime behaviour measured and recorded.
