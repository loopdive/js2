// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4224 — `String.prototype.replace(/re/, fn)` with a **function replacer**, in
 * `--target standalone` (pure WasmGC, no JS host).
 *
 * §22.2.6.11 step 14: for each match, when `IsCallable(replaceValue)` is true,
 *
 *   > `replacement = ToString(? Call(replaceValue, undefined,
 *   >   « matched, ...captures, position, string »))`
 *
 * The string-replacement lane lowers its whole match walk INSIDE the runtime
 * helper `__regex_replace` (native-regex.ts) — a closed loop that cannot call
 * back out to a user closure. So the function-replacer arm re-emits that walk
 * at the CALL SITE, where the closure's `call_ref` is in scope, reusing the
 * same three primitives the helper is built from: `__regex_search` to advance,
 * `__str_substring` to slice, `__str_concat` to accumulate. Match semantics are
 * therefore shared with the string arm by construction — only the per-match
 * replacement differs.
 *
 * Two details are load-bearing and easy to get wrong:
 *
 *  - **Under-arity replacers still see every argument.** test262's replacers are
 *    written `function () { return arguments[2] + arguments[1]; }` — zero
 *    declared parameters. A `call_ref` marshals exactly `paramTypes.length`
 *    formals, so the arguments would simply vanish. The overflow travels through
 *    the same `__extras_argv` / `__argc` globals an ordinary indirect call uses
 *    (#1053/#1511), which the callee's prologue concatenates onto its formals
 *    when its body reads `arguments`.
 *  - **The replacer's RESULT is `ToString`-ed, not assumed to be a string.** A
 *    replacer returning `undefined` contributes the text `"undefined"`, so the
 *    return value routes through the same runtime ToString the `+`-concat engine
 *    uses rather than a `ref.cast` (which would trap).
 *
 * Only STATICALLY-KNOWN patterns are admitted: the capture count fixes the
 * closure's argument count at compile time, so it must be a compile-time fact.
 * A runtime-only RegExp keeps the narrowed refusal in `regexp-standalone.ts`.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { guardedFuncRefCastInstrs } from "./array-methods.js";
import { allocLocal } from "./context/locals.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "./context/types.js";
import { buildArgcExtrasReset, buildArgcExtrasSetupFromLocals } from "./expressions/argc-extras.js";
import { ensureRegexSearch, regexI32ArrayType } from "./native-regex.js";
import { ensureNativeStringHelpers, nativeStringType } from "./native-strings.js";
import {
  RE_FIELD_CLASS_TABLE,
  RE_FIELD_NGROUPS,
  RE_FIELD_NSCRATCH,
  RE_FIELD_PROG,
  ensureRuntimeToStringIdx,
  hasStandaloneRegExpEngine,
  loadStandaloneRegExpStruct,
  staticRegExpGroupMeta,
  stripStaticWrapper,
} from "./regexp-standalone.js";
import { compileArrowAsClosure, compileExpression } from "./shared.js";
import { isCallableReplacement } from "./string-proto-replace.js";
import { coercionInstrs } from "./type-coercion.js";

/** The native-string helpers the emitted walk is built from. */
interface ReplaceKernel {
  flatten: number;
  substring: number;
  concat: number;
  search: number;
  toStringIdx: number;
}

function loadKernel(ctx: CodegenContext, fctx: FunctionContext): ReplaceKernel | undefined {
  ensureNativeStringHelpers(ctx);
  const flatten = ctx.nativeStrHelpers.get("__str_flatten");
  const substring = ctx.nativeStrHelpers.get("__str_substring");
  const concat = ctx.nativeStrHelpers.get("__str_concat");
  const toStringIdx = ensureRuntimeToStringIdx(ctx, fctx);
  if (flatten === undefined || substring === undefined || concat === undefined || toStringIdx === undefined) {
    return undefined;
  }
  return {
    flatten,
    substring,
    concat,
    search: ensureRegexSearch(ctx),
    toStringIdx,
  };
}

/**
 * Compile the replacer expression into a closure the emitted loop can
 * `call_ref`. Returns `undefined` when the value is not a resolvable in-module
 * closure — a host function value has no funcref to call in a host-free module,
 * so the caller keeps its refusal rather than emitting a broken call.
 *
 * Emission goes into a DETACHED buffer the caller splices in only on success.
 * A `return undefined` after committing instructions to `fctx.body` would leave
 * a half-built expression behind the caller's fall-through refusal — the exact
 * shape of the #1919 speculative-miss hazard. The buffer is registered in
 * `ctx.liveBodies` while it is off-body so a late import/field shift still
 * walks it (same mechanism as the param-destructure body in function-body.ts).
 */
function stageReplacerClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  replExpr: ts.Expression,
):
  | {
      closureTmp: number;
      closureTypeIdx: number;
      info: ClosureInfo;
      instrs: Instr[];
    }
  | undefined {
  const value = stripStaticWrapper(replExpr);
  const outer = fctx.body;
  const buffer: Instr[] = [];
  fctx.body = buffer;
  ctx.liveBodies.add(buffer);
  let compiled: ValType | null;
  try {
    compiled =
      ts.isArrowFunction(value) || ts.isFunctionExpression(value)
        ? compileArrowAsClosure(ctx, fctx, value)
        : compileExpression(ctx, fctx, value);
  } finally {
    fctx.body = outer;
    ctx.liveBodies.delete(buffer);
  }
  if (!compiled || (compiled.kind !== "ref" && compiled.kind !== "ref_null")) return undefined;
  const closureTypeIdx = (compiled as { typeIdx: number }).typeIdx;
  const info = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  if (!info) return undefined;
  const closureTmp = allocLocal(fctx, `__re_repl_fn_${fctx.locals.length}`, compiled);
  buffer.push({ op: "local.set", index: closureTmp });
  return { closureTmp, closureTypeIdx, info, instrs: buffer };
}

