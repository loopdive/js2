// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6704) Generic-apply fallback for a callable-property call whose stored
 * value is callable but is NOT a closure-wrapper struct, under
 * `--target standalone` / `wasi`.
 *
 * `obj.f(x)` over an `externref` field guarded-casts the value to the funcref
 * wrapper ROOT and dispatches on the funcref's exact type. A value that is
 * non-nullish but not a wrapper (a callable reached through another carrier —
 * lodash-es's `words`, read into the npm-compat driver's `{ words, kebabCase }`
 * through the runtime-eval module scope) passed the nullish TypeError check,
 * reached `struct.get $root 0` on the failed cast's null and trapped:
 * "dereferencing a null pointer" at the checksum. A direct `words(x)` call on
 * the same value already works, through the generic dynamic invoke.
 *
 * This wraps the ladder in one test: when the root cast failed, apply the raw
 * value with `__apply_closure(f, receiver, [args…])` — the #4096 / #6646
 * bridge, which classifies every callable carrier and installs `this` — and
 * convert its `externref` answer to the ladder's result type. Otherwise the
 * ladder runs exactly as before. Both arms are built from pure instructions
 * against helpers reserved up front (before anything is emitted), so neither
 * detached arm can be hit by a late index shift.
 *
 * The plan declines — leaving the call as it was — for a spread, more than
 * `__apply_closure`'s eight arguments, an argument carrier with no pure
 * `externref` view (`$AnyValue`, an unbranded `i32`), or a result type with
 * no pure conversion.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { noJsHost } from "../js-errors.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import { standaloneMissingStringArgRead } from "./dispatch-extern-arg-bridge.js";
import { guardedExternRefResultBridge } from "./dispatch-extern-result-bridge.js";
import { dispatchVecResultBridge, reserveDispatchVecResultMaterializer } from "./dispatch-vec-result-bridge.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

const EXTERNREF: ValType = { kind: "externref" };
const APPLY_CLOSURE_MAX_ARITY = 8;

type ArgView = (local: number) => Instr[] | null;

function argExternView(ctx: CodegenContext, type: ValType): ArgView | null {
  if (type.kind === "externref") return (local) => [{ op: "local.get", index: local }];
  if (type.kind === "ref" || type.kind === "ref_null") {
    if (type.typeIdx === ctx.anyValueTypeIdx) return null;
    return (local) =>
      standaloneMissingStringArgRead(ctx, local, type, EXTERNREF) ?? [
        { op: "local.get", index: local },
        { op: "extern.convert_any" },
      ];
  }
  if (type.kind === "f64" && type.undefSentinel !== true) {
    ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [EXTERNREF]);
    return (local) => {
      const box = ctx.funcMap.get("__box_number");
      return box === undefined
        ? null
        : [
            { op: "local.get", index: local },
            { op: "call", funcIdx: box },
          ];
    };
  }
  return null;
}

/** Can the fallback's `externref` answer be converted to `expected` with pure instructions? */
function resultConvertible(ctx: CodegenContext, expected: ValType | null): boolean {
  if (expected === null || expected.kind === "externref") return true;
  if (expected.kind !== "ref_null") return false;
  const def = ctx.mod.types[expected.typeIdx];
  return def?.kind === "struct" || def?.kind === "array";
}

function fallbackResultInstrs(ctx: CodegenContext, fctx: FunctionContext, expected: ValType | null): Instr[] | null {
  if (expected === null) return [{ op: "drop" }];
  if (expected.kind === "externref") return [];
  return (
    dispatchVecResultBridge(ctx, EXTERNREF, expected) ?? guardedExternRefResultBridge(ctx, fctx, EXTERNREF, expected)
  );
}

type ReceiverSlot = { localIdx: number; type: ValType };

/** The per-call-site fallback, driven by `compileCallablePropertyCall` in emission order. */
export interface CallablePropertyApplyFallback {
  /** Evaluate the receiver ONCE into a local the field read reuses (and `this` reads). */
  captureReceiver(compileReceiver: () => ValType | null, current: ReceiverSlot | undefined): ReceiverSlot | undefined;
  /** Keep the raw field value (on the stack, `externref`) before the root cast. */
  teeRawValue(): void;
  /** Move the ladder emitted since `ladderStart` into the else arm of the fallback test. */
  wrapLadder(ladderStart: number, closureLocal: number, argLocals: readonly number[], expected: ValType | null): void;
}

