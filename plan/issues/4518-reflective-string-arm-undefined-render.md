---
id: 4518
title: "standalone: reflective String-method arm renders the undefined singleton as '[object Object]' — blocks 3 of #4489's R1 rows"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-16
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: string
goal: standalone-gap
related: [4489, 4465]
origin: "2026-08-16 #4489 verification — pre-existing (absent-argument provenance renders identically on both sides of the seed A/B). Blocks charAt/S15.5.4.4-family rows whose actual strings now carry 'undefined' upstream but '[object Object]' through the reflective arm."
---

# #4518 — reflective String arm renders undefined as "[object Object]"

## Problem

The reflective `String.prototype.<m>` bodies' ToString of an `undefined`
value (receiver or argument, incl. the closure ABI's absent-arg pad and the
#4489 tag-1 singleton) terminates in `$__any_to_string`'s unrecognized-ref
arm → literal `"[object Object]"` instead of `"undefined"`. Pre-existing
before #4489 (absent-argument control renders identically on both sides);
the #4489 seed made 3 more test262 rows reach it:
`concat/S15.5.4.6_A2`-family + the 3 unflipped #4489-R1 rows (see #4489's
issue file for the exact list and provenance evidence).

## Plan

Brief: plan/method/es5-standalone-agent-brief.md. Add the tag-1-singleton /
null arm to the shared reflective ToString (`string-proto-tostring.ts`
`emitStringProtoToStringFlat` — same splice point as #4465's
withRegExpReceiverArm) rendering "undefined" per §7.1.17. A/B the
#4489-R1 rows (should flip) + the #4465/#4489 pin suites + a scoped
built-ins/String/prototype sweep, zero regressions.