/** `caps[slot]` as an i32 on the stack. */
function capSlot(capsLocal: number, i32Arr: number, slot: number): Instr[] {
  return [
    { op: "local.get", index: capsLocal },
    { op: "i32.const", value: slot },
    { op: "array.get", typeIdx: i32Arr },
  ];
}

/**
 * Build the `« matched, ...captures, position, string »` argument list as
 * externref locals (§22.2.6.11 step 14.a-c). Externref is the common currency:
 * every closure parameter type is reachable from it via `coercionInstrs`, and
 * an unmatched capture needs a slot that can hold `undefined`.
 */
function buildCallArgInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  k: ReplaceKernel,
  argLocals: number[],
  locals: { caps: number; subj: number; mstart: number; mend: number },
  nGroups: number,
): Instr[] {
  const i32Arr = regexI32ArrayType(ctx);
  const out: Instr[] = [];
  // `undefined`, not `null`: an unmatched capture must stringify to
  // "undefined". `ref.null.extern` is the JS `null` value on this boundary, so
  // the module's undefined singleton is the correct sentinel when it exists.
  const undef: Instr[] = undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];
  const slice = (fromSlot: number, toSlot: number): Instr[] => [
    { op: "local.get", index: locals.subj },
    ...capSlot(locals.caps, i32Arr, fromSlot),
    ...capSlot(locals.caps, i32Arr, toSlot),
    { op: "call", funcIdx: k.substring },
    { op: "extern.convert_any" },
  ];

  // arg 0 — `matched` = subject[mstart, mend)
  out.push(
    { op: "local.get", index: locals.subj },
    { op: "local.get", index: locals.mstart },
    { op: "local.get", index: locals.mend },
    { op: "call", funcIdx: k.substring },
    { op: "extern.convert_any" },
    { op: "local.set", index: argLocals[0]! },
  );

  // args 1..nGroups-1 — the captures. A capture that did not participate has a
  // start of -1 and is passed as `undefined`, per step 14.b.
  for (let g = 1; g < nGroups; g++) {
    out.push(
      ...capSlot(locals.caps, i32Arr, 2 * g),
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: undef,
        else: slice(2 * g, 2 * g + 1),
      },
      { op: "local.set", index: argLocals[g]! },
    );
  }

  // arg nGroups — `position`, boxed as a Number.
  const boxIdx = ctx.funcMap.get("__box_number");
  out.push({ op: "local.get", index: locals.mstart }, { op: "f64.convert_i32_s" });
  if (boxIdx !== undefined) {
    out.push({ op: "call", funcIdx: boxIdx });
  } else {
    out.push({ op: "drop" }, { op: "ref.null.extern" });
  }
  out.push({ op: "local.set", index: argLocals[nGroups]! });

  // arg nGroups+1 — `string`, the whole subject.
  out.push(
    { op: "local.get", index: locals.subj },
    { op: "extern.convert_any" },
    { op: "local.set", index: argLocals[nGroups + 1]! },
  );
  return out;
}

