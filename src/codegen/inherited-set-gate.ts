// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4602) Per-key gate for the #4504 inherited-[[Set]] descriptor machinery.
//
// #4504's pre-scan used one module-wide boolean: ANY accessor declaration or
// suspicious `defineProperty` anywhere demoted EVERY presence-tracked member
// write (and absent-slot read) in the module to the generic runtime, whose
// closed-struct arm resolves the key by a string-equality ladder and runs the
// nearest-descriptor chain walk. On acorn's 226KB bundle — nine getter-only
// prototype accessors, millions of unrelated `node.start = …` first writes —
// that cost ~1.7x end-to-end (#4602 measurements).
//
// The repair is precision, not a semantics change. A [[Set]] of key `p` can
// only be affected by a descriptor FOR `p`; if no construct in the module can
// install a suspicious descriptor named `p`, the pre-#4504 direct write IS the
// nearest-descriptor outcome. The scan (array-holes.ts) therefore collects the
// statically-known trigger key names into `ctx.inheritedSetDirtyKeys` and
// reserves the module-wide `ctx.inheritedSetDescriptorDirty` for triggers
// whose key cannot be named (freeze, captured define builtins, computed
// names, dynamic code).
//
// Consumers split two ways:
//  - a compile site with a STATIC property name gates on
//    `inheritedSetAffectsKey` — a clean key emits byte-identical pre-#4504
//    code, a dirty key keeps the full #4504 path;
//  - key-DYNAMIC machinery (the `__extern_set` runtime, proxies, tombstones,
//    vec overlays) activates on `inheritedSetAnyDirty`, so a dynamic set of a
//    dirty key still reaches the shared decision.

import type { CodegenContext } from "./context/types.js";

/**
 * Does any #4504-relevant descriptor trigger exist in this module at all?
 * Key-dynamic machinery (runtime [[Set]] decision, result channel, proxy and
 * tombstone routing) must be reserved and active exactly when this holds.
 */
export function inheritedSetAnyDirty(ctx: CodegenContext): boolean {
  return ctx.inheritedSetDescriptorDirty || ctx.inheritedSetDirtyKeys.size > 0;
}

/**
 * Can a #4504-relevant descriptor exist under this specific property key?
 * Compile sites with a static property name use this; `false` licenses the
 * pre-#4504 direct physical path for that key.
 */
export function inheritedSetAffectsKey(ctx: CodegenContext, key: string): boolean {
  return ctx.inheritedSetDescriptorDirty || ctx.inheritedSetDirtyKeys.has(key);
}
