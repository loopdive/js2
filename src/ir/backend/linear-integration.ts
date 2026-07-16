// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2956 slice L1 — the LINEAR backend consumes the IR front-end.
//
// `--target linear` historically branched ABOVE the IR (compiler.ts hands the
// AST straight to `generateLinearModule`), so the selector / from-ast / lower
// pipeline never ran for linear compiles. This module is the linear driver
// for IR-claimed functions: for each top-level FunctionDeclaration the
// selector claims, it builds IR ONCE via the SAME shared front-end the WasmGC
// path uses (`planIrCompilation` → `lowerFunctionAstToIr` → `verifyIrFunction`
// → `verifyIrBackendLegality("linear")`) and lowers it through the
// `LinearEmitter` (#1714/#2954) into a ready-to-insert `WasmFunction`.
// Everything that does not fit demotes — with a bucketed reason — to the
// linear DIRECT path, which remains the module driver and default.
//
// GATING (slice L1): the overlay only runs when `JS2WASM_LINEAR_IR=1` is set
// (mirrors the #2980 `JS2WASM_ASYNC_CARRIER_WIDEN` instrument pattern). Flag
// off ⇒ `generateLinearModule` is byte-identical to before this module
// existed. The default-ON flip is slice L4 (see the #2956 slice map).
//
// DESIGN NOTE — relation to the ratified L0 (adapter extraction): the #2956
// spec's L0 splits `src/ir/integration.ts` into a backend-neutral core + an
// `IrBackendIntegration` adapter. This driver deliberately does NOT touch
// integration.ts: every primitive it calls (`planIrCompilation`,
// `lowerFunctionAstToIr`, `verifyIrFunction`, `verifyIrBackendLegality`,
// `lowerIrFunctionBody`) is ALREADY backend-neutral and imported from its own
// module — nothing here duplicates integration.ts's selection/typeMap/report
// logic (the drift-clone the spec forbids). When L0/#3029-S3 lands, this
// driver becomes the `LinearIntegration` adapter implementation nearly
// verbatim; extracting the interface with TWO live consumers in view (this
// one and the WasmGC one) yields a better cut than a one-consumer refactor.
// Recorded in plan/issues/2956 §"Execution status".
//
// RESOLVER SCOPE: L1 supplies the four required name/table methods. L2 adds
// only the fixed-number-vec hooks: from-ast types the value as the linear
// backend's i32 arena pointer, while lower/emitter consume the existing vec
// layout contract. Union/boxed/object/closure/refcell/class/string hooks stay
// absent and therefore demote through the same legality/build channel.

import { ts } from "../../ts-api.js";
import type { LinearContext } from "../../codegen-linear/context.js";
import {
  LINEAR_IR_OBJ_INIT_F64_FN,
  LINEAR_IR_OBJ_NEW_FN,
  LINEAR_IR_VEC_INIT_F64_FN,
} from "../../codegen-linear/runtime.js";
import { lowerFunctionAstToIr, type IrFromAstResolver, typeNodeToIr } from "../from-ast.js";
import { lowerIrFunctionBody, type IrLowerResolver } from "../lower.js";
import type { IrFuncRef, IrGlobalRef, IrType, IrTypeRef, IrObjectShape } from "../nodes.js";
import { planIrCompilation } from "../select.js";
import type { FuncTypeDef, Instr, ValType, WasmFunction } from "../types.js";
import { verifyIrFunction } from "../verify.js";
import { verifyIrBackendLegality } from "./legality.js";
import { LinearEmitter } from "./linear-emitter.js";
import type { IrVecLowering } from "./handles.js";

/** One demoted claim: which function, and the bucketed reason. */
export interface LinearIrRejection {
  readonly func: string;
  /** Stable bucket key for the ratchet (scripts/check-linear-ir.mjs). */
  readonly reason: string;
  /** First error message — diagnostic detail, NOT part of the bucket key. */
  readonly detail?: string;
}

export interface LinearIrResult {
  /** name → IR-lowered function, ready to insert at the pre-assigned slot. */
  readonly funcs: Map<string, WasmFunction>;
  readonly compiled: readonly string[];
  readonly rejected: readonly LinearIrRejection[];
}

/** Slice-L1 gate: the overlay runs only under `JS2WASM_LINEAR_IR=1`. */
export function linearIrEnabled(): boolean {
  return typeof process !== "undefined" && process.env?.JS2WASM_LINEAR_IR === "1";
}

