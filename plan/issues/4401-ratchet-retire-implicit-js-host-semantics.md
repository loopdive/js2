---
id: 4401
title: "Ratchet and retire implicit JavaScript-host semantic fallbacks"
status: in-progress
created: 2026-08-13
updated: 2026-08-20
priority: high
feasibility: hard
reasoning_effort: high
task_type: refactor
area: runtime, host-interop, testing, cli
language_feature: runtime-helpers
goal: architecture
sprint: current
parent: 4395
depends_on: [4397, 4399]
horizon: l
related: [1524, 1932, 1934, 2094, 2879, 2961, 3526, 3681, 4035, 4382, 4573, 4576, 4577]
---
# #4401 — Ratchet and retire implicit JS-host semantic fallbacks

## Objective

Turn migration intent into an enforceable, monotonic retirement program. The
current host mode remains available during the transition, but its semantic
surface cannot grow invisibly.

## Inventory and metrics

Classify every host runtime entry as one of:

- platform capability;
- JS/Wasm value adapter;
- instance/lifecycle support;
- measured host accelerator with native fallback;
- legacy semantic fallback to retire;
- unknown, which blocks a green retirement claim until classified.

Track at least:

- legacy semantic import names and call sites;
- affected source/test262/npm-package population with denominators;
- static and measured dynamic host crossings;
- adapter and runtime code size;
- JS-value round-trip coverage;
- native/host behavior divergences.

## Compatibility transition

1. Keep existing `gc`, `standalone`, and `wasi` spellings as aliases.
2. Add an explicit native-first policy after enough #4397 families are green.
3. Make new semantic host fallbacks a CI failure unless they declare a native
   fallback, owner, measurement, and retirement condition.
4. Flip the default only after representative product/npm workloads and the
   official conformance lanes meet the published bar.
5. Retain explicit host accelerators and platform providers; remove only the
   implicit semantic dependency.

## Acceptance criteria

- [x] A checked-in machine-readable inventory covers every runtime import and
      can say `unknown`; unknown is failure, not implicit approval.
- [x] CI ratchets legacy semantic imports, resolver dispatch arms, runtime LOC,
      and representative host crossings without conflating them with value
      interop or explicit platform capabilities.
- [ ] Each retirement demonstrates value/error parity plus JS interop parity.
- [ ] Default-policy criteria include test262 denominators, representative npm
      compatibility, binary/startup/performance measurements, and an explicit
      rollback switch.
- [ ] Documentation calls the modes compatibility profiles rather than two
      independent ECMAScript implementations.
- [ ] The final JS adapter can host a native-semantic module even when that
      module imports zero JS semantic helpers.

## Out of scope

- Setting a date-based default flip without evidence.
- Counting import removal as success when behavior becomes opaque, vacuous, or
  silently wrong.
- Removing explicit platform capabilities or the JS value boundary.

## Implementation progress — 2026-08-13

- `src/host-import-policy.ts` exhaustively classifies every typed
  `ImportIntent`; a new intent cannot compile until assigned policy. Catch-all
  builtin names and unknown namespaces remain explicitly `unknown`.
- Successful `CompileResult`s expose a deterministic `hostImportInventory`
  covering `env`, `wasm:js-string`, constant pools, WASI, Node, and linked
  provider imports with class, family, owner, native-fallback fact, and reason.
- The native-string JS pilot is ratcheted to zero `legacy-semantic` and zero
  `unknown` imports while retaining `platform-capability` console and
  `value-adapter` string marshaling entries.
- Native-first strings, boxing/`typeof`, open-object operations, and JSON now
  run with zero legacy-semantic imports in the focused JS-host suite. The
  generated `__str_*` bridge remains classified as boundary interop rather than
  being mistaken for semantic-host debt.
- Native dynamic equality no longer imports `__host_loose_eq` in either direct
  or IR lowering. Explicit JS-owned boundary-object property and own-key imports
  are classified as `value-adapter` family `boundary-object`, so the ratchet
  does not confuse retained host interop with semantic fallback debt.
- Compile results now include deterministic totals by classification and
  family. Runtime import wrappers expose opt-in per-import crossing counters;
  the native-first boundary test proves object-get, object-call, and callback
  crossings occur while its static inventory remains at zero legacy and zero
  unknown imports.
- The zero-unknown ratchet exposed a remaining `__throw_type_error` registration
  in boundary deletion. Native-first now routes that guard through the
  in-module Error provider; the legacy compatibility lane remains unchanged.
- The schema-versioned compile explanation exposes the same deterministic
  import totals and capability/provider records through API and CLI JSON, so
  future CI baselines do not need to scrape WAT or runtime import spellings.
- `check:host-import-policy` is now a required CI quality gate. Its native-first
  family probes cover strings/JSON/Symbol/arrays, RegExp, collections, Promise,
  Date, BigInt, Number, objects, Proxy, and explicit boundary operations. All
  must compile with zero `legacy-semantic` and zero `unknown` imports while
  boundary get/apply remain typed `value-adapter` imports. A compatibility-
  profile control must still produce legacy imports, preventing a vacuous green
  result.
- The Promise probe includes an actual `.then` continuation rather than a
  foldable construction. It exposed the remaining `Promise_*` host-semantic
  imports; native-first now emits none of them. The two JS Promise settlement
  hooks are explicitly classified as `value-adapter` family
  `boundary-promise`, so the gate preserves interop without forgiving semantic
  fallback.
