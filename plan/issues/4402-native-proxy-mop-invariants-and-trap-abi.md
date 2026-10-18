---
id: 4402
title: "Complete native Proxy MOP invariants and dynamic trap-result ABI"
status: done
created: 2026-08-13
updated: 2026-10-18
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: runtime, codegen, conformance
language_feature: proxy
goal: correctness
sprint: current
parent: 4397
depends_on: [4397]
required_by: [4395, 4401]
horizon: l
related: [1100, 1355, 2046, 3031, 3371, 3981]
---
# #4402 — Complete native Proxy MOP invariants and trap-result ABI

## Objective

Finish the native Proxy meta-object protocol after #4397's provider/boundary
migration. Proxy state and invariants stay in Wasm. This issue must not repair
failures by restoring the compatibility `Proxy` host provider.

## Current verified baseline

The focused migration and construction lanes pass:

- native ProxyCreate rejects primitive target/handler values;
- native arrows are callable but not constructible;
- ordinary native function expressions support `[[Construct]]`;
- `apply` and `construct` traps receive the specified arguments;
- an absent trap forwards to a native target or the exact admitted JS target;
- a primitive construct-trap result throws;
- explicit-receiver `Reflect.get` reaches accessors and nested Proxies.

The widened 2026-08-13 run initially passed 148/156 assertions. Two failures
were policy-gate rejections of unrelated legacy JS-array imports and one was an
existing Reflect.construct conformance gap. The five older delete/descriptor
assertions were isolated separately.

Four of those five Proxy-core residuals are now fixed without changing the JS
boundary:

1. A source binding used as a native Proxy target is constructed on the native
   dynamic object carrier from the start. The target binding and Proxy therefore
   share one object; no JS object or shadow copy is introduced. Dynamic reads
   retain the externref result carrier, so a missing post-delete property is
   `undefined` rather than a scalar-unboxing artefact.
2. A closed compiler struct received dynamically by
   `Object.getOwnPropertyDescriptor` is reflected through the native
   has-own/get ladders. Descriptor-query initializers also remain externref
   locals even when an explicitly `any` binding is later used numerically.
   The descriptor was not being lost by `__apply_closure`; closed-struct
   reflection and usage-based local narrowing were the two actual causes.

The fifth failure was a wrong fixture. The test compiled an exported ES module,
so a falsy Proxy delete result must raise the strict-mode TypeError required by
§13.5.1.2. The corrected coverage separately checks strict `delete` and
`Reflect.deleteProperty`, which returns the falsy trap result without throwing.
That control also exposed and fixed a narrow Reflect target guard: `$Proxy` is a
sibling Wasm carrier rather than a `$Object` subtype, but both are ECMAScript
Objects. The guard now accepts `$Proxy` and continues through the native MOP;
it does not admit the value to the JavaScript boundary.

The focused delete/descriptor/Reflect run now passes 49/49 assertions. The
native-first host-import ratchet remains at 33 probes, 379 total imports, zero
legacy semantic imports, and zero unknown imports.

## Acceptance criteria

- [x] A direct source binding used as a Proxy target and the Proxy itself share
      one native dynamic object carrier; post-mutation reads through that binding
      do not use stale closed-struct assumptions or a copied shadow object.
- [x] A missing Proxy-target property compares equal to `undefined` independent
      of which unrelated helpers the module registers.
- [x] Descriptor results survive Proxy trap dispatch without losing properties
      or carrier tags; dynamic closed-struct reflection and descriptor-result
      local typing preserve the native object carrier.
- [x] Delete fixtures distinguish the module/strict operator from
      `Reflect.deleteProperty`: strict falsy deletes throw, while Reflect returns
      false.
- [x] Proxy invariants are enforced for non-configurable/non-extensible targets,
      duplicate or missing `ownKeys`, descriptor compatibility, prototype
      consistency, and delete/define success claims.
- [x] The standalone, native-first JS, and admitted-JS-boundary lanes agree on
      values and catchable errors with zero legacy/unknown imports in
      native-first builds.

## Non-goals

- Reintroducing `env::__proxy_create` in native-first builds.
- Copying JS targets, handlers, descriptors, argument lists, or results into a
  shadow object model.
- Treating policy-gate rejection of an unrelated unmigrated family as a Proxy
  semantic failure.

## Completion checkpoint — 2026-10-18

Later native-object work completed the invariant machinery that this umbrella
issue still described as open:

- `src/codegen/object-runtime-proxy-invariants.ts` validates descriptor
  compatibility for `getOwnPropertyDescriptor`, `defineProperty`, `has`, `get`,
  `set`, and `deleteProperty`, including non-configurable and non-extensible
  targets.
- `src/codegen/object-runtime-proxy.ts` validates prototype consistency,
  extensibility claims, `ownKeys` element types/duplicates, and exact key sets
  for non-extensible targets.
- The later composed Proxy array-like dispatch also closed #6506's deliberately
  pinned revoked/live array-like gaps without restoring the unsafe competing
  `body.unshift()` on `__extern_length`; the stale #6494 pins now expect the
  correct TypeError and live length.

`tests/issue-4402-native-proxy-invariants.test.ts` is the umbrella acceptance
matrix. It exercises nine invariant lies in both standalone and native-first JS:
fixed-value `get`, duplicate/missing/extra `ownKeys`, hidden descriptors,
`getPrototypeOf`/`setPrototypeOf` consistency, and false delete/define success
claims. A third lane repeats the same nine checks over a caller-owned JS object
with a non-configurable property, custom prototype, and non-extensible state.
That proves the native Proxy consults the original object's descriptor and
integrity state through the value adapter rather than a copy.

Verification on `origin/main` @ `730b984168` plus this test/documentation change:

- focused Proxy cluster: **42/42** assertions across #4402, #4618, #6494,
  #6651 U3/V1, and #6766;
- host-import policy ratchet: **33** native-first probes / **452** imports,
  **0 legacy-semantic**, **0 unknown**; compatibility control remains
  non-vacuous at **23** legacy imports;
- standalone acceptance modules import **0** host functions; the native-first
  and admitted-boundary lanes retain only typed value-adapter imports.

Local Node 24 requires `--experimental-wasm-exnref` for these emitted EH bodies.
Because the repository's Vitest fork `execArgv` does not inherit that flag, the
focused verification used the single-thread pool; this is runner plumbing, not
a semantic waiver.
