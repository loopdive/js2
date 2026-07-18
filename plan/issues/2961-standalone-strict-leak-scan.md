---
id: 2961
title: "Extend the strictNoHostImports leak guarantee to `--target standalone` (today wasi-only)"
status: done
completed: 2026-07-17
assignee: dev-2961
depends_on: [3009]
sprint: current
model: opus
created: 2026-07-02
updated: 2026-07-17
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: compiler-internals
goal: standalone-mode
related: [2094, 2879, 2073, 2075, 2860, 3009]
origin: "2026-07-02 July Fable audit §3 (protection asymmetry: standalone has only the statistical floor, no structural guarantee)"
regressions-allow:
  count: 3150
  reason: "#2961's own purpose (reject host-backed standalone passes, ORACLE_VERSION 5->6) produces exactly this reclassification shape, anticipated in its own acceptance criteria. merge_group run 29532692021: 3084 non-excused wasm-change regressions, 100% one category (host_import_leak, no other present) -- leaky passes correctly becoming honest fails. Traps all decreased/flat (null_deref 339->251, illegal_cast 566->259, oob 43->41, unreachable 3->3), zero new. Net -3082 (27964->24882 standalone pass), 2 improvements. Ceiling: 3084 + ~66 margin."
---

# #2961 — `--target standalone` has no structural no-leak guarantee

## Problem

`strictNoHostImports` auto-enables **only for `--target wasi`**
(`src/codegen/context/create-context.ts:25`:
`options?.strictNoHostImports ?? options?.wasi ?? false`). Both enforcement
layers — the per-call allowlist gate in `addImport`
(`src/codegen/registry/imports.ts:51-75`) and the emit-time
`assertNoLeakedHostImports` scan (`src/codegen/index.ts:2230`) — key off
that flag. So a host import reaching `addImport` off the late-import
rerouting path under plain `--target standalone` is **emitted silently**
and traps at instantiation on a host-free runtime. The only protection is
the statistical `host_free_pass` CI floor. The audit measured 7,498
pass-but-leaky tests — this asymmetry is why that class can exist.

## Approach

1. Default `strictNoHostImports` on for `ctx.standalone` as well.
2. Expect baseline churn: run the standalone lane, enumerate every import
   name that now hard-errors, and either (a) add it to
   `src/codegen/host-import-allowlist.ts` **with its retiring issue id**
   (the existing budget discipline, `[allowlist-grow]` sign-off), or
   (b) convert the site to a `refuseStandalone*`-style loud compile error
   where a fallback is genuinely absent.
3. Severity option if a hard flip regresses the floor: land as
   warning-severity scan first (every leak gets a source-located
   diagnostic), flip to error once the allowlist stabilizes — but the end
   state is the same hard guarantee wasi has.

## Re-scope (2026-07-02, after #3009 tracing)

Scoping this surfaced that the flip is **not** a one-line gate change, and that
the standalone leak surface is far narrower than the "7,498 pass-but-leaky"
headline suggested. Two findings:

1. **Most pure-language features are already host-free under `--target
standalone`.** Verified on current main (zero `env` imports emitted):
   arithmetic, classes/methods, string concat + coercion, `String()` /
   `.toString()`, `throw` / `Error`, `JSON.stringify`. So the naïve
   "flip strict on for standalone → huge baseline churn" fear is overstated;
   the leak set is a **specific, enumerable** list, not a pervasive one.
2. **The real blocker is a narrow CRASH hazard, not a leak-count problem.**
   Flipping strict on for standalone re-triggers the `absoluteFuncIndex`
   internal crash (`stable handle undefined (ordinal NaN)`) the moment a
   dropped host import is baked into a stable-handle helper body — e.g.
   `console.log(<string>)` → `__str_to_extern` → dropped
   `__str_from_mem`/`__str_to_mem`/`__str_extern_len`. That crash masks the
   real diagnostic and would make the enumeration lane unusable.

### 3-step decomposition

- **(a) Harden the degrade path — #3009 [LANDING].** Convert the
  dropped-stable-handle-coupled crash into a clean, named leak diagnostic.
  This unblocks the enumeration lane (a real leak now reports cleanly instead
  of crashing). This issue is `blocked` on #3009 landing.
- **(b) Enumerate the full standalone leak set.** With #3009 in, run the
  standalone lane (or a scoped example/test262 sweep) with the strict flag on
  and collect every host import name that now hard-errors. Classify each as
  (i) allowlist-with-retiring-issue, or (ii) `refuseStandalone*` loud error
  where no fallback exists. This produces the concrete, finite work list.
- **(c) Flip the strict gate for `ctx.standalone`.** Default
  `strictNoHostImports` on for standalone (mirroring wasi). Land
  **warning-severity first** if a hard flip regresses the host-free floor —
  every leak gets a source-located diagnostic — then ratchet to error once the
  allowlist stabilizes. End state = the same structural guarantee wasi has.

## Acceptance criteria

