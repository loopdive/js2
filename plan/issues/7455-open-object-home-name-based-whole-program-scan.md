---
id: 7455
title: "Ordinary pipeline: `everyUseIsServed` is a third name-based whole-program scan of script-binding writes"
status: ready
created: 2026-11-23
updated: 2026-11-23
priority: medium
horizon: s
goal: core-semantics
sprint: Backlog
related: [7354]
---

# #7455 — Ordinary pipeline: `everyUseIsServed` is a third name-based whole-program scan of script-binding writes

## Problem

`everyUseIsServed` in `src/ir/dynamic-home-open-object.ts` (about lines 85-115) decides whether an open-object home is safe with `bindingIsUniqueAndNeverWritten` + `sourceWritesMemberNamed` + a reflective-route scan. Slice H2 of #7354 deleted the same kind of scan on the Prepared path, where every other route refuses at its own site. On the ordinary pipeline that argument does not hold (`eval`, `with` and the global object are live), so it was not folded. It also asks a second question: whether `Object.prototype` stays the realm's own.

## Acceptance criteria

- The two questions are separate predicates.
- The binding-write question uses the one writes query in `src/ir/module-binding-script-var.ts`.
- Ordinary-pipeline output is byte-identical on the equivalence corpus, or every difference is a fix.
