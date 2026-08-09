---
id: 3751
title: "cookie dogfood harness — fourth single-bundle npm package, surfaces a real dynamic-property-write-dropped bug (#3750)"
status: done
sprint: 77
created: 2026-07-28
updated: 2026-07-30
completed: 2026-07-28
priority: medium
horizon: m
feasibility: easy
reasoning_effort: medium
task_type: test
area: testing
language_feature: n/a
goal: core-semantics
origin: "continuing the tests/dogfood/ npm-package testing effort (acorn #1710, marked #3716, acorn-official-suite #3729, clsx #3748) — cookie is a genuinely single-file real ESM bundle with fixed-arity named exports, no driver-epilogue shim needed"
related: [1710, 3716, 3729, 3747, 3748, 3749, 3750]
---

# #3751 — cookie dogfood harness

## Why cookie

Fourth package in the corpus, chosen for a different shape again:
`cookie@2.0.1`'s `dist/index.js` is a genuine single-file ESM bundle
(zero imports, real named exports) like acorn/marked/clsx, but unlike
clsx its four exports (`parseCookie`, `stringifyCookie`,
`stringifySetCookie`, `parseSetCookie`) are all **fixed-arity with real
declared parameters** — so this harness calls them DIRECTLY across the
wasm export boundary, no driver-epilogue shim needed (contrast clsx's
variadic `arguments`-based export, #3748). Exercises RFC-6265
parsing/serialization: object literals with a growing set of
dynamically-assigned optional properties, `switch` dispatch,
`charCodeAt` character classification, ternary-unified object shapes,
and `TypeError`s thrown as normal control flow (invalid cookie names).

## What changed

- `tests/dogfood/cookie-pin.json` — pins `cookie@2.0.1` by canonical npm
  sha1/sha512, same acquisition discipline as acorn/marked/clsx.
- `tests/dogfood/setup-cookie.mjs` — acquisition (pinned tarball, no
  run-time network), mirrors `setup-clsx.mjs`.
- `tests/dogfood/cookie-ops.mjs` — 21 shared ops across all four exports
  (basic parse/stringify, whitespace, percent-encoding, duplicate keys,
  invalid names that throw, every `Set-Cookie` attribute, multi-attribute
  combinations).
- `tests/dogfood/cookie-harness.mjs` — acquire → compile (unmodified
  pinned source) → validate → run+diff every op (JSON-normalized value
  comparison, "both threw" counted as equal) → report. Robust to a red
  surface: a non-validating binary or a divergent/thrown op is RECORDED,
  never crashes the harness.
- `tests/dogfood/cookie.test.ts` — vitest wrapper, opt-in
  (`DOGFOOD_COOKIE=1`), gates on a real regression floor.
- `pnpm run dogfood:cookie` script; `.gitignore`/`biome.json` entries for
  the gitignored `.cookie/` extraction dir.

## Result: 18 / 21 ops match

Three real divergences found, all the SAME root cause — filed
separately (properly scoped, not fixed here — this issue is the
harness): **#3750** — `parseSetCookie` silently drops every attribute
(`httpOnly`, `path`, `secure`, `domain`, ...) that gets assigned onto the
result object dynamically inside the attribute-parsing loop/switch;
the base `{name, value}` shape (no attributes) round-trips correctly,
but the moment any attribute-setting branch runs, that property is
completely absent from the result — no crash, no wrong type, the write
just doesn't persist. Reduced to a minimal repro fully independent of
cookie; also cross-referenced against #3747 (dayjs) and #3749 (clsx) —
three different symptoms of what looks like the same general
"object/array shape representation" gap, found via three different npm
packages in the same session, each needing its own investigation.

## Acceptance criteria

- [x] `pnpm run dogfood:cookie` acquires the pin, compiles cookie
      unmodified, runs the real compiled exports directly against native
      cookie (same pinned tarball, zero version skew), and emits a
      structured report (`tests/dogfood/report/cookie-surface.json`,
      gitignored).
- [x] Vitest wrapper passes; harness is robust to a red op (records,
      does not crash).
- [x] The three real divergences found are triaged (confirmed to share
      one root cause) and filed as a single issue (#3750), not fixed
      inline.