- `--target standalone` compile of a program using an un-allowlisted host
  import fails loudly at compile time (or warns, phase 1) — never emits a
  silently-trapping binary, and never crashes with the `absoluteFuncIndex`
  internal error (guaranteed by #3009).
- Allowlist growth for this issue is fully annotated (name → retiring
  issue).
- Host-free floor (check-standalone-highwater) net-neutral or up;
  merge_group validated.

## (b) Enumeration — the standalone leak set (2026-07-17)

Swept ~60 feature snippets + the repo's `website/playground/examples/js/*.ts`
under `target: "standalone"`, collecting emitted `env::` imports and the
phase-1 warning-scan diagnostics. **The re-scope holds: the leak set is narrow,
finite, and entirely genuine host-only dependencies** — this is
enumerate-and-gate work, NOT architectural feature work.

**Host-free already (ZERO `env` imports)** — arithmetic, classes/methods,
strings (concat, split, indexOf, includes, replace, repeat, normalize,
localeCompare), numbers (toString, toFixed, toLocaleString), parseInt/parseFloat,
`JSON.stringify`, arrays (literals, map/forEach/reduce/sort, `Array.from`,
spread), `Map`/`Set`/`WeakMap`, `Math.*` (incl. atan2/sqrt), `RegExp`
(test/match/replace-fn), `throw`/`Error`, generators, `async`, `typeof`,
`for-in`, `String.fromCharCode`, `Date`, `Promise`, `Symbol`, `Object.*`
(keys/assign/entries), optional chaining, computed member, getters/setters,
`super`, static blocks, tagged templates, `Reflect`, TypedArray, DataView.

**Un-allowlisted leaks (WARNED in phase 1; would hard-error in phase 2)** —
three buckets, all with NO standalone fallback:

| leak import                                                                                                                                                                       | source feature                                                       | classification                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `__str_from_mem`, `__str_to_mem`, `__str_extern_len`                                                                                                                              | `console.log`/`process.*` host-string marshalling (the #3009 bridge) | (ii) no standalone stdout → phase-2 refuse (or allowlist as a tolerated debug path, decided as a unit with `console_*`) |
| `__timer_set_timeout`                                                                                                                                                             | `setTimeout` / async schedule                                        | (ii) no standalone event loop (like wasi) → phase-2 refuse                                                              |
| `Document_createElement`, `Document_get_body`, `Element_set_innerHTML`, `Element_set_textContent`, `HTMLElement_get_style`, `Node_appendChild`, `CSSStyleDeclaration_set_cssText` | DOM extern classes                                                   | (ii) DOM needs a browser host (wasi already refuses these) → phase-2 refuse                                             |

**Allowlisted-so-tolerated (emit `env` imports but do NOT warn)** —
`console_log_string`/`console_log_number`/`console_log_bool` (via the `console_`
prefix entry, `trackingIssue 0`) and `bigint_toString` (`trackingIssue 1644`).
Phase-1 cosmetic asymmetry: a `console.log(<string>)` warns on its
`__str_*_mem` bridge helpers but not on `console_log_string` — both indicate the
same host dependency; phase 2 decides the console path's disposition as a unit.

Unrelated pre-existing bug found while sweeping (NOT #2961, out of scope):
`JSON.parse` under `--target standalone` hard-crashes with
`Internal error compiling expression: Cannot read properties of undefined
(reading '0')` (reproduces with the leak scan disabled).

## Phase 1 (warning-first) — LANDED

- The emit-time scan (`assertNoLeakedHostImports`, `src/codegen/index.ts`) now
  fires for plain `ctx.standalone` at **warning** severity (wasi / explicit
  `strictNoHostImports` stay **error**). The per-call `addImport` gate is
  unchanged (still strict-only), so **no import is dropped and the emitted
  binary is byte-identical** to before — the `host_free_pass` floor (which keys
  on emitted `env::` imports) cannot move. Every standalone host-import leak now
  gets a source-located advisory diagnostic naming the import + citing #2961.
- `buildLeakedHostImportError(leak, severity)` grew a severity arg: `"warning"`
  emits a non-fatal advisory (no `Codegen error:` hard-fail marker); `"error"`
  keeps the original wording. Default `"error"` (back-compat).
- Escape hatch `JS2WASM_STANDALONE_LEAK_SCAN=0` disables the standalone scan for
  A/B control.
- Tests: `tests/issue-2961.test.ts` (10 cases) — leak warns but stays
  success + binary-neutral, host-free program is warning-free, wasi unchanged,
  severity wording.
- NO allowlist growth (phase 1 needs none — everything just warns).

## Phase 2 (follow-up, gated) — tracked in #3376

This issue closes `done` with phase 1: its acceptance explicitly allows the
warning form ("fails loudly ... (or warns, phase 1)"), which PR #3288 delivers.

The ratchet WARNING→ERROR is tracked as a separate small issue **#3376**: after
#3288 merges, on a real merged-report/test262 run showing the host-free floor
net-neutral-or-up, flip the severity ternary in `assertNoLeakedHostImports` to
ERROR (one-liner) and decide per-bucket tolerate-vs-refuse for the
console/timer/DOM leaks. This produces the pre-approved `host_import_leak`
reclassification (leaky standalone passes → honest fails; see the
`regressions-allow` block).