/**
 * `Call(replaceValue, undefined, args)` then `ToString` the result, leaving a
 * `ref $AnyString` on the stack.
 */
function buildReplacerCallInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  k: ReplaceKernel,
  closure: { closureTmp: number; closureTypeIdx: number; info: ClosureInfo },
  argLocals: number[],
): Instr[] {
  const { info, closureTmp, closureTypeIdx } = closure;
  const paramCount = info.paramTypes.length;
  const out: Instr[] = [];

  // Overflow arguments ride the `__extras_argv`/`__argc` globals so an
  // under-arity replacer reading `arguments` still observes all of them.
  out.push(...buildArgcExtrasSetupFromLocals(ctx, fctx, paramCount, argLocals.slice(paramCount)));

  out.push({ op: "local.get", index: closureTmp });
  for (let i = 0; i < paramCount; i++) {
    const target = info.paramTypes[i] ?? { kind: "externref" as const };
    if (i < argLocals.length) {
      out.push({ op: "local.get", index: argLocals[i]! });
      out.push(...coercionInstrs(ctx, { kind: "externref" }, target, fctx));
    } else {
      // §7.3.14 — a formal beyond the supplied arguments is `undefined`.
      out.push({ op: "ref.null.extern" });
      out.push(...coercionInstrs(ctx, { kind: "externref" }, target, fctx));
    }
  }
  out.push(
    { op: "local.get", index: closureTmp },
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
    ...guardedFuncRefCastInstrs(fctx, info.funcTypeIdx),
    { op: "ref.as_non_null" },
    { op: "call_ref", typeIdx: info.funcTypeIdx },
  );

  // Normalize the return value to externref, then ToString it. A void replacer
  // leaves nothing on the stack, which is `undefined` → `"undefined"`.
  if (info.returnType === null) {
    out.push({ op: "ref.null.extern" });
  } else {
    out.push(...coercionInstrs(ctx, info.returnType, { kind: "externref" }, fctx));
  }
  out.push(...buildArgcExtrasReset(ctx));
  out.push(
    { op: "call", funcIdx: k.toStringIdx },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
  );
  return out;
}

/**
 * The `@@replace` walk with a function replacer. Mirrors `__regex_replace`'s
 * loop (native-regex.ts) instruction-for-instruction apart from the per-match
 * replacement, so empty-match advance (`AdvanceStringIndex`) and the
 * non-global/global split stay identical.
 *
 * Returns `undefined` when this arm does not apply, so the caller can fall
 * through to its existing refusal.
 */
