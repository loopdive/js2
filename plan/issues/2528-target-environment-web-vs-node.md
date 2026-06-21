---
id: 2528
title: "Target environment model (web vs node): scope the ambient global surface so e.g. window.stop isn't in a node host's lib"
status: backlog
sprint: Backlog
created: 2026-06-20
updated: 2026-06-20
priority: low
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: target-environment
goal: usability
related: [2520, 1044]
---

## Problem / proposal

The compiler loads the DOM lib (`lib.dom.d.ts`) for the ambient global surface
regardless of what the output actually targets. So a **node/WASI-style host** has
browser globals like `window`, `alert`, `scroll`, `stop`, `document` in scope —
which makes no sense for it, and (before #2520's gate) flooded it with host-import
warnings. Conversely a **web** target legitimately has those and not node's
`process`/`Buffer`.

Proposal: a way to declare the target **environment** — e.g. `--platform web|node`
(or `--env`) — that selects which ambient globals are in scope:

- `node` → node-style globals (`process`, `Buffer`, …) are **in scope with their
  types auto-provided**, so `process.stdin.read(...)` resolves with **no
  "Cannot find name 'process'" (TS2580) warning** — the user no longer needs a
  hand-written `declare const process` (which bundlers like `bun build` strip).
  DOM/window globals are *not* declared, so `window.stop` is a clear error.
- `web` → DOM globals + their types in scope; node-only globals are not.

The "auto-provide the environment's ambient types" part is the direct fix for the
`process` warnings on loopdive/js2#389: today `process` is *supported* under
`--target wasi` (lowered to WASI fd syscalls) but has no ambient type unless the
user declares one, so every use warns. A `node` environment should ship those
types so referencing `process` Just Works.

Today these are decoupled from `--target wasi`/`--standalone`, which describe the
*backend*, not the host environment.

## Why now / relation to #2520

#2520 added a referenced-names gate so unused ambient globals no longer register
as host imports — so the *noise* is already gone. This issue is the deeper model:
make the ambient surface itself correct per environment, so misuse (`window.stop`
in a node host) is a **type error** rather than a dropped import, and so the
right globals are available without `@types/node`-style setup.

## Open questions (route to architect/PO)

- Flag name/shape (`--platform web|node`, `--env`, or infer from `--target`?).
- How it maps to the TS `lib`/`types` program options and the `LIB_GLOBALS` /
  `DOM_ONLY_GLOBALS` sets in `src/codegen/index.ts`.
- Interaction with the dual-mode allowlist and the Node-builtins-as-host-imports
  work (#1044).
- Default when unspecified (today's behaviour = DOM in scope).

## Notes

Surfaced while investigating loopdive/js2#389 (a node/WASI Native Messaging host
that had `window.stop` etc. in scope). Lower priority now that #2520 removed the
warning noise; this is the correctness/ergonomics follow-up.
