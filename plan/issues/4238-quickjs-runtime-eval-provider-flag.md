---
id: 4238
title: "QuickJS-backed runtime-eval provider behind a flag — swap the eval engine, keep the Acorn+interpreter default until migration completes (#4236 variant C MVP)"
status: ready
sprint: current
created: 2026-08-08
updated: 2026-08-08
priority: high
horizon: l
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: runtime-eval
language_feature: eval
goal: runtime-eval
related: [2928, 2929, 4013, 4236]
# id 4238 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-08 (gh CLI unavailable; pr_scan=degraded). Equivalent open-PR scan
# via the GitHub MCP at reservation time: sole open PR was PR 4245 (docs-only,
# edits existing issue files 4236/4237, introduces no new issue ids).
---

# #4238 — QuickJS-backed runtime-eval provider, flag-gated

## Request (project lead, 2026-08-08)

> swap out our interpreter with quickjs but keep the old. enabling quickjs
> should be behind a flag to keep things working until migration is done

This is the **#4236 variant C MVP**: QuickJS (the slice-1 WASI artifact,
scripts/quickjs-artifact/, quickjs-ng v0.16.1 pin) becomes an alternative
ENGINE behind the existing `js2wasm:runtime-eval` provider seam. The seam
itself — four imports (`__runtime_direct_eval`, `__runtime_indirect_eval`,
`__runtime_new_function`, `__runtime_apply_interpreted`), externref/i32/f64
signatures, emitted at src/codegen/expressions/runtime-eval-provider.ts —
does NOT change. User modules compile identically under both engines.

## Hard constraints

1. **The Acorn+interpreter provider stays the default.** No behavior change
   anywhere unless the flag is set. CI, test262 baselines, the #4013
   provider-artifact cache, the eval-code 797/816 result — all untouched by
   default.
2. **Flag surface** (architect to finalize naming): an engine selector on
   provider *selection*, not on user-module codegen — e.g.
   `JS2WASM_EVAL_ENGINE=quickjs` for runners/tests and an
   `--evalEngine quickjs` CLI flag. Default `interpreter`. Unknown values
   error loudly.
3. **Keep both engines healthy**: the flag must be exercised by a scoped CI
   or local test lane (a small eval test set run under
   `JS2WASM_EVAL_ENGINE=quickjs`) so the QuickJS path can't rot silently —
   but as a non-required / scoped check, not a change to the required gates.
4. Migration ends (separate future issue) with defaults flipped and the old
   interpreter retired; nothing in this issue removes interpreter code.

## Design substrate (already proven — do not re-derive)

- **#4236 "## Design variant C"**: handle-table ABI for GC-lane values
  crossing into QuickJS, exotic wrappers, `JSClassDef.gc_mark` cycle notes,
  tiered-provider MVP scoping (≈ 1 budget window).
- **#4236 "## Slice 1 — WASI artifact"**: the artifact is genuinely
  standalone (5 wasi imports, zero env.*), i32 handles per QTS convention,
  the shim converts QuickJS move→borrow semantics ("free every returned
  handle once"), tag-extraction exports for immediates.
- `scripts/quickjs-artifact/build.sh` builds reproducibly in ~3 min cold
  with stock clang-18 (no wasi-sdk); `wasi-stub.mjs` instantiates with a
  no-op WASI stub; `extract-abi.mjs` dumps the ABI constants.
- Current provider plumbing: `scripts/build-runtime-eval-provider.mjs`
  (builds the Acorn+interpreter provider), `scripts/runtime-eval-provider.mjs`
  (`selectCachedRuntimeEvalProvider`, #4013 cache keyed on compiler-bundle
  hash), `src/interp/eval-environment.ts` (scope-bridge semantics),
  `tests/` eval suites + `TEST262_FULL_RUNTIME_EVAL=1` runner wiring.

## Known open problems the spec must resolve

- **Value bridging**: the seam's externref args are GC-lane values; QuickJS
  values are linear-memory JSValues behind i32 handles. Where does the
  handle table live, who wraps/unwraps, and what subset of values round-trips
  in the MVP (numbers/strings/booleans/null/undefined at minimum)?
- **Scope bridge**: direct eval's caller-scope read/write (the #2929 C+D
  semantics) — what does the MVP support, and what degrades to the
  documented residual list? Indirect eval + `new Function` (global scope
  only) are the natural MVP tier.
- **Artifact delivery**: the QuickJS wasm is not committed (CI builds it,
  #4243 workflow). How does the provider selector obtain it — build-on-
  demand via build.sh, cache dir, env override — without breaking offline
  default runs?
- **`__runtime_apply_interpreted`**: calling an eval-defined function from
  compiled code — how does a QuickJS function handle get invoked through
  the seam?

## Acceptance criteria

- [ ] With no flag: byte-identical provider selection behavior; full test
      suite + eval test262 subset unchanged.
- [ ] With `JS2WASM_EVAL_ENGINE=quickjs` (name per spec): indirect eval,
      `new Function`, and eval-defined-function invocation work end-to-end
      from a js2wasm-compiled standalone module, with zero JS behind the
      seam beyond the WASI stub.
- [ ] A scoped test lane runs a defined eval subset under the QuickJS
      engine and is green; its pass/residual list is recorded in this file.
- [ ] Direct-eval scope semantics: MVP level defined, implemented or
      explicitly deferred with the residual documented here.
- [ ] Engine selection is observable (e.g. provider reports its tier/engine
      string) so tests can assert which engine served an eval.
- [ ] No new host imports without a standalone fallback (CLAUDE.md
      dual-mode principle) — the QuickJS path must remain pure-wasm+WASI.

## Implementation Plan

(To be written by architect — spec the module graph, the handle-table ABI
at the seam, the flag plumbing through compile()/CLI/runners, the artifact
acquisition path, the test lane, and the slice order.)