// Report side-channel for the ratchet harness (scripts/check-linear-ir.mjs):
// compiles are single-threaded within one process, so the harness reads the
// last module's report right after `compile()` returns. Deliberately NOT on
// the public CompileResult surface for slice 1.
let lastReport: LinearIrResult | undefined;
export function getLastLinearIrReport(): LinearIrResult | undefined {
  return lastReport;
}

/**
 * Build + lower every selector-claimed top-level FunctionDeclaration for the
 * LINEAR backend. Pure precompute: mutates nothing on `ctx.mod` except
 * interning func types (append-only, deduped); the caller inserts the
 * returned functions at their pre-assigned `ctx.funcMap` slots.
 */
export function compileLinearIrFunctions(ctx: LinearContext, sourceFile: ts.SourceFile): LinearIrResult {
  const funcs = new Map<string, WasmFunction>();
  const compiled: string[] = [];
  const rejected: LinearIrRejection[] = [];
  const result: LinearIrResult = { funcs, compiled, rejected };
  lastReport = result;

  const selection = planIrCompilation(sourceFile, { experimentalIR: true });
  if (selection.funcs.size === 0) return result;

  const resolver = makeLinearIrResolver(ctx);

  const claimedDecls: { name: string; decl: ts.FunctionDeclaration; exported: boolean }[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(stmt) || !stmt.name) continue;
    const name = stmt.name.text;
    if (!selection.funcs.has(name)) continue;
    const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    claimedDecls.push({ name, decl: stmt, exported });
  }
  if (claimedDecls.length === 0) return result;

  // Cross-function calls: from-ast resolves a top-level callee through
  // `calleeTypes`. The WasmGC integration seeds it from the Phase-2 TypeMap;
  // slice L1 seeds it by FIXPOINT instead — a successful build contributes
  // its own signature (`main.params[].type` / `main.resultTypes[0]`), and
  // functions that failed ONLY on a not-yet-known callee are retried with
  // the enriched map. Bounded by the claim count (each round must compile
  // at least one new function to continue).
  const calleeTypes = new Map<string, { params: readonly IrType[]; returnType: IrType | null }>();
  const lowered = new Map<string, WasmFunction>();
  const lastFailure = new Map<string, LinearIrRejection>();
  let pending = claimedDecls;

  // Pre-seed `calleeTypes` from ANNOTATIONS with from-ast's own primitive
  // mapping (`typeNodeToIr`) so SELF- and mutually-recursive claims (fib!)
  // resolve their own signature during the first build. Only fully-annotated
  // primitive signatures seed; anything else is left to the fixpoint below
  // (a wrong/absent seed just demotes, never mis-compiles — from-ast checks
  // the seed against annotations via `resolveIrType`).
  for (const { name, decl } of claimedDecls) {
    try {
      const params = decl.parameters.map((p) => typeNodeToIr(p.type, `pre-seed param of ${name}`));
      const returnType =
        decl.type === undefined || decl.type.kind === ts.SyntaxKind.VoidKeyword
          ? null
          : typeNodeToIr(decl.type, `pre-seed return of ${name}`);
      calleeTypes.set(name, { params, returnType });
    } catch {
      // Unannotated / non-primitive signature — no seed; the fixpoint may
      // still supply it from a successful build.
    }
  }

  for (let round = 0; round <= claimedDecls.length && pending.length > 0; round++) {
    const next: typeof pending = [];
    let progressed = false;

    for (const { name, decl, exported } of pending) {
      try {
        // Build through the SAME shared from-ast as WasmGC. The narrowed
        // linear resolver exposes only the L2 fixed-number-vec shape; every
        // other representation-dependent family still throws and demotes.
        const { main, lifted } = lowerFunctionAstToIr(decl, {
          checker: ctx.checker,
          exported,
          funcName: name,
          calleeTypes,
          resolver,
        });

        // Slice 1 lowers into PRE-ASSIGNED slots only; a build that
        // synthesizes lifted closures needs fresh slots (the WasmGC
        // integration's synthesized-func path) — demote until closures are
        // in linear scope.
        if (lifted.length > 0) {
          lastFailure.set(name, { func: name, reason: "lifted-closures" });
          progressed = true; // terminal — do not retry
          continue;
        }

        const verifyErrors = verifyIrFunction(main);
        if (verifyErrors.length > 0) {
          lastFailure.set(name, { func: name, reason: "verify", detail: verifyErrors[0]?.message });
          progressed = true; // terminal
          continue;
        }

        // The linear legality gate (#2954) — the capability predicate the
        // spec prescribes. Reject BEFORE lowering so an unsupported surface
        // is a bucketed demotion, not a lowering throw.
        const legality = verifyIrBackendLegality(main, "linear");
        if (legality.length > 0) {
          lastFailure.set(name, {
            func: name,
            reason: `illegal:${bucketFromLegalityMessage(legality[0]!.message)}`,
            detail: legality[0]?.message,
          });
          progressed = true; // terminal
          continue;
        }

        const emitter = new LinearEmitter({
          vecNewFuncIdx: ctx.funcMap.get("__arr_new"),
          vecInitF64FuncIdx: ctx.funcMap.get(LINEAR_IR_VEC_INIT_F64_FN),
          objNewFuncIdx: ctx.funcMap.get(LINEAR_IR_OBJ_NEW_FN),
          objInitF64FuncIdx: ctx.funcMap.get(LINEAR_IR_OBJ_INIT_F64_FN),
        });
        const body = lowerIrFunctionBody<Instr[]>(main, resolver, emitter);
        const vecScratchLocals = new Set(emitter.getVecScratchLocalIndices());
        const locals = body.locals.map((local, index) => {
          const absoluteIndex = main.params.length + index;
          if (!vecScratchLocals.has(absoluteIndex)) return local;
          // The shared lowerer allocates this scratch as a WasmGC array ref.
          // LinearEmitter reuses the SAME contract slot for the arena pointer;
          // normalize only that backend-private local before module insertion.
          return { name: `$linear_vec_ptr_${index}`, type: { kind: "i32" as const } };
        });
        lowered.set(name, {
          name: body.name,
          typeIdx: body.typeIdx,
          locals,
          body: body.body,
          exported: body.exported,
        });
        calleeTypes.set(name, {
          params: main.params.map((p) => p.type),
          returnType: main.resultTypes.length > 0 ? main.resultTypes[0]! : null,
        });
        lastFailure.delete(name);
        progressed = true;
      } catch (e) {
        // Fail-safe demote: the linear DIRECT path compiles this function
        // exactly as it does today (the overlay only ever ADDS capability).
        // A "call to unknown function" may resolve in a later round once
        // the callee's signature lands in `calleeTypes` — keep it pending.
        lastFailure.set(name, { func: name, reason: "build", detail: e instanceof Error ? e.message : String(e) });
        next.push({ name, decl, exported });
      }
    }

    pending = next;
    if (!progressed) break; // fixpoint: nothing new compiled or terminally rejected
  }

  for (const { name } of claimedDecls) {
    const fn = lowered.get(name);
    if (fn) {
      funcs.set(name, fn);
      compiled.push(name);
    } else {
      const failure = lastFailure.get(name);
      if (failure) rejected.push(failure);
    }
  }

  return result;
}