- The focused native-first lane now also retires legacy Symbol registration and
  `__make_iterable` use. Stable Symbol mapping and live Wasm-vector writeback
  remain explicit boundary behavior rather than being counted as semantic host
  dependencies.
- The CI ratchet now runs 33 non-vacuous native-first probes (372 total imports
  at the current baseline). In addition to the core array pipeline, objects,
  and text globals, dedicated probes cover TypedArray and DataView state,
  descriptors/prototypes, object-rest/destructuring, Function bind/call/apply,
  errors, generators/iterators, Promise combinators, dynamic RegExp,
  Map/Set iteration, Reflect, dynamic operators, and the Proxy MOP. The bind
  probe requires its dynamic caller-owned function path to retain a typed
  callback adapter while compiled bind chains remain native. Every probe
  rejects legacy or unknown imports; the compatibility control still reports
  19 legacy semantic imports. Dedicated BigInt-formatting, `Proxy.revocable`,
  and RegExp-split/array-join/`String.raw` probes prevent those newly retired
  fallbacks from returning.
- Native-first compilation now has a repository-wide post-codegen publication
  gate in addition to the representative probe ratchet. Any actual
  `legacy-semantic` or `unknown` import fails compilation before binary, WAT,
  or adapter-helper publication, with deterministic import/owner diagnostics.
  A Promise-subclass regression case proves both classes are rejected and that
  the host-assisted compatibility profile remains available.
- The low-level adapter repeats this defense when `ambientCompatibility` is
  false, so a hand-built or stale manifest cannot bypass compiler enforcement
  and re-enable a compatibility semantic helper. Typed capabilities, value
  adapters, lifecycle support, and named accelerators remain bindable.
- Capability, ambient-compatibility, and an initial compatibility-semantic
  dispatcher have been extracted from `runtime.ts`. The measured move removes
  536 monolith lines, adds 441 owned-adapter lines, and reduces total runtime
  source by 95 lines; this is the first checked resolver/LOC reduction datum.
- `plan/audit/host-import-policy-baseline.json` now checks those measurements in
  CI: at least 33 non-vacuous probes, at most 379 native-first imports, exactly
  zero semantic/unknown debt, a non-vacuous compatibility window, and monotonic
  maxima for `runtime.ts`, `resolveImport` lines/cases, and the owned adapter
  surface. The gate reports the live metrics in its JSON output.
- The Proxy/boundary probe now requires callable classification and construction
  imports in addition to get/apply. The seven-import total increase and
  fourteen-line adapter increase are intentional value-boundary surface. Six
  imports retain that surface across the existing probes; one makes the Proxy
  construct probe non-vacuous. Together they enable identity-preserving Proxy
  forwarding to a caller-owned JS constructor and do not forgive any legacy or
  unknown semantic provider.
- #4573 extracts standalone timer binding and authenticated callback authority
  from the generic adapter/runtime surfaces. Their two explicit-provider leaves
  are tracked by a separate 306-line maximum, while the existing runtime,
  resolver, and generic-adapter ceilings remain unchanged. This keeps the
  capability visible without conflating it with implicit semantic-host debt.
- The completed #4576 checkpoint applies the same rule to standalone DOM.
  The exact `dom@1` provider and its authenticated native-string bridge add
  **583** explicit-capability lines, moving that separately tracked surface
  from **306 → 889** lines. The generic owned-adapter measure remains **790**,
  `resolveImport` remains **7,216** lines and **15** cases, and `runtime.ts` is
  **17,099** lines under its unchanged **17,100** ceiling. The live gate still
  reports 33 native-first probes, 393 imports, **0 legacy-semantic**, **0
  unknown**, and the non-vacuous compatibility control at 19 legacy imports.
  Builtins imports exactly eight signature-checked DOM operations; none is
  forgiven as implicit semantic-host debt. The guarded runtime benchmark records
  parity within noise, and the final full-gate sweep is green.
- The #4577 Calendar checkpoint extends the separately counted explicit
  provider surface by 305 lines: 186 lines of exact DOM interaction/callback
  authority in the existing provider leaves, a 58-line clock adapter, and a
  61-line compiler-certified capability-authority leaf. The complete
  explicit-capability measure is therefore **1,194** lines (889 → 1,194),
  while the generic owned-adapter surface remains below its existing ceiling.
  `runtime.ts` measures **17,095** lines and `resolveImport` remains **7,216**
  lines / **15** cases. Native-first
  continues to report 33 probes, zero legacy-semantic imports, and zero unknown
  imports; the compatibility control remains non-vacuous.
- The manifest is deliberately not runtime authority. It describes the exact
  `dom@1`, `dom-interaction@1`, and `clock@1` provider/ABI selection, but
  compiler-owned import provenance plus the registry's complete-import check
  must first certify the artifact. DOM string and callback crossings then bind
  to the exact root, instance/export view, manifest global, binding table, and
  private callback brand. Forged, copied, relabeled, donor, or incomplete
  manifests cannot grant capability authority. This keeps declarative
  observability separate from bearer credentials.

Still open: product/Test262/npm denominators, binary/startup/performance
budgets, and the final default-policy evidence gate.
