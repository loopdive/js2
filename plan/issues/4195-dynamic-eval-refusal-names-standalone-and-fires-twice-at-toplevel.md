---
id: 4195
title: "the dynamic-eval refusal names `--target standalone` (which supports it) and fires twice per top-level call site"
status: ready
sprint: current
created: 2026-08-06
updated: 2026-08-06
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: eval
goal: runtime-eval
related: [2928, 2960, 3623, 3725, 4162]
---

# Problem

Two independent defects at one site, `src/codegen/expressions/calls.ts:6322-6339`.
Both were found by a user compiling a hand-written `evaltest.js` with the
**published** `js2wasm@0.68.0`; both reproduce identically on `main`, so
neither is a release-lag artifact.

## A — the message names a target that actually supports dynamic eval

```
warning: dynamic eval is not supported in --target standalone/wasi — no
runtime-eval host is available; this eval call throws at runtime
```

`--standalone` **does** support dynamic eval. It is the only target that
materializes the provider ABI. The gate is one line away, at
`src/codegen/expressions/runtime-eval-provider.ts:442`:

```ts
if (!ctx.standalone) return undefined;
```

so a standalone build emits the `js2wasm:runtime-eval` imports and never
reaches the refusal, while a wasi build always does. The comment immediately
above the refusal already states the real scope — *"(#2960) WASI (until its
linker grows the provider)"* — the user-facing string is simply out of step
with it.

Measured on the same one-line input (`function identity(s){return s;}
var r = eval(identity("1 + 1"));`), counting `js2wasm:runtime-eval` imports in
the emitted `.wat`:

| build | flag | warning | runtime-eval imports |
| --- | --- | --- | ---: |
| `npx js2wasm@0.68.0` | `--target=wasi` | yes | 0 |
| `main` | `--target=wasi` | yes | 0 |
| `npx js2wasm@0.68.0` | `--standalone` | **none** | **2** |
| `main` | `--standalone` | **none** | **2** |

The cost of the wrong string is that it tells users the working path is
broken. It is the reason this was reported as "do I need a new release?" —
the honest answer is no, the reporter needed a different flag, and the
diagnostic actively pointed away from it.

Note `noJsHost()` (`src/codegen/js-errors.ts:29`) is `ctx.wasi ||
ctx.standalone`, so the refusal branch is reachable for standalone too — but
only via a *genuine* provider-materialization failure, which is a different
condition and deserves a different message. Do not simply swap the string to
"wasi"; distinguish the two.

## B — the refusal fires TWICE per top-level call site

`(2×)` for a file containing exactly one `eval(...)`. The multiplier is
exact and it is **specific to module-init**:

| where the `eval` lives | warnings |
| --- | ---: |
| inside a function body | **1** |
| top level (`__module_init`) | **2** |
| two top-level sites | **4** |

So the aggregator is not double-counting — **top-level statements are compiled
twice**, and each pass re-emits the diagnostic. The warning is the visible
symptom, not the defect.

That matters well beyond this message: any diagnostic, refusal, or counter
emitted while compiling top-level code is doubled. It should be checked
against the #3623 module-init telemetry (which #4181 has just extended) and
against #3725 *speculative rollback discards refusals* — a second compilation
pass whose refusals are kept is the mirror image of one whose refusals are
discarded, and the two suggest the same underlying pass structure.

# Acceptance criteria

1. A `--standalone` build that genuinely cannot materialize the provider gets
   a message naming *that* condition; a wasi build gets one naming wasi. No
   message claims `--standalone` cannot do dynamic eval.
2. One top-level `eval(...)` produces exactly **one** warning.
3. A test pins both: the emitted-import count per target (0 for wasi, 2 for
   standalone) and the warning count for a top-level vs in-function site.
4. The root cause of B is stated in the fix — either the second top-level pass
   is removed, or diagnostics are deduped at the pass boundary with a note on
   why the pass must run twice. A dedupe that hides a genuine double-compile
   without saying so is not acceptable; the doubling is the finding.

# Repro

```bash
printf 'function id(s){return s;}\nvar a = eval(id("1+1"));\n' > /tmp/t.js
npx tsx src/cli.ts /tmp/t.js --target=wasi   --no-optimize   # warns (2×), 0 imports
npx tsx src/cli.ts /tmp/t.js --standalone --wat --no-optimize | \
  grep -c 'js2wasm:runtime-eval'                             # 2, no warning
```

# Notes

Out of scope: giving wasi a runtime-eval provider. That is the #2960 /
#2928 line of work and is a real feature. This issue is only that the diagnostic
misdescribes which targets are affected, and that it fires twice.