/**
 * Decide — before anything for this call is emitted — whether the fallback
 * applies, and reserve every helper it will call. Null when it does not.
 */
export function planCallablePropertyApplyFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  fieldType: ValType,
  paramTypes: readonly ValType[],
  expectedReturn: ValType | null,
): CallablePropertyApplyFallback | null {
  if (!noJsHost(ctx) || fieldType.kind !== "externref") return null;
  if (expr.arguments.some((argument) => ts.isSpreadElement(argument))) return null;
  const argCount = Math.min(expr.arguments.length, paramTypes.length);
  if (argCount > APPLY_CLOSURE_MAX_ARITY) return null;
  const views: ArgView[] = [];
  for (let index = 0; index < argCount; index++) {
    const view = argExternView(ctx, paramTypes[index]!);
    if (view === null) return null;
    views.push(view);
  }
  if (!resultConvertible(ctx, expectedReturn)) return null;
  reserveApplyClosure(ctx);
  ensureObjVecBuilders(ctx);
  reserveDispatchVecResultMaterializer(ctx, fctx, expectedReturn);
  flushLateImportShifts(ctx, fctx);

  let thisInstrs: Instr[] = [{ op: "ref.null.extern" }];
  let rawLocal = -1;
  return {
    captureReceiver(compileReceiver, current) {
      let receiver = current;
      if (receiver === undefined) {
        const type = compileReceiver();
        if (type === null) return undefined;
        const localIdx = allocLocal(fctx, `__cpaf_recv_${fctx.locals.length}`, type);
        fctx.body.push({ op: "local.set", index: localIdx });
        receiver = { localIdx, type };
      }
      const { kind } = receiver.type;
      const isRef = (kind === "ref" || kind === "ref_null") && receiver.type.typeIdx !== ctx.anyValueTypeIdx;
      if (kind === "externref" || isRef) {
        thisInstrs = [{ op: "local.get", index: receiver.localIdx }];
        if (isRef) thisInstrs.push({ op: "extern.convert_any" });
      }
      return receiver;
    },
    teeRawValue() {
      rawLocal = allocLocal(fctx, `__cpaf_raw_${fctx.locals.length}`, EXTERNREF);
      fctx.body.push({ op: "local.tee", index: rawLocal });
    },
    wrapLadder(ladderStart, closureLocal, argLocals, expected) {
      const applyIdx = ctx.funcMap.get("__apply_closure");
      const newIdx = ctx.funcMap.get("__objvec_new");
      const pushIdx = ctx.funcMap.get("__objvec_push");
      const result = fallbackResultInstrs(ctx, fctx, expected);
      if (rawLocal < 0 || applyIdx === undefined || newIdx === undefined || pushIdx === undefined) return;
      if (result === null) return;
      // Built after the ladder, so the ladder instructions were live (and
      // shift-tracked) while they were emitted; only now are they moved.
      const argv = allocLocal(fctx, `__cpaf_argv_${fctx.locals.length}`, EXTERNREF);
      const apply: Instr[] = [
        { op: "call", funcIdx: newIdx },
        { op: "local.set", index: argv },
      ];
      for (let index = 0; index < views.length; index++) {
        const view = views[index]!(argLocals[index]!);
        if (view === null) return;
        apply.push({ op: "local.get", index: argv }, ...view, { op: "call", funcIdx: pushIdx });
      }
      apply.push({ op: "local.get", index: rawLocal }, ...thisInstrs, { op: "local.get", index: argv });
      apply.push({ op: "call", funcIdx: applyIdx }, ...result);
      const ladder = fctx.body.splice(ladderStart);
      fctx.body.push(
        { op: "local.get", index: closureLocal },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: expected === null ? { kind: "empty" } : { kind: "val", type: expected },
          then: apply,
          else: ladder,
        },
      );
    },
  };
}
