---
id: 4229
title: "Playground REPL powered by the standalone runtime-eval interpreter — type JavaScript, watch it parse and run INSIDE Wasm"
status: backlog
sprint: Backlog
created: 2026-08-08
updated: 2026-08-08
priority: low
horizon: m
feasibility: medium
model: fable
reasoning_effort: medium
task_type: feature
area: playground
language_feature: eval
goal: self-hosting-dogfood
related: [1584, 2527, 2928, 2929, 4013, 4194]
# id 4229 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-08 (gh CLI unavailable in the authoring sandbox). Equivalent open-PR
# scan performed via the GitHub MCP: open PRs at reservation time were
# PR 4235 (introduces only the issue file for its own id), PR 4236 and
# PR 4237 (no issue files).
---

# #4229 — Playground REPL on the standalone runtime-eval interpreter

## Motivation

The standalone eval ladder is now real: `language/eval-code/` passes 797/816
(97.7 %) with Annex B at 469/469 (PR #4233), and the whole dynamic tier —
acorn compiled to Wasm by js2wasm itself, plus the bytecode interpreter — runs
with **zero JS behind it** (the provider instantiates with no imports; the
user module imports exactly four `js2wasm:runtime-eval` functions).

That is a demo begging to exist. A REPL tab in the playground
(`website/playground/`) where every line the user types is parsed and
evaluated *inside* the Wasm module is the most legible possible proof of the
self-hosting story — far more visceral than a conformance percentage — and a
standing dogfood surface that exercises the interpreter on adversarial
human-typed input instead of test262's shapes.

**Engine-selection update (#4242, 2026-08-12):** QuickJS-NG is now the
standalone runtime-eval default, but this issue intentionally remains an
interpreter dogfood surface. Its build and runtime commands must set
`JS2WASM_EVAL_ENGINE=interpreter` explicitly. Either engine is legitimate for
future playground products; this demo's purpose is specifically to keep the
native Acorn + bytecode path visible, packaged, and exercised after the default
flip.

Proven feasible end-to-end on 2026-08-08 (session demo, `.tmp/eval-demo.mjs`
pattern): runtime-assembled sources through direct eval (caller-scope read
AND write), `new Function`, indirect eval creating a real global that a later
eval reads back, and an eval-defined function called by a second eval — all
correct, all through the provider seam.

## Design sketch

Two Wasm modules, one session:

1. **Provider** — the full Acorn+interpreter provider
   (`scripts/build-runtime-eval-provider.mjs` output, ~4.3 MB raw; measure
   gzip/brotli — the wasm compresses well). Ship as a static playground asset
   and **lazy-load on first REPL use** so the existing playground path pays
   nothing. Instantiate once per REPL session with `{}` imports.
2. **REPL shell** — a tiny js2wasm-compiled module exporting something like
   `evalLine(src: string): string`: routes the line through `(0, eval)(src)`
   (indirect eval ⇒ global varEnv ⇒ `var`/`function` declarations persist as
   real globals across lines — the #2929 C+D semantics), formats the
   completion value, and returns the rendered string. Precompile at site
   build time (simplest) or compile in-browser with the playground's existing
   compiler (dogfoodier); start with build-time.

Session persistence comes free from keeping ONE provider+shell instance pair
alive: cross-eval globals and eval-defined functions already work (verified).
"Reset session" = re-instantiate.

UI: an input line with history (↑/↓), output pane, and a small "this ran
inside WebAssembly" affordance — e.g. show the provider tier line and the
module sizes. Reuse the playground's existing layout machinery
(`website/playground/layout.ts`, `main.ts`); no new framework.

Value rendering, v1: primitives via the interpreter's ToString; objects/
arrays as a shallow ToString. Do NOT build an inspector — out of scope.
Errors: render `err.message` (readable since the #4137 NaN fix) plus
`err.pos` when it is a number.

## Constraints / known limits (state them in the UI or docs, don't hide them)

- Interpreter tier ⇒ interpreter speed. Fine for a REPL; say so.
- The 19 known eval-code residuals apply (`super`/`new.target` inside eval'd
  code, cross-realm, the delete-severing pair, …) — see #2929/#2928 records.
- Provider asset must be rebuilt when the compiler changes
  (`runtime-eval-provider` cache-key discipline). Wire the site build to the
  same artifact the CI `runtime-eval-provider` job already produces (#4013)
  rather than inventing a second build path — this is a #2527 packaging
  consumer, not a new packaging scheme.

## Acceptance criteria

- [ ] Playground gains a REPL mode; the default playground path loads no new
      bytes until the REPL is opened.
- [ ] Lines are evaluated by the standalone provider (assert in an e2e test
      that the shell module's only imports are the four
      `js2wasm:runtime-eval` functions, and no host `eval` is reachable).
- [ ] Session state persists across lines: `var x = 40` … `x + 2` → `42`;
      an eval-defined function is callable on a later line; "reset" clears.
- [ ] Errors render with message text and position (no `NaN`, no blank).
- [ ] Provider lazy-loads; compressed size measured and recorded in the PR.
- [ ] A short "how this works" note (two modules, four imports, no JS engine
      behind it) linked from the REPL UI.

## Non-goals

- Host-lane REPL fallback (the host shim's scope-capture gap, #2925, makes it
  the worse demo today).
- An object inspector, syntax highlighting beyond what the playground already
  has, or top-level `await` (interpreter Phase-2 scope, #2928).
- Any change to the provider ABI or the eval semantics themselves.
