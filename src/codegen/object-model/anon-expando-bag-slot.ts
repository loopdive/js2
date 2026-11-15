// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7020) The carrier-intrinsic `$bag` slot for OBJECT-LITERAL structs that
 * receive a static expando write — the `__anon_*` half #4241 left open.
 *
 * ## The defect, measured
 * The upstream-suite `expect()` shim builds `const positive = { toBe() {…}, … }`
 * and then writes `positive.not = {…}` (plus `rejects` / `resolves`). `not` is
 * not a declared field of the literal's closed struct, so the write reaches
 * `__extern_set` → `__closure_bag_ensure`, and an `__anon_*` struct had no
 * `$bag` slot: the bag went to the slotless `$ClosurePropEntry` registry, a
 * linked list searched by `ref.eq` and never pruned. Every `expect()` call
 * appended an entry and every ensure-miss walked the whole list, so the cost
 * of call N was O(N): a 2,000-call loop took 125 ms, 4,000 took 1.4 s, and the
 * cookie stringify spec (63,528 tests) never finished inside the 300 s worker
 * deadline (profile: ~60 % of runtime in `__closure_bag_{lookup,ensure}`).
 *
 * ## The fix — the #4241 slot, appended at the END of emission
 * A literal type that is the static receiver of an expando write gets the same
 * trailing `$bag` (mut externref) field that closures and fnctor instances
 * carry, and `__closure_bag_{lookup,ensure}` answer it with one `ref.test` +
 * `struct.get` (the existing SLOTTED arm list). The bag then lives and dies
 * with its literal, so the registry neither grows nor leaks for these
 * carriers.
 *
 * Three phases, because an object-literal struct has many allocation sites
 * (the literal path, spread assembly, host-object record rebuilds, IR
 * lowering) and none of them knows about the slot:
 *
 *   1. RECORD (codegen): `recordObjectLiteralCarrier` maps each compiled
 *      literal to its struct type; `noteStaticExpandoWrite` marks the type
 *      when `x.k = v` targets a binding initialized by such a literal.
 *   2. COMMIT (`fillClosurePropHelpers`): eligible marked types get a FUTURE
 *      field index — the current field count — that the slotted bag arms use.
 *   3. APPEND (just before shape branding, after ALL instruction emission):
 *      the field is appended to a CLONED field array (the `$shapeBrand`
 *      idiom: `ctx.structFields` keeps listing only the real properties, so
 *      no reflective surface — keys, for-in, JSON, spread, descriptor
 *      transcription — can ever see `$bag`) and every `struct.new` of the
 *      type receives a `ref.null extern` operand (the bag is born absent).
 *
 * Appending last is what makes the many allocation sites safe without editing
 * them: each emitted exactly the declared field count, and the field is the
 * last operand, so inserting one null immediately before each `struct.new` is
 * correct by construction. The shape-branding pass runs afterwards and sees the
 * slotted layout, so a type whose new layout collides with another struct is
 * branded nominally distinct (a `ref.test` on the slotted type can then never
 * match a foreign struct and read its field as a bag).
 *
 * ## Eligibility (the `collectAnonymousExpandoDeleteCandidates` screen)
 * Standalone/WASI only (the JS-host lane never reserves these helpers, so gc
 * output is byte-identical); not in a linked module; `__anon_*` name with a
 * single structMap alias; a bare struct (no supertype) that is nobody's
 * supertype (a parent's prefix must not grow); above the `__vec_base` brand
 * anchor; not in `noBrandShapeTypes` (a baked sibling downcast treats it as
 * interchangeable with a same-layout twin, which a new field would break).
 * A type that fails the screen simply keeps the registry route — slower, never
 * wrong.
 */
import type { Instr, StructTypeDef } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import { closureBagField } from "../closures/closure-header-layout.js";
import type { CodegenContext } from "../context/types.js";
import { linkBrandRoleOf } from "../shape-brand.js";
import { walkChildren } from "../walk-instructions.js";

interface AnonBagSlotState {
  /** Object literal → the struct type it was compiled to (latest compile wins). */
  readonly literalCarrier: WeakMap<ts.ObjectLiteralExpression, number>;
  /** Struct types that are the static receiver of at least one expando write. */
  readonly expandoReceivers: Set<number>;
  /** Committed at fill time: type → the field index its `$bag` will occupy. */
  readonly committed: Map<number, number>;
}

const states = new WeakMap<CodegenContext, AnonBagSlotState>();

function stateOf(ctx: CodegenContext): AnonBagSlotState {
  let state = states.get(ctx);
  if (!state) {
    state = { literalCarrier: new WeakMap(), expandoReceivers: new Set(), committed: new Map() };
    states.set(ctx, state);
  }
  return state;
}

/** Phase 1a — remember which struct type an object literal was compiled to. */
export function recordObjectLiteralCarrier(
  ctx: CodegenContext,
  literal: ts.ObjectLiteralExpression,
  structTypeIdx: number,
): void {
  stateOf(ctx).literalCarrier.set(literal, structTypeIdx);
}

function skipTransparent(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Phase 1b — `receiver.<propName> = …` reached the dynamic write path. When the
 * receiver is a binding initialized by an object literal this compilation has
 * already lowered to a struct, mark that struct as an expando receiver.
 */
export function noteStaticExpandoWrite(ctx: CodegenContext, receiver: ts.Expression, propName: string): void {
  const id = skipTransparent(receiver);
  if (!ts.isIdentifier(id)) return;
  const decl = ctx.oracle.variableDeclarationOf(id);
  const init = decl?.initializer ? skipTransparent(decl.initializer) : undefined;
  if (!init || !ts.isObjectLiteralExpression(init)) return;
  const state = stateOf(ctx);
  const typeIdx = state.literalCarrier.get(init);
  if (typeIdx === undefined) return;
  const def = ctx.mod.types[typeIdx];
  // A declared field is a struct.set target, never a bag entry (#4194's
  // "a declared name NEVER reaches the bag" invariant) — nothing to slot.
  if (!def || def.kind !== "struct" || def.fields.some((f) => f.name === propName)) return;
  state.expandoReceivers.add(typeIdx);
}

function isSupertypeOfAny(ctx: CodegenContext, typeIdx: number): boolean {
  return ctx.mod.types.some(
    (t, i) =>
      i !== typeIdx &&
      ((t.kind === "struct" && t.superTypeIdx === typeIdx) ||
        (t.kind === "sub" && (t as { superType?: number | null }).superType === typeIdx)),
  );
}

function isEligible(ctx: CodegenContext, typeIdx: number, anchorIdx: number): boolean {
  if (typeIdx <= anchorIdx) return false;
  const def = ctx.mod.types[typeIdx];
  if (!def || def.kind !== "struct") return false;
  const name = ctx.typeIdxToStructName.get(typeIdx);
  if (!name || !name.startsWith("__anon_") || def.name !== name) return false;
  if (ctx.structMap.get(name) !== typeIdx) return false;
  let aliases = 0;
  for (const idx of ctx.structMap.values()) if (idx === typeIdx) aliases++;
  if (aliases !== 1) return false;
  if (def.superTypeIdx !== undefined) return false;
  if (def.fields.some((f) => f.name === closureBagField().name)) return false; // already slotted
  if (ctx.noBrandShapeTypes.has(typeIdx)) return false;
  return !isSupertypeOfAny(ctx, typeIdx);
}

/**
 * Phase 2 — commit the eligible expando receivers and return them as SLOTTED
 * carrier roots for `__closure_bag_{lookup,ensure}`. The `bagIdx` is the index
 * the field WILL have after {@link appendAnonExpandoBagSlots}.
 */
export function commitAnonExpandoBagRoots(ctx: CodegenContext): { typeIdx: number; bagIdx: number }[] {
  const state = states.get(ctx);
  if (!state || state.expandoReceivers.size === 0) return [];
  if (linkBrandRoleOf(ctx) !== undefined) return [];
  const anchorIdx = ctx.structMap.get("__vec_base");
  if (anchorIdx === undefined) return [];
  const out: { typeIdx: number; bagIdx: number }[] = [];
  for (const typeIdx of [...state.expandoReceivers].sort((a, b) => a - b)) {
    if (!isEligible(ctx, typeIdx, anchorIdx)) continue;
    const bagIdx = (ctx.mod.types[typeIdx] as StructTypeDef).fields.length;
    state.committed.set(typeIdx, bagIdx);
    out.push({ typeIdx, bagIdx });
  }
  return out;
}

/**
 * Phase 3 — append each committed `$bag` field and give every `struct.new` of
 * the type its `ref.null extern` operand. Must run after ALL instruction
 * emission and BEFORE shape branding (`brandCollidingShapeTypes`).
 */
export function appendAnonExpandoBagSlots(ctx: CodegenContext): void {
  const state = states.get(ctx);
  if (!state || state.committed.size === 0) return;
  for (const [typeIdx, bagIdx] of state.committed) {
    const def = ctx.mod.types[typeIdx] as StructTypeDef;
    // The bag arms already address `bagIdx`; a field appended in between would
    // make them read the wrong slot. Fail the compile loudly rather than emit
    // a module that silently misreads.
    if (def.fields.length !== bagIdx) {
      throw new Error(
        `#7020: ${def.name ?? typeIdx} grew from ${bagIdx} to ${def.fields.length} fields between the bag-helper fill and the $bag append`,
      );
    }
    // Clone: ctx.structFields shares the original array and must keep listing
    // only the real (enumerable) properties.
    def.fields = [...def.fields, closureBagField()];
  }

  const visited = new WeakSet<Instr[]>();
  const patch = (root: Instr[]): void => {
    const stack: Instr[][] = [root];
    while (stack.length > 0) {
      const arr = stack.pop()!;
      if (visited.has(arr)) continue;
      visited.add(arr);
      for (let i = 0; i < arr.length; i++) {
        const ins = arr[i]! as Instr & { op: string; typeIdx?: number };
        walkChildren(ins, (children) => stack.push(children));
        if (ins.op === "struct.new" && ins.typeIdx !== undefined && state.committed.has(ins.typeIdx)) {
          arr.splice(i, 0, { op: "ref.null.extern" });
          i++; // skip past the struct.new just patched
        }
      }
    }
  };
  for (const fn of ctx.mod.functions) if (fn.body && fn.body.length > 0) patch(fn.body);
  for (const g of ctx.mod.globals) if (g.init && g.init.length > 0) patch(g.init);
  state.committed.clear();
}
