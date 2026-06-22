---
name: project_2571_native_method_generator_this_as_param
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

#2571 (PR #1872): class generator methods (`class C { *m(){ yield … } }`) leaked
the eager-buffer host generator runtime (`__gen_*`) → validate-but-can't-
instantiate standalone. Free `function*` was already native.

**Key technique — `this` is just a leading param.** The native generator state
machine (`src/codegen/generators-native.ts`, #1665/#2170/#2171) already persists
params in the state struct (`param_<name>` fields after the 4-word header) and
rehydrates them as named locals in the resume function. So an instance method
generator threads its receiver as a synthetic leading param named `"this"`
(`param_this` field) — then `this.x` reads resolve via the existing
`localMap.get("this")` with **no new state-struct field kind**. Static methods
have no receiver (no synthetic param). The `.next()/.return()/.throw()` dispatch
is already representation-agnostic — the entire gap is the factory side.

Implementation (3 sites): `isNativeGeneratorCandidate` widened to
`GeneratorDecl = FunctionDeclaration | MethodDeclaration` (THE single source of
truth — `registerNativeGenerator` AND `sourceNeedsGeneratorHostImports` both
consult it). `registerNativeGenerator` gains `synthesizedThis` (prepends `"this"`
to `paramNames`, caller passes `paramTypes=[receiverType,...]`). The factory
`compileNativeGeneratorFunction` must read `info.paramTypes.length` params (NOT
`decl.parameters.length`) so the synthetic `this` at wasm param 0 lands in
`param_this`. `class-bodies.ts` collection pass registers the native generator
(under `classMemberFuncKey`, `synthesizedThis=!isStatic`) and sets the method
result type to the `$GenState_*` ref (mirrors `declarations.ts:2499`).

**#2581 (PR #1873) extended this to OBJECT-LITERAL method generators**
(`const o = { *m(){} }`). Surprise: it was simple, NOT the feared
closures.ts/`__current_this` rework. The object-literal method **body func ALSO
leads with a `this` struct param** (`methodFctxParams[0] = (ref structTypeIdx)`,
literals.ts) — the `__current_this` is only the *trampoline*'s receiver
resolution; the underlying body func has the struct param. So the same
synthetic-`this` model + closure trampoline carrying the `$GenState` ref worked
directly. Fix: candidate-gate admits `ts.isObjectLiteralExpression(decl.parent)`;
literals.ts registers the native gen at the method collection site keyed by the
per-literal func identity (`${fullName}__lit${forkIdx}` when a
`literalMethodFuncIdx` fork exists, so forked siblings get distinct `$GenState`s)
and routes the body emit through the factory. NOTE: two SAME-NAME same-shape
object literals dedup to one method func (last body wins) — pre-existing, identical
for non-generators; not a generator bug.

**A method bails to host** (keeps the eager-buffer path, valid Wasm) when:
computed/string name, parent is NEITHER class NOR object-literal, reads
`arguments`, uses `super.*`, or CAPTURES an enclosing binding (#2203 — no capture
slot). Put ALL these bail conditions IN the candidate gate so registration +
host-import gating agree — a mismatch (un-forcing host for a method you don't
route native) bakes an undefined funcidx → invalid wasm.

All guards `(ctx.standalone || ctx.wasi)`-gated → gc/host byte-identical. Broad-
impact (generator lowering + host-import gating) → validate via merge_group, not
a scoped sweep. See [[project_standalone_shard_eject_stale_base_first]].
