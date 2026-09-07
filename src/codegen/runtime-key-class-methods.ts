// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5358) A RUNTIME-key read of a compiled class instance must reach the
// class's prototype methods — `h[k]`, `Object.getPrototypeOf(h)[k]`,
// `C.prototype[k]`, and `k in h` on an `any` receiver.
//
// ## What was actually missing
//
// `h[k]` lowers to the host `__extern_get(h, k)`. The host side is NOT the gap:
// `_safeGet` already asks `_resolveClassMember`, which resolves a prototype
// method through the compiled `__member_kind_<key>` / `__class_call_<key>_<n>`
// bridges and hands back a callable that honours an explicit `this`
// (`class-method-host-bridge.ts`, #5237) — exactly the unbound-method shape
// marked's `a.call(r, c)` needs. Measured: forcing `__member_kind_preprocess`
// into a module (via an unrelated NAMED dynamic call) made `h["preprocess"]`
// read `function` and `a.call(h, "x")` run the method.
//
// Those bridges are emitted only for keys in `ctx.hostDynamicClassMethodNames`,
// and every writer of that set is a NAMED call / write / class-value crossing.
// A runtime key has no name to register, so a class whose methods are never
// dynamically called BY NAME publishes no bridge at all, the resolver misses,
// and the read answers `undefined`. `__register_prototype` cannot help: it
// registers the method-NAME csv (`_prototypeMethodNames`), nothing callable.
//
// ## What this module does
//
// It registers the DEMAND a runtime-key read implies, so finalization emits
// the bridges the host resolver already knows how to use:
//
//   - a `$ClassName` struct receiver → the method names of that class family
//     (the class itself, its ancestors — inherited methods — and its
//     descendants, because a `Base`-typed binding may hold a `Derived`);
//     several classes can share one canonicalized struct type, so every class
//     mapped to the receiver's typeIdx seeds the family;
//   - an `externref` receiver (an `any`, a prototype singleton read through
//     `C.prototype`, a `getPrototypeOf` answer) → every class's method names,
//     because nothing narrows which instance it holds.
//
// The demand is kept in `ctx.runtimeKeyClassMethodNames`, SEPARATE from
// `hostDynamicClassMethodNames`, on purpose: the latter also relaxes the
// exact-arity admission of `closed-method-dispatch.ts` for NAMED calls
// (`hostDynamic`), and a bare read must not move how a named call lowers.
// Only the bridge emitters consume the union (`hostBridgeMethodKeys`).
//
// Host-lane only. Standalone answers runtime-keyed class members through its
// own `__class_proto_lookup` (#5195 Step 1.7) and keeps byte-identical output.

import type { CodegenContext } from "./context/types.js";

/** Guard against a malformed `classParentMap` cycle while walking. */
const MAX_CLASS_DEPTH = 64;

/**
 * A member name the host bridge surface can carry. Symbol-keyed members have
 * their own dispatchers (`__call_@@iterator`), private names never cross to the
 * host, and a runtime-keyed member's synthetic `__cmdyn$` name is a
 * standalone-lane spelling with no host twin.
 */
function bridgeableMemberName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "constructor" &&
    !name.startsWith("@@") &&
    !name.startsWith("__priv_") &&
    !name.startsWith("__cmdyn$")
  );
}

function ancestorsOf(ctx: CodegenContext, className: string): string[] {
  const out: string[] = [];
  let current = ctx.classParentMap.get(className);
  for (let depth = 0; current !== undefined && depth < MAX_CLASS_DEPTH; depth++) {
    out.push(current);
    current = ctx.classParentMap.get(current);
  }
  return out;
}

/** `seeds`, plus every ancestor and every descendant of a seed. */
function classFamily(ctx: CodegenContext, seeds: readonly string[]): Set<string> {
  const family = new Set<string>(seeds);
  for (const seed of seeds) for (const ancestor of ancestorsOf(ctx, seed)) family.add(ancestor);
  for (const className of ctx.classSet) {
    if (family.has(className)) continue;
    if (ancestorsOf(ctx, className).some((ancestor) => seeds.includes(ancestor))) family.add(className);
  }
  return family;
}

/**
 * Record that a runtime-key read may need the prototype methods of a compiled
 * class instance, so finalization publishes their host bridges.
 *
 * `receiverStructTypeIdx` is the receiver's struct type when the read site
 * knows it is a `$ClassName` struct; `undefined` for an externref receiver.
 * `knownKey` narrows the demand to one name when the key folds statically
 * (`const k = "m"; h[k]`) — nothing else in the family is published for it.
 * A struct receiver that is not a class instance (an object literal, a tuple)
 * registers nothing: its callable members are struct fields the read already
 * reaches.
 */
export function recordRuntimeKeyClassMethodRead(
  ctx: CodegenContext,
  receiverStructTypeIdx: number | undefined,
  knownKey?: string,
): void {
  if (ctx.standalone || ctx.wasi || ctx.classSet.size === 0) return;
  let classes: Iterable<string>;
  if (receiverStructTypeIdx === undefined) {
    classes = ctx.classSet;
  } else {
    const seeds = [...ctx.classSet].filter((className) => ctx.structMap.get(className) === receiverStructTypeIdx);
    if (seeds.length === 0) return;
    classes = classFamily(ctx, seeds);
  }
  for (const className of classes) {
    for (const member of ctx.classMethodNames.get(className) ?? []) {
      if (!bridgeableMemberName(member)) continue;
      if (knownKey !== undefined && member !== knownKey) continue;
      ctx.runtimeKeyClassMethodNames.add(member);
    }
  }
}

/**
 * The member names the host-bridge emitters must publish: the NAMED dynamic
 * demand plus the runtime-key demand. Consumed only by the bridge emission in
 * `index.ts` (`__class_call_*` / `__member_kind_*` / their numeric-boxing and
 * rest-parameter prerequisites) — never by closed-method-dispatch.
 */
export function hostBridgeMethodKeys(ctx: CodegenContext): Set<string> {
  if (ctx.runtimeKeyClassMethodNames.size === 0) return ctx.hostDynamicClassMethodNames;
  return new Set<string>([...ctx.hostDynamicClassMethodNames, ...ctx.runtimeKeyClassMethodNames]);
}
