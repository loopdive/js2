---
id: 4402
title: "Complete native Proxy MOP invariants and dynamic trap-result ABI"
status: in-progress
created: 2026-08-13
updated: 2026-08-13
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
- [ ] Proxy invariants are enforced for non-configurable/non-extensible targets,
      duplicate or missing `ownKeys`, descriptor compatibility, prototype
      consistency, and delete/define success claims.
- [ ] The standalone, native-first JS, and admitted-JS-boundary lanes agree on
      values and catchable errors with zero legacy/unknown imports in
      native-first builds.

## Non-goals

- Reintroducing `env::__proxy_create` in native-first builds.
- Copying JS targets, handlers, descriptors, argument lists, or results into a
  shadow object model.
- Treating policy-gate rejection of an unrelated unmigrated family as a Proxy
  semantic failure.
