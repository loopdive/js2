---
id: 6986
title: "Intl on the native regime: host `Intl_*` imports are emitted and fail at run time — needs a native stand-in or an explicit `intl` accelerator route before S7-b"
status: in-progress
created: 2026-10-14
updated: 2026-10-15
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