export function tryCompileStandaloneRegExpFunctionReplace(
  ctx: CodegenContext,
  fctx: FunctionContext,
  subjExpr: ts.Expression,
  reExpr: ts.Expression,
  replExpr: ts.Expression,
  globalReplace: boolean,
  subjectOverride?: () => ValType | null,
): ValType | null | undefined {
  if (!isCallableReplacement(ctx, replExpr)) return undefined;
  if (!hasStandaloneRegExpEngine(ctx)) return undefined;
  // The capture count fixes the closure's argument count, so it must be a
  // compile-time fact. A runtime-only pattern keeps the caller's refusal.
  const meta = staticRegExpGroupMeta(ctx, reExpr);
  if (meta === null) return undefined;
  const nGroups = meta.nGroups;
  const k = loadKernel(ctx, fctx);
  if (k === undefined) return undefined;

  const i32Arr = regexI32ArrayType(ctx);
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strType = nativeStringType(ctx);

  // Staged off-body FIRST so an unresolvable replacer can still decline without
  // having written anything into `fctx.body`.
  const closure = stageReplacerClosure(ctx, fctx, replExpr);
  if (closure === undefined) return undefined;

  const loaded = loadStandaloneRegExpStruct(ctx, fctx, reExpr);
  if (loaded === null) return null;
  const { regexpLocal, structTypeIdx } = loaded;

  // subject → flattened `$NativeString` local
  const subjType = subjectOverride ? subjectOverride() : compileExpression(ctx, fctx, subjExpr, strType);
  if (subjType?.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "call", funcIdx: k.flatten });
  const subjLocal = allocLocal(fctx, `__re_fnsubj_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: strTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: subjLocal });

  for (const instr of closure.instrs) fctx.body.push(instr);

  const nslots = allocLocal(fctx, `__re_fn_nslots_${fctx.locals.length}`, {
    kind: "i32",
  });
  const caps = allocLocal(fctx, `__re_fn_caps_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: i32Arr,
  });
  const pos = allocLocal(fctx, `__re_fn_pos_${fctx.locals.length}`, {
    kind: "i32",
  });
  const lastEnd = allocLocal(fctx, `__re_fn_last_${fctx.locals.length}`, {
    kind: "i32",
  });
  const result = allocLocal(fctx, `__re_fn_res_${fctx.locals.length}`, strType);
  const mstart = allocLocal(fctx, `__re_fn_ms_${fctx.locals.length}`, {
    kind: "i32",
  });
  const mend = allocLocal(fctx, `__re_fn_me_${fctx.locals.length}`, {
    kind: "i32",
  });
  const slen = allocLocal(fctx, `__re_fn_slen_${fctx.locals.length}`, {
    kind: "i32",
  });
  const argLocals: number[] = [];
  for (let i = 0; i < nGroups + 2; i++) {
    argLocals.push(
      allocLocal(fctx, `__re_fn_arg${i}_${fctx.locals.length}`, {
        kind: "externref",
      }),
    );
  }

  const subjField = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: subjLocal },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx },
  ];
  const reField = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: regexpLocal },
    { op: "struct.get", typeIdx: structTypeIdx, fieldIdx },
  ];

  // slen; nslots = 2 * nGroups + nScratch; caps = new i32[nslots]
  fctx.body.push(...subjField(0), { op: "local.set", index: slen });
  fctx.body.push(
    ...reField(RE_FIELD_NGROUPS),
    { op: "i32.const", value: 2 },
    { op: "i32.mul" },
    ...reField(RE_FIELD_NSCRATCH),
    { op: "i32.add" },
    { op: "local.set", index: nslots },
    { op: "local.get", index: nslots },
    { op: "array.new_default", typeIdx: i32Arr },
    { op: "local.set", index: caps },
  );
  // result = ""; pos = 0; lastEnd = 0
  fctx.body.push(
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx },
    { op: "struct.new", typeIdx: strTypeIdx },
    { op: "local.set", index: result },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: pos },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: lastEnd },
  );

  const loopBody: Instr[] = [
    // if pos > slen: break
    { op: "local.get", index: pos },
    { op: "local.get", index: slen },
    { op: "i32.gt_s" },
    { op: "br_if", depth: 1 },
    // if !__regex_search(…, pos, sticky=0, caps): break
    ...reField(RE_FIELD_PROG),
    ...reField(RE_FIELD_CLASS_TABLE),
    { op: "local.get", index: nslots },
    ...subjField(2),
    ...subjField(1),
    { op: "local.get", index: slen },
    { op: "local.get", index: pos },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: caps },
    { op: "call", funcIdx: k.search },
    { op: "i32.eqz" },
    { op: "br_if", depth: 1 },
    ...capSlot(caps, i32Arr, 0),
    { op: "local.set", index: mstart },
    ...capSlot(caps, i32Arr, 1),
    { op: "local.set", index: mend },
    // result = concat(concat(result, subject[lastEnd, mstart)), ToString(fn(…)))
    ...buildCallArgInstrs(ctx, fctx, k, argLocals, { caps, subj: subjLocal, mstart, mend }, nGroups),
    { op: "local.get", index: result },
    { op: "local.get", index: subjLocal },
    { op: "local.get", index: lastEnd },
    { op: "local.get", index: mstart },
    { op: "call", funcIdx: k.substring },
    { op: "call", funcIdx: k.concat },
    ...buildReplacerCallInstrs(ctx, fctx, k, closure, argLocals),
    { op: "call", funcIdx: k.concat },
    { op: "local.set", index: result },
    { op: "local.get", index: mend },
    { op: "local.set", index: lastEnd },
    // non-global: stop after the first match
    ...(globalReplace ? [] : ([{ op: "br", depth: 1 }] satisfies Instr[])),
    // AdvanceStringIndex: pos = mend + (mend > mstart ? 0 : 1)
    { op: "local.get", index: mend },
    { op: "local.get", index: mend },
    { op: "local.get", index: mstart },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: [{ op: "i32.const", value: 1 }],
    },
    { op: "i32.add" },
    { op: "local.set", index: pos },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  // result = concat(result, subject[lastEnd, slen))
  fctx.body.push(
    { op: "local.get", index: result },
    { op: "local.get", index: subjLocal },
    { op: "local.get", index: lastEnd },
    { op: "local.get", index: slen },
    { op: "call", funcIdx: k.substring },
    { op: "call", funcIdx: k.concat },
  );
  return strType;
}

