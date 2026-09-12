/**
 * (#5356) Function-top ref cells for `let`/`const` bindings that a hoisted
 * nested `function` captures mutably, keyed by the RAW pre-hoisted slot each
 * cell was seeded from (`FunctionContext.eagerCaptureBoxes`).
 *
 * `localMap` / `boxedCaptures` are name-keyed and get hidden inside a
 * shadowing block or a CaseBlock scope (`saveBlockScopedShadows`), while the
 * hoisted function's capture keeps naming the raw slot (`outerLocalIdx`).
 * Three consumers treated that raw slot as the binding's storage; once the
 * declaration writes the cell instead of the slot they desync from the callee
 * (measured on the bare #2692 skip removal: a `let` declared directly in a
 * `case` clause and mutated by a clause-level function read `"1"` for `"6"`):
 *
 * - the switch case-scope check (`control-flow.ts`), which decided "this
 *   clause's own binding" by `localMap.get(name) === record.valueSlot`;
 * - the #2814 / #5271 block-let slot re-install (`variables.ts`, `index.ts`),
 *   which put the raw slot back into `localMap` after a block hid it;
 * - the lazy call-site mint (`call-identifier.ts`), which built a second cell
 *   from the raw slot when the name was hidden by a shadowing block.
 *
 * Each now resolves the cell through here. Slot-keyed, so scope hiding cannot
 * lose it; frame-local, so a lifted sibling frame never sees the declaring
 * frame's record.
 */
import { ts } from "../../ts-api.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import type { FunctionContext } from "../context/types.js";

type EagerCaptureBox = NonNullable<FunctionContext["eagerCaptureBoxes"]> extends Map<number, infer V> ? V : never;

/** Record the cell `emitEagerCaptureBoxes` minted from `rawSlot` in this frame. */
export function recordEagerCaptureBox(fctx: FunctionContext, rawSlot: number, box: EagerCaptureBox): void {
  (fctx.eagerCaptureBoxes ??= new Map()).set(rawSlot, box);
}

/**
 * The cell this frame minted from `rawSlot`, when the cell local still carries
 * that cell type. Type-checked because a consumer forwards the slot directly
 * into a callee's capture ABI.
 */
export function eagerCaptureBoxOf(fctx: FunctionContext, rawSlot: number): EagerCaptureBox | undefined {
  const box = fctx.eagerCaptureBoxes?.get(rawSlot);
  if (box === undefined) return undefined;
  const type = getLocalType(fctx, box.cellSlot);
  if (type === undefined || (type.kind !== "ref" && type.kind !== "ref_null")) return undefined;
  return type.typeIdx === box.refCellTypeIdx ? box : undefined;
}

/**
 * True when `localMap[name]` is the binding `record` pre-hoisted — the raw
 * slot, or the cell minted from it. The switch case-scope logic uses this to
 * tell a clause's OWN `let` (keep active) from a genuine outer binding (hide).
 */
export function preHoistedBindingIsLive(fctx: FunctionContext, name: string, record: { valueSlot: number }): boolean {
  const live = fctx.localMap.get(name);
  return live === record.valueSlot || live === eagerCaptureBoxOf(fctx, record.valueSlot)?.cellSlot;
}

/**
 * The cell a call site must forward for a mutable capture when THIS frame
 * minted it at function top and only the NAME is hidden (a shadowing block or
 * CaseBlock scope, where `boxedCaptures` cannot answer). Minting a second cell
 * from the raw slot would read a slot the declaration no longer writes, and
 * re-aiming `localMap` would hijack the shadowing binding's name. Owner test:
 * the raw slot still names the captured binding in this frame (the evidence
 * `captureSourceSlot` relies on) and the name is not one of this frame's own
 * leading capture params.
 */
export function eagerCaptureCellForCall(
  fctx: FunctionContext,
  cap: { name: string; outerLocalIdx: number },
  refCellTypeIdx: number,
): number | undefined {
  const box = eagerCaptureBoxOf(fctx, cap.outerLocalIdx);
  if (box === undefined || box.refCellTypeIdx !== refCellTypeIdx) return undefined;
  const rawSlotDef =
    cap.outerLocalIdx < fctx.params.length
      ? fctx.params[cap.outerLocalIdx]
      : fctx.locals[cap.outerLocalIdx - fctx.params.length];
  if (rawSlotDef?.name !== cap.name || (fctx.liftedCaptureNames?.has(cap.name) ?? false)) return undefined;
  return box.cellSlot;
}

