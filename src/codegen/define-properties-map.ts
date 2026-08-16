// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4479) The `Properties` MAP half of `Object.defineProperties(O, Properties)`
 * — how a *syntactic* descriptor map is named and how it is handed to the
 * runtime applier.
 *
 * Extracted from `object-ops.ts` for the reason `descriptor-shape.ts` (#3991)
 * was: this is a self-contained spec question (§20.1.2.3.1's walk over the map's
 * own keys) whose failure mode is a silent wrong answer, and burying it in a
 * 4,800-line god-file is how its two defects survived. Both are about the map,
 * not about any individual descriptor — `descriptor-shape.ts` owns the latter.
 *
 * ## Defect 1 — an unnameable key was DROPPED, not declined
 *
 * `compileObjectDefineProperties`' static expansion resolved each entry's key
 * with an inline `isIdentifier ? … : isStringLiteral ? … : undefined` and then
 * did `if (propName === undefined) continue`. A numeric-literal key is neither,
 * so `Object.defineProperties(obj, {0: {value: 2}})` defined **nothing** and
 * reported success — including where the define was required to throw for
 * redefining a non-configurable property.
 *
 * `staticDescriptorMapKey` names the numeric case (which `Object.defineProperty`'s
 * own `propArg` normalization already accepts) and returns `undefined` for the
 * genuinely unnameable ones, which the caller turns into a DECLINE of the whole
 * call rather than a silent per-entry skip. A numeric key is accepted only when
 * its source text already IS the canonical ToString of its value, so `1e3` /
 * `0x10` / legacy octal — whose real keys are `"1000"` / `"16"` / `"8"` — decline
 * instead of defining a wrongly-named property.
 *
 * ## Defect 2 — the map reached the native applier as a CLOSED STRUCT
 *
 * The native `__defineProperties` implements §20.1.2.3.1 over an `$Object`: it
 * walks the map's own keys and reads each descriptor's fields with
 * `__desc_has_own` / `__extern_get`. But the map's contextual type is
 * `PropertyDescriptorMap`, a concrete object type, so an object literal in
 * argument position compiles to a WasmGC struct — which carries no
 * `$PropEntry`s. Every one of those reads therefore missed: the map looked
 * empty, or a descriptor looked empty and CompletePropertyDescriptor filled in
 * `undefined` + all-false.
 *
 * Measured on `0e47b7ae0` + the #4479 base files, `--target standalone`, via
 * `runTest262File`:
 *
 * ```js
 * var obj = {}, descObj = { enumerable: true };
 * Object.defineProperties(obj, { prop: descObj });
 * Object.getOwnPropertyDescriptor(obj, "prop").enumerable   // → false
 * ```
 *
 * while `Object.defineProperty(obj, "prop", descObj)` and the all-literal
 * `Object.defineProperties(obj, { prop: { enumerable: true } })` both answered
 * `true`. Only the mixed spelling lost it, and only because the MAP reached the
 * native as a struct. This is the same `$Object`-vs-struct mismatch #3253 fixed
 * for `Object.create`'s per-key descriptor; the plural entry point never got the
 * same treatment for the map itself.
 *
 * `compileDescriptorMapAsDynamicObject` builds the map with
 * `compileObjectLiteralAsExternref` (`__new_plain_object` + `__extern_set`, the
 * exact construction the native's readers already handle), so the applier can
 * see it.
 *
 * ### Why not expand the map into per-key `Object.defineProperty` calls?
 *
 * That is the shape #3782 uses for a *variable* map, and it was the first cut
 * here. The native is the better destination on three counts, and all three are
 * spec-visible:
 *
 *  - it is the only path implementing ToPropertyDescriptor's conflict and
 *    callable checks at all;
 *  - it preserves §20.1.2.3.1's **gather-ALL-then-define-all** order, which a
 *    per-key expansion structurally cannot — a throw on a later key would leave
 *    earlier keys already defined;
 *  - it evaluates the receiver ONCE, where a per-key expansion re-compiles the
 *    receiver expression for every key.
 *
 * ### Absent, not wrong
 *
 * `compileObjectLiteralAsExternref` SKIPS computed/symbol keys and accessor
 * members, so admitting one would silently drop that entry — strictly worse
 * than the struct path it replaces. The gate therefore requires every element
 * to be a plain-named data property whose key `resolvePropertyNameText` can
 * name (the same resolver the builder itself uses, so the two cannot disagree).
 * Spreads and accessors decline.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileObjectLiteralAsExternref, resolvePropertyNameText } from "./literals.js";

/**
 * The property key a `Properties` map entry contributes, when it can be named
 * exactly; `undefined` when the caller must DECLINE to the dynamic applier
 * rather than skip the entry. See the module header, defect 1.
 */
export function staticDescriptorMapKey(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) {
    const canonical = String(Number(name.text));
    return canonical === name.text ? canonical : undefined;
  }
  return undefined;
}

/**
 * Build a syntactic `Properties` map as a real dynamic `$Object` under
 * standalone, so the native `__defineProperties` can walk it. See the module
 * header, defect 2.
 *
 * Returns the `ValType` left on the stack, or `undefined` when it declined
 * (nothing emitted — the caller compiles `descsArg` normally). `null` is
 * `compileObjectLiteralAsExternref`'s own pre-emit decline and is treated the
 * same way.
 *
 * Host/gc lanes decline by construction: there `__defineProperties` is a real JS
 * host import that reads a struct across the boundary fine, and rebuilding the
 * map would change emitted bytes for no behaviour.
 */
export function compileDescriptorMapAsDynamicObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  descsArg: ts.Expression,
): ValType | null | undefined {
  if (!ctx.standalone || !ts.isObjectLiteralExpression(descsArg)) return undefined;
  if (descsArg.properties.length === 0) return undefined;
  const everyEntryNameable = descsArg.properties.every(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      resolvePropertyNameText(ctx, p) !== undefined,
  );
  if (!everyEntryNameable) return undefined;
  return compileObjectLiteralAsExternref(ctx, fctx, descsArg);
}
