---
id: 6708
title: "S6: `semanticProviders` defaults to native-first in every environment; host semantics only as named opt-in accelerators"
status: ready
created: 2026-09-27
updated: 2026-09-27
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: refactor
area: compiler, cli, ci, docs
language_feature: compiler-internals
goal: architecture
sprint: current
parent: 5385
depends_on: [6706, 6707]
related: [679, 682, 1535, 4396, 4397, 4401, 6191]
---

# #6708 — S6: flip the default policy to native-first

Slice S6 of the #5385 "Implementation Plan v2". After S5 (#6191) a build
that *selects* `native-first` already lowers with the native regime plus the
JS value bridge. S6 makes that the default and turns the remaining host
semantics into named, opt-in accelerators. Stakeholder constraints
(2026-09-07): keep `wasm:js-string` strings, host RegExp (and by the same
rule Date/Intl) available as opt-ins, and keep the Web-API/platform layer.

## Evidence bar (must hold BEFORE the flip PR is opened)

1. Two consecutive nightlies with the native-first lane ≥ the host lane on
   the three-lane join (first: 35,384 vs 34,099 on 36305955119; the second
   must include S4 #6186 eval linking and, if #6707 has landed, the regime
   Temporal provider).
2. `scripts/test262-edition-ratchet.ts` over the native-first JSONL: no
   ratcheted edition below its floor (run it with `--results` on the lane's
   JSONL; the floors were banked on the host lane, so this is the per-edition
   guard against a silent ES5/ES2015 regression hiding under a higher total).
3. npm-compat `js-host-native` lane: no package regresses from `measured` to
   an error state versus the `jsHost` lane on the same run (the dashboard
   JSON is CI-owned; read `benchmarks/results/npm-compat.json` after the next
   refresh, do not hand-run the whole generator).
4. Performance: the unmeasured row of the program acceptance. NOTE: the
   sidebar runner passes `--experimental-wasm-custom-descriptors`, which
   Node 22 rejects (`bad option`); it needs Node ≥ 24 (S1's implementer used
   25.9). On a box with only Node 22 this item must run on CI or another
   machine — do not skip it. Run
   `node scripts/generate-playground-benchmark-sidebar.mjs --kernels-only --output=.tmp/host.json`
   and the same with `--semantic-providers=native-first` (S1 already fixed
   the DOM row), plus the npm-compat perf lanes for acorn/cookie/redux/hono,
   and record host vs regime medians in #5385. A regression > 2× on any
   kernel is a blocker to investigate, not a note.

## Change

### A. Default and spellings (`src/target-profile.ts`, `src/cli.ts`, `src/index.ts`)

- `SemanticProviderSelection` becomes `"native-first" | "host-assisted"`;
  `"auto"` is accepted as a deprecated alias of `"native-first"` that prints
  one deprecation warning per process (CLI and API).
- `resolveCompileTargetProfile`: with no selection, `semanticProviders` is
  `"native-first"` for `gc`, `standalone` and `wasi`. `"host-assisted"` is
  the explicit rollback: it restores today's `gc` behaviour exactly
  (`capabilityPolicy: "ambient-js"`, host-assisted providers, `nativeRegime:
  false`). The byte-identity test in `tests/issue-4396-target-profile.test.ts`
  is re-pinned: `{}` ≡ `{ semanticProviders: "native-first" }` and
  `{ semanticProviders: "host-assisted" }` ≡ the pre-S6 default (capture the
  pre-S6 binaries for the three representative programs into the test
  fixtures BEFORE flipping, so the rollback path is proven byte-for-byte).
- `--semantic-providers native-first|host-assisted` in `src/cli.ts`; the
  help text names `host-assisted` as the compatibility profile scheduled for
  removal in S7.

### B. Per-family opt-in accelerators (`src/target-profile.ts`, `src/host-import-policy.ts`)

Add `readonly accelerators: ReadonlySet<"js-string" | "regexp" | "date" | "intl">`
to the profile, populated from a new option `hostAccelerators?: readonly
string[]` (CLI `--host-accelerator <name>`, repeatable). Each family keeps
its native provider as the fallback and is classified `host-accelerator` in
`src/host-import-policy.ts` (`wasm:js-string`/`string_constants` for
`js-string`; `RegExp_*` + `src/runtime/legacy-regexp.ts` for `regexp`;
`Date_*`/`__date_parse_host` for `date`; `Intl` remains host-only and is
the `intl` family). Emission sites key off `profile.accelerators.has(...)`:
strings at `src/codegen/native-strings.ts` / `src/ir/integration.ts`
(`wasm:js-string` import selection) and RegExp at
`src/codegen/context/create-context.ts` `selectNativeRegExpEngine`. An
accelerator is only legal when `environment === "javascript"`; selecting one
for standalone/WASI is a compile error, never a silent no-op.

### C. Lanes and dashboards

- `scripts/run-test262-vitest.sh`, `tests/test262-shared.ts`,
  `scripts/test262-worker.mjs`, `.github/workflows/test262-sharded.yml`: the
  host lane (`TEST262_TARGET=gc`, no provider override) now *is* the regime
  lane; retire the separate `test262-native-first` job and its
  `TEST262_SEMANTIC_PROVIDERS` plumbing only after one nightly where both
  produce the same numbers (keep it for one cycle as the control). Add
  `TEST262_SEMANTIC_PROVIDERS=host-assisted` as the explicit control spelling
  for the retired profile (measurement only, never promoted).
- `scripts/generate-npm-compat-report.mjs`: `js-host` lane = default (now
  regime); `js-host-native` lane becomes the alias and is retired next cycle;
  add `js-host-assisted` as the control.
- README conformance lines and `docs/cli.md`: the JS-environment number is
  the regime number; the wording "JS-host path … supplies host imports for
  some built-ins" goes.

### D. Docs that describe two modes

`CLAUDE.md` "Architecture Principles → Dual-mode" becomes: one native
semantic core; a JS environment adds the value adapter, explicit platform
capabilities and named accelerators; no new feature may depend on a host
semantic import. `docs/architecture/codegen-axes.md` and the per-cell mode
matrix in `docs/architecture/marshaling-contract.md` collapse to one
semantic column with an "accelerator" note.

## Acceptance

- [ ] Evidence bar items 1–4 recorded in #5385 with run ids.
- [ ] `tests/issue-4396-target-profile.test.ts`: `{}` ≡ `native-first`;
      `host-assisted` ≡ pre-S6 default byte-for-byte; `"auto"` warns once.
- [ ] Accelerator opt-ins: `js-string` and `regexp` each have a focused test
      proving the host provider is used only when selected, the native
      provider otherwise, and that selecting one for `standalone`/`wasi` is a
      compile error.
- [ ] `pnpm run check:host-import-policy`: the compatibility control probe
      now spells `host-assisted` explicitly and still reports ≥ 1 legacy
      import (non-vacuity); the default probe reports zero.
- [ ] Nightly after merge: host lane number equals the previous native-first
      lane number ± flake; standalone floor unchanged; edition ratchet green.
- [ ] npm-compat dashboard: no `measured → error` on the js-host lane.