/**
 * Put a block-scoped `let`/`const`'s pre-hoisted binding back after
 * `saveBlockScopedShadows` hid it: the function-top cell (and its
 * `boxedCaptures` entry, so the declaration writes THROUGH the cell) when the
 * slot was capture-boxed, else the raw slot — plus its TDZ flag either way.
 */
export function reinstallPreHoistedLetConstBinding(
  fctx: FunctionContext,
  name: string,
  record: { valueSlot: number; flagSlot?: number },
): void {
  const box = eagerCaptureBoxOf(fctx, record.valueSlot);
  if (box !== undefined) {
    fctx.localMap.set(name, box.cellSlot);
    (fctx.boxedCaptures ??= new Map()).set(name, { refCellTypeIdx: box.refCellTypeIdx, valType: box.valType });
  } else {
    fctx.localMap.set(name, record.valueSlot);
  }
  if (record.flagSlot !== undefined) {
    (fctx.tdzFlagLocals ??= new Map()).set(name, record.flagSlot);
  }
}

type BoxedCaptureEntry = NonNullable<FunctionContext["boxedCaptures"]> extends Map<string, infer V> ? V : never;
type RedirectedPatternBinding = { name: string; cellSlot: number; scratch: number; box: BoxedCaptureEntry };

/**
 * Point every identifier in an ARRAY binding pattern whose binding currently
 * lives in a ref cell at a scratch local of the cell's VALUE type for the
 * duration of the destructuring, and hide its `boxedCaptures` entry so reads
 * inside the pattern (defaults such as `[a, b = a]`) treat the scratch as a
 * plain local. The array lanes of `destructureParamArray` store each element
 * with `local.set` into `localMap.get(name)` after coercing to that local's
 * declared type; aimed at the cell slot that coercion is `any.convert_extern;
 * ref.cast <cell>` — an `illegal cast` trap on the first element (measured:
 * `let [a, b] = arr` with `a` mutated by a hoisted function). The object lane
 * already redirects per element (#4618); this is the pattern-level twin.
 * `flushRedirectedPatternBindings` writes the scratch values through the
 * cells and restores the maps.
 */
export function redirectBoxedPatternBindings(
  fctx: FunctionContext,
  pattern: ts.BindingPattern,
  out: RedirectedPatternBinding[] = [],
): RedirectedPatternBinding[] {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      redirectBoxedPatternBindings(fctx, element.name, out);
      continue;
    }
    if (!ts.isIdentifier(element.name)) continue;
    const name = element.name.text;
    const box = fctx.boxedCaptures?.get(name);
    const cellSlot = fctx.localMap.get(name);
    if (box === undefined || cellSlot === undefined) continue;
    const type = getLocalType(fctx, cellSlot);
    if (
      type === undefined ||
      (type.kind !== "ref" && type.kind !== "ref_null") ||
      type.typeIdx !== box.refCellTypeIdx
    ) {
      continue;
    }
    const scratch = allocLocal(fctx, `__box_dstr_${name}_${fctx.locals.length}`, box.valType);
    fctx.localMap.set(name, scratch);
    fctx.boxedCaptures?.delete(name);
    out.push({ name, cellSlot, scratch, box });
  }
  return out;
}

/** Write each redirected scratch value through its cell (null-guarded, as #4618) and restore the maps. */
export function flushRedirectedPatternBindings(fctx: FunctionContext, redirected: RedirectedPatternBinding[]): void {
  for (const entry of redirected) {
    fctx.body.push({ op: "local.get", index: entry.cellSlot });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [],
      else: [
        { op: "local.get", index: entry.cellSlot },
        { op: "local.get", index: entry.scratch },
        { op: "struct.set", typeIdx: entry.box.refCellTypeIdx, fieldIdx: 0 },
      ],
    });
    fctx.localMap.set(entry.name, entry.cellSlot);
    (fctx.boxedCaptures ??= new Map()).set(entry.name, entry.box);
  }
}
