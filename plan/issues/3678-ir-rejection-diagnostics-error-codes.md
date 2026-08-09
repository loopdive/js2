---
id: 3678
title: "Actionable rejection diagnostics for the IR path — error code + code frame + rewrite hint (scriptc-inspired)"
status: backlog
sprint: Backlog
created: 2026-07-26
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: feature
area: compiler
language_feature: compiler-internals
goal: developer-experience
related: [2855, 1376]
---

# #3678 — Actionable rejection diagnostics for the IR path

## Context / provenance

From a 2026-07-26 comparison with [vercel-labs/scriptc](https://github.com/vercel-labs/scriptc)
(Vercel's TypeScript→native compiler). scriptc's headline DX property: when a
construct can't compile, the user gets **"a specific error code, a code frame,
and usually a rewrite hint. Nothing is ever silently miscompiled."**

We are on the opposite end today: when the IR path rejects a node kind, the
failure **silently demotes to the legacy AST→Wasm path** via a warning channel
(#1376 fallback budget), and the only visibility is the aggregate bucket counts
in `scripts/ir-fallback-baseline.json`. A user (or dev agent) compiling a file
has no per-site signal of *what* was rejected, *where*, or *what to change*.

## Problem

As #2855 ratchets unintended fallback buckets to zero and promotes reasons into
`STRICT_IR_REASONS`, rejections stop being silent demotions and become **hard
compile errors**. The current error surface for that promotion is a bare reason
string (e.g. `body-shape-rejected`) — accurate for CI gating, useless for a
human deciding how to fix their source.

## Proposal

Give every IR rejection (and every `STRICT_IR_REASONS` hard error) a structured
diagnostic:

1. **Stable error code** per rejection reason — e.g. `JS2W-IR-001
   body-shape-rejected`, `JS2W-IR-004 param-shape-rejected` — so codes are
   greppable, documentable, and stable across refactors of the reason strings.
2. **Code frame** — file, line/col span of the offending node, with a 2–3 line
   source excerpt. The IR builder already has the `ts.Node`; thread its
   position through the rejection instead of dropping it at
   `trackFallbacks` aggregation time.
3. **Rewrite hint** where one exists — e.g. `param-shape-rejected` →
   "destructure inside the body instead of the parameter list (until #1372)";
   `external-call` → "only whitelisted builtins (Math.*, parseInt) are
   IR-compilable (#1371)".
4. A `--explain JS2W-IR-XXX` CLI mode (or a docs table) mapping each code to
   its meaning, tracking issue, and workaround.

Keep the fallback-budget machinery unchanged — this is a presentation layer on
data the rejection path already produces; it must not alter which nodes fall
back.

## Acceptance criteria

- [ ] Every rejection reason in the #1376 table has a stable `JS2W-IR-NNN` code
- [ ] `trackFallbacks: true` (and strict-reason hard errors) emit file:line:col
      plus a source excerpt for each rejection site
- [ ] At least the four unintended buckets with tracking issues
      (`body-shape-rejected`, `external-call`, `param-shape-rejected`,
      `call-graph-closure`) carry rewrite hints citing the tracking issue
- [ ] `check:ir-fallbacks --verbose` output includes the codes
- [ ] No change to fallback *behavior* — baseline counts identical before/after
