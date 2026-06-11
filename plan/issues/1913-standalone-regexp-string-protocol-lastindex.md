---
id: 1913
title: "standalone RegExp string protocol, matchAll, split/replace, and lastIndex residuals"
status: ready
sprint: 61
model: fable
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: regexp, string-methods
goal: standalone-mode
related: [1909, 1539, 1439, 1328, 1329, 1330, 1331]
test262_bucket: standalone-regexp-string-protocol
test262_count: 452
---

# #1913 — Standalone RegExp string protocol and lastIndex residuals

## Problem

After #1539, standalone mode supports a useful static RegExp subset, but the
test262 residual still contains protocol and stateful string-method semantics:
`@@match`, `@@replace`, `@@matchAll`, `@@split`, global/sticky `lastIndex`,
split limits/captures/empty separators, replacement substitutions, and function
replacers.

Representative signatures from the 2026-06-07 standalone JSONL:

- `literal-substring backend does not support @@replace symbol protocol calls`.
- `literal-substring backend does not support @@match symbol protocol calls`.
- `literal-substring backend does not support @@matchAll symbol protocol calls`.
- `RegExp.prototype.exec with g/y lastIndex semantics`.
- `String.prototype.split(RegExp, limit)`.
- `String.prototype.replace with a $-substitution pattern or non-literal/function replacer`.

## Scope

- Implement the next standalone string/RegExp protocol slice without JS-host
  dispatch.
- Model observable `lastIndex` semantics for global and sticky RegExp values.
- Keep symbol-protocol fallbacks and custom receiver cases separated from the
  static backend-created RegExp path.

## Acceptance Criteria

- Representative protocol/lastIndex/split/replace test262 rows leave the
  `standalone-regexp-string-protocol` bucket.
- The implementation emits no `env.RegExp_*` or JS-host string protocol imports
  under `--target standalone`.
- Focused tests compare standalone output to native JavaScript for each landed
  method family.
