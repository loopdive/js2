// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5406) The PROVIDER half of `Object.prototype.toString` across a standalone
 * `link:` boundary.
 *
 * ## The defect (measured 2026-09-12, `.tmp/s6-probe-a-base.out`)
 *
 * `Object.prototype.toString.call(v)` under `--target standalone` classifies by
 * WasmGC type test (`object-proto-tostring.ts`), and a type test only sees the
 * types THIS module declared. `$Object` is not in the canonical rec group
 * (`RUNTIME_RECGROUP_TYPE_NAMES` holds the string + vec families only), so a
 * provider-minted plain object fails every arm of the consumer's chain and hits
 * the loud refusal, while the consumer's own object answers:
 *
 * | receiver, in the CONSUMER                  | base       |
 * | ------------------------------------------ | ---------- |
 * | `{ a: 1 }` it minted itself (opaque `any`) | `[object Object]` |
 * | `NS.mkPlain()` — the provider's `{ a: 1 }` | **throws** |
 * | `NS.mkArr()` — the provider's `[1, 2]`     | `[object Array]` (canonical rec group) |
 *
 * The array answers because its carrier type IS shared; nothing else is. That
 * is why this is a link-boundary question and not an `Object.prototype` one,
 * and why the reported text ("… is not yet implemented in --target standalone")
 * misdescribes it — the method is implemented, it just cannot see a foreign
 * carrier.
 *
 * ## The fix: ask the owner, exactly like every other boundary miss
 *
 * The provider publishes `__js2wasm_link_to_string_tag`: run MY classifier over
 * the value and hand back the finished `"[object X]"` string, or null. The
 * consumer calls it only after its own chain has missed — the same MISS-PATH
 * shape as `__js2wasm_link_member_get` / `__js2wasm_link_method_call` (S2d/S2h),
 * so a receiver the consumer can decode never reaches the peer and the
 * single-module lane is byte-identical.
 *
 * ## Why the provider terminal answers MORE than the local classifier
 *
 * The local chain deliberately refuses a nominal class-instance struct
 * ("loud stays loud" — object-proto-tostring.ts). A provider's Temporal objects
 * are exactly that, so a terminal that reused the chain unchanged would answer
 * null for the values the consumer most needs. Two arms are added here, INSIDE
 * the terminal only:
 *
 *   * `[[ErrorData]]` → `[object Error]` (§20.1.3.6 step 11) — one `ref.test`
 *     on the error struct, not a guess.
 *   * anything else whose `typeof` is `"object"` and which is NOT a `$Object`
 *     → `[object Object]` (step 13). The `$Object` exclusion is what keeps the
 *     two carriers the chain deliberately declines out of this arm: `$Proxy` is
 *     a `$Object` SUBTYPE, and a primitive-wrapper object is an ordinary
 *     `$Object` with a `[[PrimitiveValue]]` slot. Both therefore still reach
 *     null, and the consumer still refuses loudly.
 *   * `$Map` (Map/Set/WeakMap/WeakSet share one branded struct) declines
 *     explicitly: its tag depends on the kind brand, and `[object Object]`
 *     would be a silent wrong answer.
 *
 * Named residual: `@@toStringTag` (§20.1.3.6 step 15) is NOT consulted, so a
 * provider class that carries one — `Temporal.PlainDate` does — answers
 * `[object Object]` rather than `[object Temporal.PlainDate]`. That is the
 * step-13 default, i.e. right for every class that does not set the tag and
 * under-specific for one that does; it is never a wrong BUILTIN tag. Reading it
 * needs a symbol-keyed dynamic read plus a runtime string concat, which is its
 * own slice.
 */
import { emitObjectProtoToStringClassifier } from "./object-proto-tostring.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { definedFuncAt } from "./func-space.js";
import { allocLocal } from "./context/locals.js";
import { LINK_BOUNDARY_TO_STRING_TAG } from "./link-boundary-names.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr, ValType } from "../ir/types.js";

const EXTERNREF: ValType = { kind: "externref" };

/** A `then` block that materializes `"[object <tag>]"` and returns it. */
function returnTag(ctx: CodegenContext, tag: string): Instr[] {
  const text = `[object ${tag}]`;
  addStringConstantGlobal(ctx, text);
  return [...stringConstantExternrefInstrs(ctx, text), { op: "return" } as Instr];
}

