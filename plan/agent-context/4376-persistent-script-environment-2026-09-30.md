# Persistent AOT Script environment

Required for complete Deno integration, not an alternative acceptance bar.
Sources known at packaging time must execute AOT without an interpreter.

## Measured boundary

At compiler `83442252a6d`, a provider exports its realm, allocation-owner
predicate, Reflect.get and exception tag. Independently compiled untouched
Scripts use `scriptGoal: true` and import that provider. Explicit
`globalThis.published=42` is observed as 42 by the provider. A fresh provider
after `var published=41; published=42` instead observes no value 42. This
rules out missing realm linkage as the var failure's explanation. The live
var value is still held in a private Wasm global. Lexical declarations also
do not persist into later independently compiled Scripts.

`tests/issue-4376-persistent-script-environment.test.ts` has one positive
property-write control and two explicitly expected failures, not three
conformance passes. Remove `.fails` as each real requirement is implemented.

## Representation and ownership

Each Context needs one GlobalEnvironmentRecord with an object record and a
persistent declarative record. Keep Module environment records separate and
do not expose lexical declarations as globalThis properties.

Use canonical mutable lexical cells with binding kind, initialization/TDZ
state and mutability. Object-record var/function bindings must use the actual
property value and attributes. Private Wasm globals cannot remain a second
source of truth. End-of-script mirroring is insufficient: callbacks and
getters can observe writes before the next statement or abrupt completion.

Each compiled Script needs a declaration manifest and execution entrypoint.
Validate all declarations against the Context before any initializer or user
statement. Re-executing source means Script evaluation again, not Module's
once-only initialization. Reject lexical conflicts before effects. A var
redeclaration preserves the existing value until its initializer executes.
Validate restricted global properties and extensibility from actual state.

## Readers and writers that must change together

- `codegen/index.ts` recordSourceGlobalEnvironment currently records names
  for one source/graph. Plan exact declaration identity and distinguish
  persistent Script bindings from module, local and captured bindings.
- `global-var-bindings.ts` seeds undefined while deliberately keeping the
  live value in a private Wasm global. Seeding alone cannot fix persistence.
- `global-function-bindings.ts` can seed a different closure from identifier
  reads. Initialize the same canonical function value for both routes.
- `expressions/identifiers.ts` module/capture routes precede global lookup.
  Select canonical Context cells/properties using exact declaration identity.
- `statements/variables.ts`, `expressions/assignment.ts`, increment,
  destructuring and IR global loads/stores must all use the same binding.
  Extending the narrow toString/valueOf writeback misses other writes.
- `global-environment.ts`, `property-access.ts` and assignment's realm-object
  interception must agree with reflection on values and descriptor semantics.

Publish the shared binding route in source/Program ABI planning before sealing
IR/body ABI. Adding new closures/types in a post-seal seed is not safe. Retain
TypeScript information for computation specialization while shared bindings
preserve arbitrary JS values, callable identity and foreign realm values.

## Completion and exceptions

Keep source unwrapped. Function wrappers change declarations, top-level this,
return grammar and scope. Indirect eval's lexical lifetime is not persistent
Script scope. Neither scriptGoal nor entryScriptGoal provides this feature.

Reuse statement completion rules with an explicit normal result and a separate
exception path carrying the original realm value. Preserve UpdateEmpty,
loop/if/try resets and normal-finally restoration. Do not derive the result
from source text. Pure expression collection and IR discarded expressions must
retain values when completion is observable. Chunked init must thread the
completion across helpers rather than lose it in helper-local registers.

## Verification and packaging

Test independent Scripts in one Context, two Contexts and source executed
twice. Cover var/function/let/const, closures reading/writing between Scripts,
globalThis reflection, initializer-free var redeclaration, lexical conflicts
before effects, TDZ after abrupt initialization, const writes, restricted and
non-extensible properties, descriptors/deletion, strict/sloppy unresolved
references, thrown identity and statement completion/finally. Module controls
must retain private bindings and once-only initialization.

Package known sources AOT with declaration metadata, source hashes, Script
goal and ABI/config identity. Deploy without compiler/interpreter features.
Then rerun unchanged WebIDL (13/17 currently; four scripts rejected before
assertions) and the full unchanged deno_core population. These boundary tests
alone do not prove full integration.