/**
 * `String.prototype.replace(searchString, fn)` / `replaceAll` — the STRING
 * search-value lane (§22.1.3.19 steps 3-14), standalone.
 *
 * Same shape as the RegExp walk above with the engine removed: `__str_indexOf`
 * finds each occurrence instead of `__regex_search`, and the argument list is
 * `« matched, position, string »` with no captures. The `replace` form stops
 * after the FIRST occurrence (§22.1.3.19 step 8's single `StringIndexOf`);
 * `replaceAll` walks them all.
 *
 * This lane previously had NO gate on its replacement value at all: the
 * `__str_replace` arm in `string-ops.ts` compiled the argument straight into a
 * `ref $AnyString` slot, so a function replacer produced `RuntimeError: illegal
 * cast` at runtime — a green compile and a broken binary.
 *
 * `emitSubject`/`emitSearch` must each leave one `$AnyString` on the stack; the
 * caller owns those coercions because it also owns whether the search value is
 * admissible at all (§22.1.3.19 step 2's `@@replace` lookup).
 */
export function tryCompileStandaloneStringSearchFunctionReplace(
  ctx: CodegenContext,
  fctx: FunctionContext,
  replExpr: ts.Expression,
  replaceAll: boolean,
  emitSubject: () => void,
  emitSearch: () => void,
): ValType | null | undefined {
  if (!isCallableReplacement(ctx, replExpr)) return undefined;
  const k = loadKernel(ctx, fctx);
  if (k === undefined) return undefined;
  const indexOf = ctx.nativeStrHelpers.get("__str_indexOf");
  if (indexOf === undefined) return undefined;

  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strType = nativeStringType(ctx);

  // Staged off-body first — see stageReplacerClosure's contract.
  const closure = stageReplacerClosure(ctx, fctx, replExpr);
  if (closure === undefined) return undefined;

  const subjLocal = allocLocal(fctx, `__sr_subj_${fctx.locals.length}`, { kind: "ref", typeIdx: strTypeIdx });
  emitSubject();
  fctx.body.push({ op: "call", funcIdx: k.flatten }, { op: "local.set", index: subjLocal });
  const searchLocal = allocLocal(fctx, `__sr_needle_${fctx.locals.length}`, { kind: "ref", typeIdx: strTypeIdx });
  emitSearch();
  fctx.body.push({ op: "call", funcIdx: k.flatten }, { op: "local.set", index: searchLocal });
  for (const instr of closure.instrs) fctx.body.push(instr);

  const slen = allocLocal(fctx, `__sr_slen_${fctx.locals.length}`, { kind: "i32" });
  const nlen = allocLocal(fctx, `__sr_nlen_${fctx.locals.length}`, { kind: "i32" });
  const pos = allocLocal(fctx, `__sr_pos_${fctx.locals.length}`, { kind: "i32" });
  const lastEnd = allocLocal(fctx, `__sr_last_${fctx.locals.length}`, { kind: "i32" });
  const idx = allocLocal(fctx, `__sr_idx_${fctx.locals.length}`, { kind: "i32" });
  const result = allocLocal(fctx, `__sr_res_${fctx.locals.length}`, strType);
  const argLocals = [0, 1, 2].map((i) => allocLocal(fctx, `__sr_arg${i}_${fctx.locals.length}`, { kind: "externref" }));

  const lenOf = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
  ];
  fctx.body.push(...lenOf(subjLocal), { op: "local.set", index: slen });
  fctx.body.push(...lenOf(searchLocal), { op: "local.set", index: nlen });
  fctx.body.push(
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx },
    { op: "struct.new", typeIdx: strTypeIdx },
    { op: "local.set", index: result },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: pos },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: lastEnd },
  );

  const boxIdx = ctx.funcMap.get("__box_number");
  const boxPosition: Instr[] =
    boxIdx !== undefined ? [{ op: "call", funcIdx: boxIdx }] : [{ op: "drop" }, { op: "ref.null.extern" }];
  const loopBody: Instr[] = [
    { op: "local.get", index: pos },
    { op: "local.get", index: slen },
    { op: "i32.gt_s" },
    { op: "br_if", depth: 1 },
    // idx = __str_indexOf(subject, search, pos); stop when absent
    { op: "local.get", index: subjLocal },
    { op: "local.get", index: searchLocal },
    { op: "local.get", index: pos },
    { op: "call", funcIdx: indexOf },
    { op: "local.tee", index: idx },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    { op: "br_if", depth: 1 },
    // « matched, position, string » — `matched` IS the search string here.
    { op: "local.get", index: searchLocal },
    { op: "extern.convert_any" },
    { op: "local.set", index: argLocals[0]! },
    { op: "local.get", index: idx },
    { op: "f64.convert_i32_s" },
    ...boxPosition,
    { op: "local.set", index: argLocals[1]! },
    { op: "local.get", index: subjLocal },
    { op: "extern.convert_any" },
    { op: "local.set", index: argLocals[2]! },
    // result = result + subject[lastEnd, idx) + ToString(fn(…))
    { op: "local.get", index: result },
    { op: "local.get", index: subjLocal },
    { op: "local.get", index: lastEnd },
    { op: "local.get", index: idx },
    { op: "call", funcIdx: k.substring },
    { op: "call", funcIdx: k.concat },
    ...buildReplacerCallInstrs(ctx, fctx, k, closure, argLocals),
    { op: "call", funcIdx: k.concat },
    { op: "local.set", index: result },
    { op: "local.get", index: idx },
    { op: "local.get", index: nlen },
    { op: "i32.add" },
    { op: "local.set", index: lastEnd },
    ...(replaceAll ? [] : ([{ op: "br", depth: 1 }] satisfies Instr[])),
    // An EMPTY search string matches at every position, so advance by one to
    // terminate — the string analogue of AdvanceStringIndex.
    { op: "local.get", index: lastEnd },
    { op: "local.get", index: nlen },
    { op: "i32.eqz" },
    { op: "i32.add" },
    { op: "local.set", index: pos },
    { op: "br", depth: 0 },
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });
  fctx.body.push(
    { op: "local.get", index: result },
    { op: "local.get", index: subjLocal },
    { op: "local.get", index: lastEnd },
    { op: "local.get", index: slen },
    { op: "call", funcIdx: k.substring },
    { op: "call", funcIdx: k.concat },
  );
  return strType;
}
