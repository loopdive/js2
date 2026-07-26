---
id: 3675
title: "Standalone compiled Acorn traps parsing its full source at parseFloat/reset dispatch"
status: ready
sprint: current
created: 2026-07-26
updated: 2026-07-26
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime, standalone
language_feature: dynamic-dispatch
goal: self-hosting-dogfood
es_edition: n/a
related: [1712, 2853, 2928, 3033, 3673, 3674]
---

# #3675 — Parse full Acorn source in a zero-import standalone artifact

## Problem

The merged Acorn acceptance gate proves exact JS-host AST parity and four
zero-import standalone scalar canaries. The standalone artifact still does not
parse Acorn's complete 230,975-byte distribution.

After working around #3674 by joining 8,000-character chunks inside the module,
standalone compilation and instantiation succeed with zero imports. Invoking
the full-source self-parse traps:

```text
RuntimeError: illegal cast
    at parseFloat
    at __closure_575
    at __call_fn_method_3
    at __apply_closure
    at __extern_method_call
    at __call_m_reset_3
    at __closure_673
    at __call_fn_method_0
    at __apply_closure
    at __extern_method_call
```

The exact input and options are:

- pinned `acorn@8.16.0` `dist/acorn.mjs`;
- 230,975 UTF-8 bytes;
- SHA-256
  `efb0124a960b34d53f9928c4926bfcfd300bb6a3d7ab64ee949b3a8bed1c7e5f`;
- `{ ecmaVersion: 2025, sourceType: "module" }`;
- compiler revision `2bf320a91f330727ac2b7d9cc05cf13aeb982bae`.

This is a size/shape-dependent runtime path, not evidence that the exported
parser is generally broken. The 1,754,426-byte base standalone Acorn artifact
still validates, has zero imports, and passes:

- `parse("1 + 2", ...) -> body.length === 1`;
- `parseExpressionAt(...)` scalar canary;
- `tokenizer(...)` scalar canary;
- `parse("function f(a,b) { return a + b; }", ...)` scalar canary.

The JS-host artifact also remains exact across 53,259 Test262 files and 102,312
script/module/strict variants.

## Required investigation

- Reduce the full source while preserving the `parseFloat` /
  `__call_m_reset_3` illegal-cast path, or instrument carrier type identities at
  the failing dispatch boundary.
- Determine whether the wrong receiver, closure target, structural function
  type, or reconstructed object crosses `__extern_method_call`.
- Fix the shared carrier/dispatch rule. Do not special-case Acorn method names
  or weaken a `ref.cast` without a proven compatible fallback.
- Keep the parser and AST inside one standalone module for this gate; canonical
  cross-module AST/string rec-group packaging remains separate E6/#2527 work.

## Acceptance criteria

- A zero-function-import standalone wrapper parses the pinned complete
  `acorn.mjs` input with the options above and returns an in-module scalar
  checksum or body-length result equal to node-acorn.
- The full parse completes without `illegal cast`, host-satisfied imports, or a
  parser-specific intrinsic.
- A reduced regression fixture exercises the same receiver/callable carrier
  transition that previously trapped.
- The four existing standalone scalar canaries remain green.
- The required 23-input JS-host corpus and exact full Test262 differential
  remain green.
- The final artifact's function-import count, byte size, compile time, and
  self-parse time are recorded. Performance remediation is owned by #3673.

## Test plan

- Add the reduced carrier transition to `tests/issue-3675.test.ts`.
- Extend `tests/dogfood/acorn-standalone-compile.mjs` with an opt-in full-source
  self-parse gate that asserts zero function imports and compares the in-module
  scalar result with node-acorn.
- Keep `tests/dogfood/acorn.test.ts` and
  `tests/issue-1712-acorn-context.test.ts` in the scoped regression run.

## Scope boundary

This issue does not own the static large-literal validator failure (#3674), the
general parser performance gap (#3673), or the E6 cross-module rec-group/export
ABI.
