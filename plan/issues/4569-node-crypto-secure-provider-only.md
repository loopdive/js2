---
id: 4569
title: "Require secure runtime providers for node:crypto randomness"
status: backlog
created: 2026-08-20
updated: 2026-08-20
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: runtime, security
language_feature: node-crypto-randomness
goal: node-compatibility
sprint: Backlog
depends_on: [4567]
horizon: s
es_edition: n/a
related: [1322, 1492, 1503, 4383, 4398]
origin: "2026-08-20 Node API compatibility and portability review"
---
# #4569 — Require secure providers for `node:crypto` randomness

## Objective

Make `randomBytes` and `randomUUID` cryptographically secure in every lane that
claims to support them, and fail clearly when the selected target has no secure
randomness provider.

## Problem

The platform adapter currently falls back to `Math.random()` when a Node crypto
function cannot be resolved. A warning does not make the returned bytes or UUID
safe, and callers cannot reliably distinguish the degraded result. This is a
silent security failure: a program that requested `node:crypto` receives an
API-shaped value without the API's security property.

## Provider policy

Supported providers are:

- the real `node:crypto` implementation under a Node host;
- Web Crypto secure randomness where the selected JS host exposes it;
- WASI `random_get` for standalone/WASI targets;
- an explicitly injected provider satisfying the same typed contract.

Provider selection must be visible in the compiler/runtime capability record.
No provider may substitute a non-cryptographic pseudorandom source.

## Acceptance criteria

- [ ] Remove every `Math.random()` fallback reachable from
      `node:crypto.randomBytes` and `node:crypto.randomUUID`.
- [ ] Known targets select Node crypto, Web Crypto, WASI `random_get`, or an
      explicitly injected secure provider.
- [ ] A statically unavailable provider produces a stable compile/link
      diagnostic; a missing injected runtime provider fails before returning
      any bytes or UUID.
- [ ] `randomBytes` validates size, range, and overload shape in Node-observable
      order and returns a byte-compatible value.
- [ ] `randomUUID` emits RFC 4122 version/variant bits and accepts only the
      supported Node options shape.
- [ ] Tests cover every provider lane, the no-provider failure, invalid inputs,
      and a positive control proving the fallback cannot be reintroduced.
- [ ] Programs that do not use crypto contain no randomness capability or
      provider import.

## Out of scope

- Claiming statistical certification from a small deterministic test sample.
- Hashing, signing, encryption, key management, or the complete crypto module.
