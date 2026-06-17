// (#2023) `new.target` support.
//
// `new.target` is the constructor that `new` was invoked on. Inside a derived
// chain it stays the *outermost* (derived-most) class, because `super()` does
// not start a fresh construction — it continues the same one. The compiler
// emits a class body **once** and reuses it both for `new C()` and for the
// `super()` path of a subclass, so the value genuinely varies at runtime and
// cannot be folded to a per-constructor constant (the #189 `i32.const 1` stub
// did exactly that, which is the bug this fixes).
//
// Strategy — a single mutable i32 module global holds the class-id of the class
// named at the outermost `new` site:
//   * each local class gets a stable 1-based i32 id (`classNewTargetIds`);
//   * `new C(...)` sites save the previous global, set it to C's id right
//     before the `_new` call (args already on the stack), and restore it after
//     the call returns (so nested `new` inside a ctor body nests correctly);
//   * `super(...)` calls `_init` directly and deliberately does NOT touch the
//     global, so the derived-most id is preserved through the super chain;
//   * `new.target` inside a ctor reads the global; `new.target === SomeClass`
//     lowers to an i32 compare against that class's id.
//
// All of this is gated on `ctx.usesNewTarget` (a cheap AST pre-scan), so a
// program that never mentions `new.target` emits none of the machinery and the
// class call sites are byte-for-byte unchanged.

import { ts, forEachChild } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import type { Instr } from "../ir/types.js";

/**
 * Pre-scan the source for any `new.target` meta-property. Sets
 * `ctx.usesNewTarget`. Cheap structural walk; runs once before body compilation.
 */
export function scanForNewTarget(ctx: CodegenContext, root: ts.Node): void {
  const visit = (node: ts.Node): void => {
    if (ctx.usesNewTarget) return;
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.NewKeyword && node.name.text === "target") {
      ctx.usesNewTarget = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(root);
}

/**
 * Assign (or look up) the stable 1-based class-id for a local class. Ids start
 * at 1 so the global's `0` initial value never matches a real class — which
 * keeps `new.target === SomeClass` false when read outside any construction.
 */
export function getOrAssignClassNewTargetId(ctx: CodegenContext, className: string): number {
  let id = ctx.classNewTargetIds.get(className);
  if (id === undefined) {
    id = ctx.classNewTargetIds.size + 1;
    ctx.classNewTargetIds.set(className, id);
  }
  return id;
}

/**
 * Allocate the mutable i32 `new.target` class-id global if not already present.
 * Returns its absolute Wasm global index. Only call when `ctx.usesNewTarget`.
 */
export function ensureNewTargetGlobal(ctx: CodegenContext): number {
  if (ctx.newTargetGlobalIdx !== undefined) return ctx.newTargetGlobalIdx;
  const absIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__new_target_classid",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  ctx.newTargetGlobalIdx = absIdx;
  return absIdx;
}

/**
 * Emit the load of the current `new.target` class-id (an i32). Only meaningful
 * inside a constructor.
 */
export function emitNewTargetClassId(ctx: CodegenContext, body: Instr[]): void {
  const idx = ensureNewTargetGlobal(ctx);
  body.push({ op: "global.get", index: idx } as Instr);
}

/**
 * Emit `i32.const <classId>; global.set __new_target_classid`. Call this right
 * before pushing the constructor `call` instruction (args already on the
 * stack). No-op when `new.target` is unused.
 */
export function emitSetNewTargetBeforeCall(ctx: CodegenContext, body: Instr[], className: string): void {
  if (!ctx.usesNewTarget) return;
  const globalIdx = ensureNewTargetGlobal(ctx);
  const classId = getOrAssignClassNewTargetId(ctx, className);
  body.push({ op: "i32.const", value: classId });
  body.push({ op: "global.set", index: globalIdx } as Instr);
}
