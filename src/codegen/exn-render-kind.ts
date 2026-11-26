// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7453) The error KIND of a thrown payload, for a JS-side harness that must
 * tell an Error object from any other thrown value.
 *
 * A natively-thrown payload is a WasmGC ref the host cannot inspect, so the
 * test262 runtime-negative verdict could only take the kind from the module's
 * own `String(payload)` (`__exn_render_*`) up to the first `": "` — and then
 * `throw "TypeError: x"`, or an object whose `toString` returns that text, read
 * as a TypeError. `__exn_render_kind(payload: externref) -> i32` answers the
 * kind itself, through the same render buffer `__exn_render_char` reads:
 *
 *   - `$Error_struct`             → its name (§20.5.3.4 step 3: the `name`
 *                                   field when it is a string, else "Error")
 *   - a declined harness fnctor or
 *     a user error class           → the constructor's name (`errorRenderArms`)
 *   - anything else (a string, a number, a plain object, null) → -1: no kind
 *
 * The arms are the ones `__exn_render_prepare` renders as `Name: message`, so
 * an Error object keeps exactly the kind its rendered text named before.
 * Published only under the `exceptionKindExport` harness opt-in.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { storeAndReturnLen } from "./exn-render-lite.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";
import { addFuncType } from "./registry/types.js";

/** A struct the renderer prints as `Name: message`: its type, its `message` field and `Name`. */
export interface ErrorRenderArm {
  readonly typeIdx: number;
  readonly fieldIdx: number;
  readonly fieldIsExtern: boolean;
  readonly name: string;
}

function messageArm(ctx: CodegenContext, typeIdx: number, fieldsKey: string, name: string): ErrorRenderArm | undefined {
  const fields = ctx.structFields.get(fieldsKey);
  const fieldIdx = fields === undefined ? -1 : fields.findIndex((f) => f.name === "message");
  if (fields === undefined || fieldIdx < 0) return undefined;
  const ft = fields[fieldIdx].type;
  if (ft.kind !== "externref" && ft.kind !== "anyref" && ft.kind !== "ref" && ft.kind !== "ref_null") return undefined;
  return { typeIdx, fieldIdx, fieldIsExtern: ft.kind === "externref", name };
}

/**
 * The error structs besides `$Error_struct` that the module can throw.
 *
 * (#4394) A DECLINED harness error fnctor (new-builtin-globals.ts): `new
 * Test262Error(msg)` in a module that DECLARES `function Test262Error`
 * constructs an ordinary user-fnctor instance, which matches no `$Error_struct`
 * arm in `__any_to_string`.
 * (#4097) A thrown USER-CLASS error instance, keyed on the struct's own
 * registered name so IR and legacy read alike. Gated on `ctx.classSet` (local
 * class declarations only) plus a `message` field, so a plain data class stays
 * "[object Object]"; `$Error_struct` is skipped — `__any_to_string` already
 * routes it through §20.5.3.4.
 */
export function errorRenderArms(ctx: CodegenContext): ErrorRenderArm[] {
  const arms: ErrorRenderArm[] = [];
  for (const name of ctx.exnRenderFnctorErrorNames ?? []) {
    const typeIdx = ctx.fnctorReservedTypeIdx.get(name);
    const arm = typeIdx === undefined ? undefined : messageArm(ctx, typeIdx, `__fnctor_${name}`, name);
    if (arm) arms.push(arm);
  }
  for (const [typeIdx, structName] of ctx.typeIdxToStructName) {
    if (typeIdx === ctx.errorStructTypeIdx || !ctx.classSet.has(structName)) continue;
    const arm = messageArm(ctx, typeIdx, structName, structName);
    if (arm) arms.push(arm);
  }
  return arms;
}

/**
 * §20.5.3.4 steps 3–4 on the `$Error_struct` ref on the stack: its `name` field
 * when that is a native string, else "Error". `tmp` is an `anyref` local.
 */
export function errorStructNameInstrs(ctx: CodegenContext, errStructIdx: number, tmp: number): Instr[] {
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  return [
    { op: "struct.get", typeIdx: errStructIdx, fieldIdx: 2 }, // $name (externref)
    { op: "any.convert_extern" },
    { op: "local.tee", index: tmp },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: [
        { op: "local.get", index: tmp },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
      ],
      else: nativeStringLiteralInstrs(ctx, "Error"),
    },
  ];
}

/**
 * The `__exn_render_kind` body. Built BEFORE any export function is minted
 * (the index-shift-safety contract of `emitExceptionRenderExports`): it only
 * interns literal globals.
 */
export function exnRenderKindBody(
  ctx: CodegenContext,
  arms: readonly ErrorRenderArm[],
  bufGlobalIdx: number,
  flattenIdx: number,
  flatTypeIdx: number,
): Instr[] {
  const payload: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }];
  const kindArm = (typeIdx: number, nameInstrs: Instr[]): Instr[] => [
    ...payload,
    { op: "ref.test", typeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...nameInstrs, ...storeAndReturnLen(flattenIdx, bufGlobalIdx, flatTypeIdx)],
    },
  ];
  const errStructIdx = ctx.errorStructTypeIdx;
  const body: Instr[] =
    errStructIdx < 0
      ? []
      : kindArm(errStructIdx, [
          ...payload,
          { op: "ref.cast", typeIdx: errStructIdx },
          ...errorStructNameInstrs(ctx, errStructIdx, 1),
        ]);
  for (const arm of arms) body.push(...kindArm(arm.typeIdx, nativeStringLiteralInstrs(ctx, arm.name)));
  body.push({ op: "i32.const", value: -1 });
  return body;
}

/** Mint and export `__exn_render_kind` with a body from `exnRenderKindBody`. */
export function pushExnRenderKindExport(ctx: CodegenContext, body: Instr[]): void {
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$exn_render_prepare_type");
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__exn_render_kind", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__exn_render_kind",
    typeIdx,
    locals: [{ name: "tmp", type: { kind: "anyref" } }],
    body,
    exported: true,
  } as WasmFunction);
  ctx.mod.exports.push({ name: "__exn_render_kind", desc: { kind: "func", index: funcIdx } });
}
