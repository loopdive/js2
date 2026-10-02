---
id: 6748
title: "S3-g: the regime-compiled Temporal provider links but every Temporal row dies with a module-init exception"
status: ready
created: 2026-09-29
updated: 2026-09-29
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, linking, testing
language_feature: temporal
goal: architecture
sprint: current
parent: 5385
depends_on: [6707]
related: [4628, 5353, 5383, 6706]
---

# #6748 — S3-g: regime Temporal provider throws at module init

Slice S3-g of the #5385 "Implementation Plan v2". After S3-e (#6707) the
native-first measurement lane compiles and links a regime-compiled
`@js-temporal/polyfill` provider (S4 part B). Nightly 36399520787
(2026-09-28, main @ `cb50f21b90`):

| lane       | Temporal rows passing |
| ---------- | --------------------: |
| host       |                   581 |
| standalone |                   170 |
| **regime** |                 **0** |

Every regime Temporal row now reports `wasm exception during module init`
(4,529 rows across `ZonedDateTime` 901, `PlainDateTime` 771, `PlainDate`
652, `Duration` 540, `PlainYearMonth` 509, `PlainTime` 492, `Instant` 465,
`PlainMonthDay` 199); before S3-e the same rows failed `Temporal is not
defined`. Net count unchanged, but the failure moved from "not linked" to
"linked and throws before the test body runs", which is the worse state:
it also masks every real Temporal defect behind one opaque label (the
#3535 lesson).

## What to find

The provider is compiled once (`scripts/prewarm-temporal-provider.mjs
--target host --semantic-providers native-first`) with `hostBridge:
"always"`, then each test row is compiled against it and instantiated with
`instantiateLinkedProviders` (`src/linked-provider-runtime.ts`). The
standalone lane's host-free provider works (170 rows), so the polyfill's
own init is sound under the native regime; what differs for the regime
build is the JS environment: the shared `env.__exn` tag (S3-e), the
`__register_*` instance wiring and the boundary adapters the provider's
module-init reaches.

1. Reproduce locally with the S4 recipe: build the regime provider, then
   `TEST262_SEMANTIC_PROVIDERS=native-first TEST262_PATH_FILTER="built-ins/Temporal/Now/" TEST262_WORKERS=1 pnpm run test:262`
   and read the timestamped JSONL. The worker prints the native exception
   render (`__exn_render_*`, #2962) when the module exports it — under the
   regime `hostBridge` is `"always"`, so it should; if the render is empty,
   that is finding #1 (fix the render path before anything else, otherwise
   the whole cluster stays opaque).
2. With the message in hand, classify: (a) provider init throws (e.g. a
   `Symbol`/`Intl`/`Date` provider arm that is host-assisted in the
   consumer's environment but native in the provider — the two halves must
   agree), (b) consumer init throws when wiring the provider's exports
   (decoder registry / `registerLinkedProviderModule` in
   `src/linked-provider-runtime.ts`, the #5225 rec-group registry), or (c)
   the shared exception tag itself (a provider throw caught by the wrong
   tag identity).
3. Fix at the root of whichever it is. Standalone and host outputs must
   stay byte-identical (the provider is a separate artifact; the consumer
   compile for the two other lanes must not change).

## Acceptance

- [ ] The module-init exception is rendered with a real message in the
      JSONL (no opaque `wasm exception during module init` rows in
      `built-ins/Temporal/Now/`).
- [ ] `built-ins/Temporal/Now/` under the regime: ≥ the standalone lane's
      pass count for the same folder (record both).
- [ ] Nightly after merge: regime Temporal passes ≥ 170 (standalone's
      count); the `wasm exception during module init` bucket outside
      Temporal does not grow.
- [ ] `tests/issue-4396-target-profile.test.ts` byte-identity green;
      standalone/host lanes unchanged.