/**
 * Stable ratchet bucket from a legality error message. The message shapes
 * come from `legality.ts` (`linearInstrError` / `linearValTypeError`):
 *   "linear backend does not support IR instruction 'X' …" → `instr-X`
 *   "linear backend does not support ValType 'K'"          → `valtype-K`
 *   "linear backend does not support const 'K'"            → `const-K`
 */
function bucketFromLegalityMessage(message: string): string {
  const instr = /IR instruction '([^']+)'/.exec(message);
  if (instr) return `instr-${instr[1]}`;
  const valtype = /ValType '([^']+)'/.exec(message);
  if (valtype) return `valtype-${valtype[1]}`;
  const constKind = /const '([^']+)'/.exec(message);
  if (constKind) return `const-${constKind[1]}`;
  return "other";
}

/**
 * The linear resolver: required name/table methods plus the L2 fixed-f64-vec
 * subset. Other optional shape hooks remain absent — see the module header.
 */
function makeLinearIrResolver(ctx: LinearContext): IrLowerResolver & IrFromAstResolver {
  // Linear vecs have no module type indices: they are i32 pointers to the
  // canonical `[header][len][cap][f64 slots...]` runtime layout. The shared
  // resolver shape still carries the WasmGC index fields for lower.ts's
  // scratch bookkeeping; LinearEmitter never emits those sentinel indices,
  // and compileLinearIrFunctions rewrites that one scratch local to i32.
  const f64VecLayout: IrVecLowering = {
    vecStructTypeIdx: 0,
    lengthFieldIdx: 0,
    dataFieldIdx: 0,
    arrayTypeIdx: 0,
    elementValType: { kind: "f64" },
  };

  const objectLayouts = new Map<
    string,
    ReturnType<NonNullable<IrLowerResolver["resolveObject"]>> & { fieldCount: number }
  >();

  return {
    resolveFunc(ref: IrFuncRef): number {
      // (#2956 L2) Vec MUTATION rides from-ast's element-store helper call
      // `__vec_elem_set_<vecStructTypeIdx>` (the C2 path — element store and
      // `.push` both emit it). On linear the sentinel typeIdx is always 0
      // (the f64VecLayout below), and the direct runtime's
      // `__arr_set(ptr:i32, idx:i32, val:f64) -> void` has the SAME
      // signature and the same grow-on-OOB / zero-fill-gap / len-extension
      // semantics as the WasmGC `ensureVecElemSet` helper (a negative-index
      // no-op and #1977 forwarding resolution are safe supersets). Map the
      // helper name onto it — name-based, funcIdx-shift safe.
      if (ref.name.startsWith("__vec_elem_set_")) {
        const arrSet = ctx.funcMap.get("__arr_set");
        if (arrSet === undefined) {
          throw new Error(`linear-ir: __arr_set runtime helper missing for '${ref.name}'`);
        }
        return arrSet;
      }
      const idx = ctx.funcMap.get(ref.name);
      if (idx === undefined) {
        throw new Error(`linear-ir: no funcIdx for '${ref.name}' (selector claimed a call outside funcMap)`);
      }
      return idx;
    },
    resolveGlobal(ref: IrGlobalRef): number {
      const idx = ctx.moduleGlobals.get(ref.name);
      if (idx === undefined) {
        throw new Error(`linear-ir: no global for '${ref.name}'`);
      }
      return idx;
    },
    resolveType(ref: IrTypeRef): number {
      // Slice 1 carries no symbolic type refs (numeric/control-flow only) —
      // the legality gate rejects shape-typed functions before lowering.
      throw new Error(`linear-ir: symbolic type '${ref.name}' outside slice-1 scope`);
    },
    internFuncType(def: FuncTypeDef): number {
      // Dedupe against the linear module's type section (append-only, no
      // hoist pass on linear — the spec's "must not grow it per call").
      const sameValType = (a: ValType, b: ValType): boolean =>
        a.kind === b.kind && (a as { typeIdx?: number }).typeIdx === (b as { typeIdx?: number }).typeIdx;
      for (let i = 0; i < ctx.mod.types.length; i++) {
        const t = ctx.mod.types[i]!;
        if (t.kind !== "func") continue;
        if (t.params.length !== def.params.length || t.results.length !== def.results.length) continue;
        if (
          t.params.every((p, j) => sameValType(p, def.params[j]!)) &&
          t.results.every((r, j) => sameValType(r, def.results[j]!))
        ) {
          return i;
        }
      }
      const idx = ctx.mod.types.length;
      ctx.mod.types.push(def);
      return idx;
    },
    // (#2956 L2 aggregates) Fixed-shape anonymous object -> IR-internal
    // linear layout: i32 arena pointer value; uniform 8-byte f64 slots at
    // 8 + 8*i in the shape's canonical (name-sorted) field order. Legality
    // has already rejected non-f64 fields and boundary-crossing objects,
    // so this hook is total for everything that reaches lowering. Memoized
    // per shape-KEY (field names) — layouts are structural.
    resolveObject(shape: IrObjectShape) {
      const key = shape.fields.map((f) => f.name).join(",");
      let layout = objectLayouts.get(key);
      if (!layout) {
        const indexByName = new Map(shape.fields.map((f, i) => [f.name, i] as const));
        layout = {
          typeIdx: 0,
          valueType: { kind: "i32" } as const,
          fieldCount: shape.fields.length,
          fieldIdx(name: string): number {
            const idx = indexByName.get(name);
            if (idx === undefined) throw new Error(`linear-ir: object shape has no field '${name}'`);
            return idx;
          },
        };
        objectLayouts.set(key, layout);
      }
      return layout;
    },
    resolveVec(valType: ValType): IrVecLowering | null {
      return valType.kind === "i32" ? f64VecLayout : null;
    },
    resolveVecForElement(elementValType: ValType): IrVecLowering | null {
      return elementValType.kind === "f64" ? f64VecLayout : null;
    },
    resolveVecValueTypeForElement(elementValType: ValType): ValType | null {
      return elementValType.kind === "f64" ? { kind: "i32" } : null;
    },
    resolveVecOutOfBoundsConst(elementValType: ValType) {
      return elementValType.kind === "f64" ? { kind: "f64" as const, value: 0 } : null;
    },
    isVecValueExpression(expr: ts.Expression): boolean {
      try {
        const type = ctx.checker.getNonNullableType(ctx.checker.getTypeAtLocation(expr));
        if (!ctx.checker.isArrayType(type)) return false;
        const [element] = ctx.checker.getTypeArguments(type as ts.TypeReference);
        return element !== undefined && (element.flags & ts.TypeFlags.NumberLike) !== 0;
      } catch {
        return false;
      }
    },
  };
}
