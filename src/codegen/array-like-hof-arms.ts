// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Array-like prototype-borrow HOF method arms — extracted verbatim from
 * `compileArrayLikePrototypeCall` in array-prototype-borrow.ts (#3196, epic
 * #3182 god-function decomposition).
 *
 * This is the per-method `switch` that emits the
 * every/some/forEach/find/findIndex/filter/map/reduce/reduceRight element loops
 * for a DYNAMIC (externref) array-like receiver. Split out to shrink the
 * ~1,125-LOC monolith. Pure behaviour-preserving move (no logic changes): the
 * switch body is copied byte-for-byte and every shared local / instruction
 * template arrives via {@link ArrayLikeHofArmCtx}, so the emitted Wasm is
 * identical.
 *
 * NOTE — #3196's LITERAL goal is DEFERRED. Routing the standalone lane onto the
 * shared #3098 `__hof_<name>` steppers is a separate, NON-byte-identical change
 * blocked on the stepper first gaining (a) HasProperty hole-skip and (b) raw
 * i32/f64 result variants: the inline arms below skip sparse holes via
 * `__extern_has_idx` and return raw i32/f64 for every/some/findIndex (the boxed-
 * externref stepper does neither), so migrating today would regress the sparse
 * array-like test262 `-c-i` family and change result ValTypes. Tracked as a
 * follow-up.
 */
import type { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, ClosureInfo, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjVecBuilders } from "./object-runtime.js";
import { coercionInstrs } from "./type-coercion.js";
import { compileExpression, ensureLateImport, flushLateImportShifts, VOID_RESULT } from "./shared.js";
import { guardedFuncRefCastInstrs } from "./array-methods.js";

/**
 * Shared per-call locals (as local indices) + pre-built instruction templates
 * threaded from `compileArrayLikePrototypeCall` into the method-arm switch. The
 * arm code references these by the exact same names via the destructure below,
 * which is what keeps the moved switch byte-for-byte identical.
 */
export interface ArrayLikeHofArmCtx {
  receiverTmp: number;
  lenTmp: number;
  iTmp: number;
  elemTmp: number;
  closureTmp: number;
  closureTypeIdx: number;
  closureInfo: ClosureInfo;
  getIdxFnNow: number;
  cbBoolBoxIdx: number | undefined;
  loadElem: Instr[];
  callClosure: Instr[];
  toTruthy: Instr[];
  incrI: Instr[];
  exitIfDone: Instr[];
  hasIdxCheck: Instr[];
  gatedBody: (inner: Instr[]) => Instr[];
  withThisInstalled: (call: Instr[]) => Instr[];
}

/**
 * Emit the per-method HOF element loop for a dynamic array-like receiver.
 * Verbatim extraction of the `switch (methodName)` from
 * `compileArrayLikePrototypeCall` — see the module header.
 */
export function emitArrayLikeHofArm(
  ctx: CodegenContext,
  fctx: FunctionContext,
  methodName: string,
  callExpr: ts.CallExpression,
  arm: ArrayLikeHofArmCtx,
): ValType | null | typeof VOID_RESULT | undefined {
  const {
    receiverTmp,
    lenTmp,
    iTmp,
    elemTmp,
    closureTmp,
    closureTypeIdx,
    closureInfo,
    getIdxFnNow,
    cbBoolBoxIdx,
    loadElem,
    callClosure,
    toTruthy,
    incrI,
    exitIfDone,
    hasIdxCheck,
    gatedBody,
    withThisInstalled,
  } = arm;
  switch (methodName) {
    case "every": {
      const resTmp = allocLocal(fctx, `__ali_ev_res_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "local.set", index: resTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...withThisInstalled(callClosure),
                ...toTruthy,
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 0 },
                    { op: "local.set", index: resTmp },
                    { op: "br", depth: 3 },
                  ],
                },
              ]),
              ...incrI,
            ],
          },
        ],
      });
      fctx.body.push({ op: "local.get", index: resTmp });
      return { kind: "i32" };
    }

    case "some": {
      const resTmp = allocLocal(fctx, `__ali_sm_res_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: resTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...withThisInstalled(callClosure),
                ...toTruthy,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 1 },
                    { op: "local.set", index: resTmp },
                    { op: "br", depth: 3 },
                  ],
                },
              ]),
              ...incrI,
            ],
          },
        ],
      });
      fctx.body.push({ op: "local.get", index: resTmp });
      return { kind: "i32" };
    }

    case "forEach": {
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...withThisInstalled(callClosure),
                // drop return value if any
                ...(closureInfo.returnType !== null ? ([{ op: "drop" }] satisfies Instr[]) : []),
              ]),
              ...incrI,
            ],
          },
        ],
      });
      return VOID_RESULT;
    }

    case "find": {
      const resTmp = allocLocal(fctx, `__ali_fd_res_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "local.set", index: resTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...loadElem,
              ...withThisInstalled(callClosure),
              ...toTruthy,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: elemTmp },
                  { op: "local.set", index: resTmp },
                  { op: "br", depth: 2 },
                ],
              },
              ...incrI,
            ],
          },
        ],
      });
      fctx.body.push({ op: "local.get", index: resTmp });
      return { kind: "externref" };
    }

    case "findIndex": {
      const resTmp = allocLocal(fctx, `__ali_fi_res_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "f64.const", value: -1 });
      fctx.body.push({ op: "local.set", index: resTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...loadElem,
              ...withThisInstalled(callClosure),
              ...toTruthy,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: iTmp },
                  { op: "f64.convert_i32_s" },
                  { op: "local.set", index: resTmp },
                  { op: "br", depth: 2 },
                ],
              },
              ...incrI,
            ],
          },
        ],
      });
      fctx.body.push({ op: "local.get", index: resTmp });
      return { kind: "f64" };
    }

    case "filter": {
      // (#2036 S6 step 2) Result builder: in standalone/WASI build a native
      // `$ObjVec` via `__objvec_new`/`__objvec_push` (host-import-free, and
      // `[i]`/`.length`-readable post #2190/#35); in host/gc mode keep the host
      // `__js_array_new`/`__js_array_push` JS-array builders. Both have the
      // identical externref-new / `(externref,externref)->void`-push shape, so
      // the loop body below is unchanged. filter's result is naturally dense
      // (order-preserving compaction), so the sequential `push` is exact — no
      // sparse-hole concern (that defers `map` to a follow-up slice).
      let arrNewIdx: number | undefined;
      let arrPushIdx: number | undefined;
      if (ctx.standalone || ctx.wasi) {
        const builders = ensureObjVecBuilders(ctx);
        arrNewIdx = builders.newIdx;
        arrPushIdx = builders.pushIdx;
      } else {
        arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
        arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
      }
      if (arrNewIdx === undefined || arrPushIdx === undefined) return undefined;
      flushLateImportShifts(ctx, fctx);
      const resultTmp = allocLocal(fctx, `__ali_fl_res_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "call", funcIdx: arrNewIdx });
      fctx.body.push({ op: "local.set", index: resultTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...withThisInstalled(callClosure),
                ...toTruthy,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: resultTmp },
                    { op: "local.get", index: elemTmp },
                    { op: "call", funcIdx: arrPushIdx },
                  ],
                },
              ]),
              ...incrI,
            ],
          },
        ],
      });
      fctx.body.push({ op: "local.get", index: resultTmp });
      return { kind: "externref" };
    }

    case "map": {
      // (#2580 M2.2b) Result builder: in standalone/WASI build a native `$ObjVec`
      // via `__objvec_new`/`__objvec_push` (host-import-free, `[i]`/`.length`-
      // readable post #2190/#35) — same as the `filter` arm above — instead of the
      // host `__js_array_new`/`__extern_set` JS-array builder. For the
      // `.call(arrayLike)` generic-method case the loop iterates indices
      // `0..length-1` DENSELY, so a sequential `__objvec_push` per iteration places
      // each mapped element at its own index — exact and order-preserving (the
      // sparse-hole concern that deferred a native `map` is for REAL sparse arrays,
      // not this dense array-like walk). Host/gc mode keeps the JS-array builder
      // (it surfaces a real JS Array on the boundary). This removed `map` from
      // `STANDALONE_UNSUPPORTED_ARRAY_LIKE_METHODS` (#2036 S6 step-2, last entry).
      const nativeBuilder = ctx.standalone || ctx.wasi;
      let arrNewIdx: number | undefined;
      let arrPushIdx: number | undefined; // native $ObjVec push (standalone)
      let arrSetIdx: number | undefined; // host index-keyed set (gc/host)
      if (nativeBuilder) {
        const builders = ensureObjVecBuilders(ctx);
        arrNewIdx = builders.newIdx;
        arrPushIdx = builders.pushIdx;
      } else {
        arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
        arrSetIdx = ensureLateImport(
          ctx,
          "__extern_set",
          [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
          [],
        );
      }
      // Used for numeric callback results and (host path) array index / length keys.
      const mapBoxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      if (
        arrNewIdx === undefined ||
        mapBoxIdx === undefined ||
        (nativeBuilder ? arrPushIdx === undefined : arrSetIdx === undefined)
      ) {
        return undefined;
      }
      flushLateImportShifts(ctx, fctx);
      const resultTmp = allocLocal(fctx, `__ali_mp_res_${fctx.locals.length}`, { kind: "externref" });
      const mappedTmp = allocLocal(fctx, `__ali_mp_mapped_${fctx.locals.length}`, { kind: "externref" });
      // Convert map result to externref
      const mapReturnToExternref: Instr[] =
        closureInfo.returnType === null
          ? // Void callback leaves nothing on the stack; push null so local.set
            // has a value. Maps produced from void callbacks fill with undefined.
            [{ op: "ref.null.extern" }]
          : closureInfo.returnType.kind === "f64"
            ? [{ op: "call", funcIdx: mapBoxIdx }]
            : closureInfo.returnType.kind === "i32"
              ? // (#2773 S8) boolean-returning callback → __box_boolean (true/false)
                cbBoolBoxIdx !== undefined
                ? [{ op: "call", funcIdx: cbBoolBoxIdx }]
                : [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: mapBoxIdx }]
              : closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null"
                ? [{ op: "extern.convert_any" }]
                : []; // externref: already right type
      fctx.body.push({ op: "call", funcIdx: arrNewIdx });
      fctx.body.push({ op: "local.set", index: resultTmp });
      // Host JS-array path needs an explicit `.length` set (the $ObjVec builder
      // tracks length intrinsically via push, so the native path skips it).
      if (!nativeBuilder) {
        addStringConstantGlobal(ctx, "length");
        fctx.body.push(
          { op: "local.get", index: resultTmp },
          ...stringConstantExternrefInstrs(ctx, "length"),
          { op: "local.get", index: lenTmp },
          { op: "f64.convert_i32_s" },
          { op: "call", funcIdx: mapBoxIdx },
          { op: "call", funcIdx: arrSetIdx! },
        );
      }
      // Per-element store: native → `__objvec_push(result, mapped)` (sequential =
      // index-correct for the dense walk); host → `__extern_set(result, box(i),
      // mapped)` (index-keyed).
      const storeMapped: Instr[] = nativeBuilder
        ? [
            { op: "local.get", index: resultTmp },
            { op: "local.get", index: mappedTmp },
            { op: "call", funcIdx: arrPushIdx! },
          ]
        : [
            { op: "local.get", index: resultTmp },
            { op: "local.get", index: iTmp },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: mapBoxIdx },
            { op: "local.get", index: mappedTmp },
            { op: "call", funcIdx: arrSetIdx! },
          ];
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...withThisInstalled(callClosure),
                ...mapReturnToExternref,
                { op: "local.set", index: mappedTmp },
                ...storeMapped,
              ]),
              ...incrI,
            ],
          },
        ],
      });
      fctx.body.push({ op: "local.get", index: resultTmp });
      return { kind: "externref" };
    }

    case "reduce": {
      // reduce(callback, initialValue?) — callback(acc, elem, i, receiver) -> acc
      // args: [receiver, callback, initialValue?]
      const accTmp = allocLocal(fctx, `__ali_rd_acc_${fctx.locals.length}`, { kind: "externref" });
      const hasInitial = callExpr.arguments.length >= 3;
      if (hasInitial) {
        const initType = compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "externref" });
        if (initType && initType.kind !== "externref") {
          fctx.body.push({ op: "extern.convert_any" });
        }
        if (initType === null) fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "local.set", index: accTmp });
      } else {
        // No initial value (spec §23.1.3.21 step 6.b): scan forward for the
        // FIRST present index k (HasProperty), set acc = receiver[k], set
        // iTmp = k+1, then continue with the main loop. If no element is
        // present, throw TypeError. The previous implementation grabbed
        // receiver[0] unconditionally, which produced NaN when index 0
        // was a hole (issue #1461 acceptance bullet 3).
        const foundTmp = allocLocal(fctx, `__ali_rd_found_${fctx.locals.length}`, { kind: "i32" });
        // foundTmp = 0
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "local.set", index: foundTmp });
        // i = 0
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "local.set", index: iTmp });

        // Scan loop: walk i = 0..len-1, find first HasProperty(receiver, i).
        fctx.body.push({
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // exit if i >= len  (br to enclosing block; reduce-no-initial throws)
                ...exitIfDone,
                // if HasProperty(receiver, i): { acc = receiver[i]; i = i + 1; br 2 (exit scan block) }
                ...hasIdxCheck,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // acc = receiver[i]
                    { op: "local.get", index: receiverTmp },
                    { op: "local.get", index: iTmp },
                    { op: "f64.convert_i32_s" },
                    { op: "call", funcIdx: getIdxFnNow },
                    { op: "local.set", index: accTmp },
                    // foundTmp = 1
                    { op: "i32.const", value: 1 },
                    { op: "local.set", index: foundTmp },
                    // i = i + 1
                    { op: "local.get", index: iTmp },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: iTmp },
                    // Exit scan block (depth: 2 = past the inner `if`, the loop, to break out of the outer block)
                    { op: "br", depth: 2 },
                  ],
                },
                // Not present: increment and loop back (br depth 0 = continue loop)
                ...incrI,
              ],
            },
          ],
        });
        // If no element was found, throw TypeError (spec step 6.c).
        fctx.body.push({ op: "local.get", index: foundTmp });
        fctx.body.push({ op: "i32.eqz" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: buildThrowJsErrorInstrs(ctx, "TypeError", "Reduce of empty array with no initial value", {
            flush: fctx,
          }),
        });
      }

      // Reduce callback has 4 params: acc, elem, i, array
      // Build the reduce call instructions (similar to callClosure but with accTmp first).
      // Only push each argument if the closure declares that parameter — pushing an unused
      // local on the stack produces invalid Wasm because call_ref expects exactly numParams values.
      const reduceNumParams = closureInfo.paramTypes.length;
      const reduceCallClosure: Instr[] = [
        { op: "local.get", index: closureTmp },
        ...(reduceNumParams >= 1
          ? ([
              { op: "local.get", index: accTmp },
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[0] ?? { kind: "externref" }, fctx),
            ] satisfies Instr[])
          : []),
        ...(reduceNumParams >= 2
          ? ([
              { op: "local.get", index: elemTmp },
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[1] ?? { kind: "externref" }, fctx),
            ] satisfies Instr[])
          : []),
        ...(reduceNumParams >= 3
          ? ([
              { op: "local.get", index: iTmp },
              ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[2] ?? { kind: "i32" }, fctx),
            ] satisfies Instr[])
          : []),
        ...(reduceNumParams >= 4
          ? ([
              { op: "local.get", index: receiverTmp },
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[3] ?? { kind: "externref" }, fctx),
            ] satisfies Instr[])
          : []),
        { op: "local.get", index: closureTmp },
        { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
        ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
        { op: "ref.as_non_null" },
        { op: "call_ref", typeIdx: closureInfo.funcTypeIdx },
      ];

      // Convert reduce result to externref for accumulator
      const rdBoxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      if (rdBoxIdx === undefined) return undefined;
      flushLateImportShifts(ctx, fctx);
      const reduceResultToExternref: Instr[] =
        closureInfo.returnType === null
          ? // Void callback leaves nothing on the stack; push null so local.set
            // has a value. Subsequent iterations pass undefined as acc.
            [{ op: "ref.null.extern" }]
          : closureInfo.returnType.kind === "f64"
            ? [{ op: "call", funcIdx: rdBoxIdx }]
            : closureInfo.returnType.kind === "i32"
              ? // (#2773 S8) boolean-returning callback → __box_boolean (true/false)
                cbBoolBoxIdx !== undefined
                ? [{ op: "call", funcIdx: cbBoolBoxIdx }]
                : [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: rdBoxIdx }]
              : closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null"
                ? [{ op: "extern.convert_any" }]
                : []; // externref: already right type

      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...reduceCallClosure,
                ...reduceResultToExternref,
                { op: "local.set", index: accTmp },
              ]),
              ...incrI,
            ],
          },
        ],
      });
      fctx.body.push({ op: "local.get", index: accTmp });
      return { kind: "externref" };
    }

    case "reduceRight": {
      // Similar to reduce but from len-1 down to 0
      const accTmp = allocLocal(fctx, `__ali_rr_acc_${fctx.locals.length}`, { kind: "externref" });
      const hasInitial = callExpr.arguments.length >= 3;

      // Set i to last index
      fctx.body.push({ op: "local.get", index: lenTmp });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "i32.sub" });
      fctx.body.push({ op: "local.set", index: iTmp });

      if (hasInitial) {
        const initType = compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "externref" });
        if (initType && initType.kind !== "externref") {
          fctx.body.push({ op: "extern.convert_any" });
        }
        if (initType === null) fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "local.set", index: accTmp });
      } else {
        // No initial value (spec §23.1.3.22 step 7.b): scan BACKWARD for the
        // FIRST (highest) present index k, set acc = receiver[k], iTmp = k-1.
        // Throw TypeError if no element is present. The previous code grabbed
        // receiver[len-1] unconditionally, which produced NaN when the last
        // index was a hole (issue #1461 acceptance bullet 3).
        const foundTmpR = allocLocal(fctx, `__ali_rr_found_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "local.set", index: foundTmpR });

        // Scan loop: walk i = len-1..0, find first HasProperty(receiver, i).
        fctx.body.push({
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // exit if i < 0  (br to enclosing block; reduceRight-no-initial throws)
                { op: "local.get", index: iTmp },
                { op: "i32.const", value: 0 },
                { op: "i32.lt_s" },
                { op: "br_if", depth: 1 },
                // if HasProperty(receiver, i): { acc = receiver[i]; i = i - 1; br 2 (exit scan block) }
                ...hasIdxCheck,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: receiverTmp },
                    { op: "local.get", index: iTmp },
                    { op: "f64.convert_i32_s" },
                    { op: "call", funcIdx: getIdxFnNow },
                    { op: "local.set", index: accTmp },
                    { op: "i32.const", value: 1 },
                    { op: "local.set", index: foundTmpR },
                    { op: "local.get", index: iTmp },
                    { op: "i32.const", value: 1 },
                    { op: "i32.sub" },
                    { op: "local.set", index: iTmp },
                    { op: "br", depth: 2 },
                  ],
                },
                // Not present: decrement and loop back
                { op: "local.get", index: iTmp },
                { op: "i32.const", value: 1 },
                { op: "i32.sub" },
                { op: "local.set", index: iTmp },
                { op: "br", depth: 0 },
              ],
            },
          ],
        });
        // If no element was found, throw TypeError.
        fctx.body.push({ op: "local.get", index: foundTmpR });
        fctx.body.push({ op: "i32.eqz" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: buildThrowJsErrorInstrs(ctx, "TypeError", "Reduce of empty array with no initial value", {
            flush: fctx,
          }),
        });
      }

      const rrNumParams = closureInfo.paramTypes.length;
      const rrCallClosure: Instr[] = [
        { op: "local.get", index: closureTmp },
        ...(rrNumParams >= 1
          ? ([
              { op: "local.get", index: accTmp },
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[0] ?? { kind: "externref" }, fctx),
            ] satisfies Instr[])
          : []),
        ...(rrNumParams >= 2
          ? ([
              { op: "local.get", index: elemTmp },
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[1] ?? { kind: "externref" }, fctx),
            ] satisfies Instr[])
          : []),
        ...(rrNumParams >= 3
          ? ([
              { op: "local.get", index: iTmp },
              ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[2] ?? { kind: "i32" }, fctx),
            ] satisfies Instr[])
          : []),
        ...(rrNumParams >= 4
          ? ([
              { op: "local.get", index: receiverTmp },
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[3] ?? { kind: "externref" }, fctx),
            ] satisfies Instr[])
          : []),
        { op: "local.get", index: closureTmp },
        { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
        ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
        { op: "ref.as_non_null" },
        { op: "call_ref", typeIdx: closureInfo.funcTypeIdx },
      ];

      const rrBoxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      if (rrBoxIdx === undefined) return undefined;
      flushLateImportShifts(ctx, fctx);
      const rrResultToExternref: Instr[] =
        closureInfo.returnType === null
          ? // Void callback — see note in reduce case.
            [{ op: "ref.null.extern" }]
          : closureInfo.returnType.kind === "f64"
            ? [{ op: "call", funcIdx: rrBoxIdx }]
            : closureInfo.returnType.kind === "i32"
              ? // (#2773 S8) boolean-returning callback → __box_boolean (true/false)
                cbBoolBoxIdx !== undefined
                ? [{ op: "call", funcIdx: cbBoolBoxIdx }]
                : [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: rrBoxIdx }]
              : closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null"
                ? [{ op: "extern.convert_any" }]
                : [];

      // Loop: while i >= 0
      /** Exit when i < 0 */
      const exitIfNeg: Instr[] = [
        { op: "local.get", index: iTmp },
        { op: "i32.const", value: 0 },
        { op: "i32.lt_s" },
        { op: "br_if", depth: 1 },
      ];
      const decrI: Instr[] = [
        { op: "local.get", index: iTmp },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "local.set", index: iTmp },
        { op: "br", depth: 0 },
      ];

      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfNeg,
              ...gatedBody([...loadElem, ...rrCallClosure, ...rrResultToExternref, { op: "local.set", index: accTmp }]),
              ...decrI,
            ],
          },
        ],
      });
      fctx.body.push({ op: "local.get", index: accTmp });
      return { kind: "externref" };
    }

    default:
      return undefined;
  }
}