/**
 * Fill the provider-side `__js2wasm_link_to_string_tag` body.
 *
 * Called at FINALIZE (from `finalizeStandaloneTimerCallbackExports`, just ahead
 * of `publishStandaloneLinkBoundaryExports`) for the same reason the
 * `callable_kind` / `construct` terminals are filled there: the classifier
 * composes helpers — `__typeof_*`, the arguments brand, the native-proto brand
 * table — whose bodies and registrations are only complete at that point.
 *
 * The terminal is RESERVED before the #1984 index-space freeze with a
 * `ref.null.extern` body, so every failure mode here (no object runtime, no
 * native strings, a classifier that declines) simply leaves that body in place:
 * the consumer reads null, keeps its local answer, and the lane degrades to
 * exactly today's behaviour rather than to a broken call.
 */
export function fillLinkBoundaryToStringTagTerminal(ctx: CodegenContext): void {
  const funcIdx = ctx.funcMap.get(LINK_BOUNDARY_TO_STRING_TAG);
  if (funcIdx === undefined) return;
  const fn = definedFuncAt(ctx, funcIdx);
  if (fn === undefined) return;

  const fctx: FunctionContext = {
    name: LINK_BOUNDARY_TO_STRING_TAG,
    params: [{ name: "value", type: EXTERNREF }],
    locals: [],
    localMap: new Map(),
    returnType: EXTERNREF,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  // The receiver IS parameter 0 here (the reflective-closure ABI's `self`
  // parameter has no meaning for a terminal the peer calls directly).
  if (!emitObjectProtoToStringClassifier(ctx, fctx, 0)) return;

  const anyLocal = allocLocal(fctx, `__link_tag_any_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push({ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: anyLocal });

  // §20.1.3.6 step 11 — `[[ErrorData]]`.
  if (ctx.errorStructTypeIdx >= 0) {
    fctx.body.push(
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: ctx.errorStructTypeIdx },
      { op: "if", blockType: { kind: "empty" }, then: returnTag(ctx, "Error") },
    );
  }

  const typeofObjectIdx = ctx.funcMap.get("__typeof_object");
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  if (typeofObjectIdx !== undefined && objectTypeIdx !== undefined) {
    // DECLINE every exotic carrier this compiler mints whose §20.1.3.6 tag is
    // not the step-13 default, BEFORE the default arm can swallow it. Declining
    // returns null, so the consumer keeps its loud refusal — i.e. exactly the
    // pre-#5406 answer for these receivers, never a wrong tag.
    //
    // Measured why this list is not optional: with only the `$Map` decline in
    // place, `Object.prototype.toString.call(new Date(0))` answered
    // `[object Object]` where the base threw (`.tmp/s6-tagtext-*.out`) — a loud
    // refusal converted into a silent mis-tag, which the acceptance bar counts
    // as negative value.
    //
    // The list is by NAME/field and only fires for a carrier the module
    // actually registered, so it costs nothing in a module that has no Date, no
    // Map, no RegExp. A carrier type added to the compiler later and NOT listed
    // here would be mis-tagged `[object Object]`; that is the named residual of
    // this arm, and the reason the default is reached only through it.
    const declineTypeIdxs = [
      ctx.mapTypeIdx, // Map/Set/WeakMap/WeakSet — one struct, kind-branded
      ctx.symbolTypeIdx,
      ctx.nativeBigIntTypeIdx,
      ctx.weakRefTypeIdx,
      ctx.nativeGeneratorResultTypeIdx,
      ctx.structMap.get("__Date") ?? -1,
      ctx.structMap.get("__StandaloneRegExp") ?? -1,
      ctx.structMap.get("__IterRec") ?? -1,
      ctx.structMap.get("__proxy_revoker") ?? -1,
      ctx.structMap.get("$LazyIterHelper") ?? -1,
    ].filter((typeIdx) => typeIdx >= 0);
    const declineExotic: Instr[] = declineTypeIdxs.flatMap((typeIdx) => [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null.extern" }, { op: "return" }] },
    ]);
    fctx.body.push(
      ...declineExotic,
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: typeofObjectIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: anyLocal },
          { op: "ref.test", typeIdx: objectTypeIdx },
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: returnTag(ctx, "Object") },
        ],
      },
    );
  }

  // Unclassifiable ⇒ "not mine": the consumer keeps its own answer.
  fctx.body.push({ op: "ref.null.extern" });
  fn.locals = fctx.locals;
  fn.body = fctx.body;
}
