---
id: 6748
title: "S3-g: the regime-compiled Temporal provider links but every Temporal row dies with a module-init exception"
status: in-progress
assignee: ttraenkler/opus-6748
created: 2026-09-29
updated: 2026-10-06
# 2026-10-06 (#6748): +3 lines — the `__getPrototypeOf` body now asks a regime
# module's wasm peer before the JS boundary (one scratch local + one arm); the
# arm and scratch builders live outside the function, only the wiring is here.
func-budget-allow:
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
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

- [x] The module-init exception is rendered with a real message in the
      JSONL (no opaque `wasm exception during module init` rows in
      `built-ins/Temporal/Now/`). — a provider-init throw now surfaces as
      `Linked provider <ns> threw during module init: <rendered text>`; after
      the fix no Temporal row throws at init at all (0 such rows locally).
- [x] `built-ins/Temporal/Now/` under the regime: ≥ the standalone lane's
      pass count for the same folder (record both). — regime 64/66, standalone
      64/66 (baseline fetched 2026-10-06), host 36/66.
- [ ] Nightly after merge: regime Temporal passes ≥ 170 (standalone's
      count); the `wasm exception during module init` bucket outside
      Temporal does not grow. (The bar is stale: standalone now passes
      4,494/4,603 Temporal rows, host 3,383.)
- [x] `tests/issue-4396-target-profile.test.ts` byte-identity green;
      standalone/host lanes unchanged.

## Progress — 2026-10-06 (opus-6748)

**Rendered text** (regime provider, base source): `TypeError: Cannot access
property on null or undefined at 4:10198` — the polyfill's top-level
`ct = Intl.DateTimeFormat`.

**Root cause — three layers, each hidden by the one before it:**

1. *Render.* The provider's `__module_init` runs inside
   `instantiateLinkedProviders`, before the consumer instance exists, so the
   worker held only a `WebAssembly.Exception` with a GC payload and no
   instance → the opaque label. `wireProviderInstance` now renders a native
   init throw through the provider's own `__exn_render_*` exports and rethrows
   an `Error` (original as `cause`); a payload the provider cannot render
   rethrows unchanged (`src/linked-provider-runtime.ts`).
2. *Init.* The native regime (`ctx.standalone`) reads the bare `Intl`
   identifier as null, as standalone does; only the host-assisted lane binds
   the host `Intl` (`expressions/identifiers.ts`). The standalone provider was
   always given the module-scoped `Intl` shim for this; the regime provider was
   not. `providerSource` now prepends it for any provider whose target profile
   is `nativeRegime` (`src/temporal-provider.ts`). Host and standalone provider
   source/keys unchanged.
3. *Seam.* With init returning, every row failed crossing the link:
   - the runtime wrapped the provider's getter value in a JS host mirror
     (built for host-lane providers); a regime consumer's native MOP can only
     see that as an unadmitted foreign object → `value is not a constructor`.
     A `nativeRegime` provider now passes raw structs, like standalone
     (`noHostMirror`), so the existing `__js2wasm_link_*` peer terminals apply;
   - a regime module in a JS environment has BOTH the JS boundary
     (`__boundary_object_*`) and the wasm peer/reverse hop, but every arm
     picked one with `boundary ?? peer` (written when they were mutually
     exclusive). `new` paired the peer's callable-kind with the boundary's
     construct ("not an admitted JavaScript constructor"); member reads,
     method calls and `getPrototypeOf` asked only the boundary. Now: dynamic
     `new` uses coherent pairs (`constructBoundaryPairs`), and `__extern_get`,
     `__extern_method_call`, `__getPrototypeOf` ask the peer first, then the
     boundary; a regime provider keeps its reverse hop after the boundary arm.
     Modules with one family emit exactly what they did (sha256 A/B below).

**Measurements** (local, `JS2WASM_EVAL_ENGINE=interpreter
TEST262_SEMANTIC_PROVIDERS=native-first`, load 100–400, compile timeouts
retried with an exact manifest):

| folder | regime before | regime after | standalone | host |
| --- | ---: | ---: | ---: | ---: |
| `built-ins/Temporal/PlainTime/` | 0 / 493 | 473 / 493 | 485 / 493 | 374 / 493 |
| `built-ins/Temporal/Now/` | — | 64 / 66 | 64 / 66 | 36 / 66 |

Before = clean `main` @ `e477992708` (every row `wasm exception during module
init`). Standalone/host = `js2wasm-baselines` jsonl fetched 2026-10-06.

**Byte identity:** sha256 of 16 sources (3 dynamic-receiver probes + 13
playground examples) × {gc, standalone, wasi} identical base vs after;
`tests/issue-4396-target-profile.test.ts` green.

**Left for follow-ups (not in this slice):** the 20 PlainTime rows the regime
still fails and standalone passes (options-object `TypeError` on a Symbol,
`Symbol.toStringTag` read across the link, one `typeof PlainTime` →
`"object"`); the remaining `boundary ?? peer` alternations (`__extern_has`,
`Object.keys`/for-in keys, `__apply_closure`, `typeof` callable-kind) which
the measured rows did not need; reading the HOST `Intl` from a JS-environment
regime build (the S3-h declared-global re-key) — until then regime
`Intl`/`toLocaleString` rows read the standalone refusal.
