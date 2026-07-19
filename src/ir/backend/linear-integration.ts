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
// linear DIRECT path, which remains the module driver and fallback.
//
// GATING: L4 made the proven L1-L3 families default-on. Set
// `JS2WASM_LINEAR_IR=0` for the byte-identical direct-backend escape hatch;
// `=1` remains accepted for explicit CI/probe runs.
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
// fixed-number vecs plus numeric object/ref-cell layouts; L3 maps strings to
// the direct backend's i32 arena pointer and UTF-8 runtime. from-ast keeps the
// representation abstract in each case. Union, dynamic boxing, closure/class,
// string iteration, and residual prototype methods stay absent and therefore
// demote through the same legality/build channel.

import { ts } from "../../ts-api.js";
import type { LinearContext } from "../../codegen-linear/context.js";
import { LINEAR_GENERIC_OBJECT_TAG } from "../../codegen-linear/layout.js";
import {
  LINEAR_IR_STRING_CHAR_CODE_AT_FN,
  LINEAR_IR_VEC_INIT_F64_FN,
  linearStringLiteralInstrs,
} from "../../codegen-linear/runtime.js";
import { IR_STRING_COMPARE_FN, lowerFunctionAstToIr, type IrFromAstResolver, typeNodeToIr } from "../from-ast.js";
import { lowerIrFunctionBody, type IrLowerResolver } from "../lower.js";
import { AllocSiteRegistry } from "../alloc-registry.js";
import {
  defaultOperationsForLayout,
  DEFAULT_ARENA_POLICY,
  linearRuntimeOperationKey,
  planLinearMemory,
  planLinearStringLayout,
  planLinearVectorLayout,
  type LinearAllocationSitePlan,
  type LinearAllocatorPolicy,
  type LinearMemoryPlan,
  type LinearRecordLayoutPlan,
  type LinearRuntimeOperation,
  type LinearStorageKind,
} from "../analysis/linear-memory-plan.js";
import {
  asVal,
  irVal,
  type AllocSiteId,
  type IrFuncRef,
  type IrFunction,
  type IrGlobalRef,
  type IrObjectShape,
  type IrType,
  type IrTypeRef,
} from "../nodes.js";
import { planIrCompilation } from "../select.js";
import type { FuncTypeDef, Instr, ValType, WasmFunction } from "../types.js";
import { verifyIrFunction } from "../verify.js";
import type { TypeConverter } from "./contract.js";
import { verifyIrBackendLegality } from "./legality.js";
import { LinearEmitter } from "./linear-emitter.js";
import type {
  IrRefCellLowering,
  IrVecLowering,
  LinearMemoryFieldLowering,
  LinearObjectLowering,
  LinearRefCellLowering,
  LinearVecLowering,
} from "./handles.js";

/** One function routed to the direct path, and its stable bucketed reason. */
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
  /** Selector rejections plus post-claim IR demotions, in direct-path order. */
  readonly rejected: readonly LinearIrRejection[];
  /** Deferred helpers appended only after every pre-assigned user slot. */
  readonly helpers: readonly LinearIrHelper[];
  /** Canonical middle-end allocation/layout decisions for this IR module. */
  readonly memoryPlan: LinearMemoryPlan;
}

export interface LinearIrHelper {
  readonly funcIdx: number;
  readonly name: string;
  readonly typeIdx: number;
  readonly fields: readonly { readonly name: string; readonly type: ValType; readonly offset: number }[];
  readonly layout: LinearRecordLayoutPlan;
  /** Symbolic until the module adapter assembles the deferred helper. */
  readonly allocate: LinearRuntimeOperation;
}

/** L4 gate: default-on, with an explicit `=0` direct-backend escape hatch. */
export function linearIrEnabled(): boolean {
  return typeof process === "undefined" || process.env?.JS2WASM_LINEAR_IR !== "0";
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
 * LINEAR backend. Precompute mutates only append-only/deduped func types and
 * the direct backend's string-literal data registry; the caller inserts the
 * returned functions at their pre-assigned `ctx.funcMap` slots.
 */
export function compileLinearIrFunctions(
  ctx: LinearContext,
  sourceFile: ts.SourceFile,
  allocationPolicy: LinearAllocatorPolicy = DEFAULT_ARENA_POLICY,
): LinearIrResult {
  const funcs = new Map<string, WasmFunction>();
  const compiled: string[] = [];
  const rejected: LinearIrRejection[] = [];
  const allocRegistry = new AllocSiteRegistry();
  let memoryPlan = planLinearMemory({ functions: [] }, allocRegistry, allocationPolicy);
  let helperStartFuncIdx = 0;
  for (const funcIdx of ctx.funcMap.values()) helperStartFuncIdx = Math.max(helperStartFuncIdx, funcIdx + 1);
  const { resolver, helpers, bindMemoryPlan } = makeLinearIrResolver(ctx, helperStartFuncIdx);
  const result: LinearIrResult = {
    funcs,
    compiled,
    rejected,
    helpers,
    get memoryPlan() {
      return memoryPlan;
    },
  };
  lastReport = result;

  // L4 folds the selector's per-function direct-path list into the same
  // ratchet as post-claim build/verify/legality demotions. Prefix the stable
  // selector reason so pre-claim and post-claim buckets cannot collide.
  const selection = planIrCompilation(sourceFile, { experimentalIR: true, trackFallbacks: true });
  for (const fallback of selection.fallbacks ?? []) {
    rejected.push({
      func: fallback.name,
      reason: `select:${fallback.reason}`,
      detail: fallback.detail,
    });
  }
  if (selection.funcs.size === 0) return result;

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
  const built = new Map<string, IrFunction>();
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
        // linear resolver exposes the landed L2 vec/aggregate and L3 string
        // shapes; every other representation-dependent family still throws
        // and demotes.
        const { main, lifted } = lowerFunctionAstToIr(decl, {
          checker: ctx.checker,
          exported,
          funcName: name,
          calleeTypes,
          resolver,
          allocRegistry,
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

        built.set(name, main);
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

  const plannedFunctions = claimedDecls.flatMap(({ name }) => {
    const fn = built.get(name);
    return fn ? [fn] : [];
  });
  memoryPlan = planLinearMemory({ functions: plannedFunctions }, allocRegistry, allocationPolicy);
  bindMemoryPlan(memoryPlan);

  // Lower only after the module-wide plan is complete. Every allocation-site
  // handle below is therefore a view of the same canonical decision.
  for (const { name } of claimedDecls) {
    const main = built.get(name);
    if (!main) {
      const failure = lastFailure.get(name);
      if (failure) rejected.push(failure);
      continue;
    }
    try {
      const emitter = new LinearEmitter({
        resolveRuntimeOperation: (operation) => resolveLinearRuntimeOperation(ctx, operation),
      });
      const body = lowerIrFunctionBody(main, resolver, emitter, linearValueTypeConverter(resolver, main.name));
      const vecScratchLocals = new Set(emitter.getVecScratchLocalIndices());
      const wasmLocals = body.locals.flatMap((local) =>
        local.slots.map((type, slot) => ({
          name: slot === 0 ? local.name : `${local.name}$${slot}`,
          type,
        })),
      );
      const locals = wasmLocals.map((local, index) => {
        const absoluteIndex = main.params.length + index;
        if (!vecScratchLocals.has(absoluteIndex)) return local;
        return { name: `$linear_vec_ptr_${index}`, type: { kind: "i32" as const } };
      });
      const stackOperations = stackFrameOperations(memoryPlan, name);
      if (stackOperations) {
        const markLocal = body.params.flatMap((param) => param.slots).length + locals.length;
        locals.push({ name: "$linear_stack_mark", type: { kind: "i32" } });
        instrumentLinearStackFrame(
          body.body,
          markLocal,
          resolveLinearRuntimeOperation(ctx, stackOperations.mark),
          resolveLinearRuntimeOperation(ctx, stackOperations.restore),
        );
      }
      funcs.set(name, {
        name: body.name,
        typeIdx: resolver.internFuncType({
          kind: "func",
          params: body.params.flatMap((param) => [...param.slots]),
          results: body.results.flatMap((result) => [...result]),
        }),
        locals,
        body: body.body,
        exported: body.exported,
      });
      compiled.push(name);
    } catch (e) {
      rejected.push({ func: name, reason: "build", detail: e instanceof Error ? e.message : String(e) });
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
 * The linear resolver: required name/table methods plus the L2 fixed-f64-vec,
 * aggregate/refcell subsets and the L3 i32-pointer string representation.
 * Other optional shape hooks remain absent — see the module header.
 */
function makeLinearIrResolver(
  ctx: LinearContext,
  helperStartFuncIdx: number,
): {
  resolver: IrLowerResolver & IrFromAstResolver;
  helpers: LinearIrHelper[];
  bindMemoryPlan(plan: LinearMemoryPlan): void;
} {
  const helpers: LinearIrHelper[] = [];
  const helperByShape = new Map<string, number>();
  const objects = new Map<string, LinearObjectLowering>();
  const refCells = new Map<string, LinearRefCellLowering>();
  const f64IrType = irVal({ kind: "f64" });
  const provisionalF64VectorLayout = planLinearVectorLayout(f64IrType);
  let memoryPlan: LinearMemoryPlan | undefined;

  const resolveRuntimeFunc = (name: string): number => {
    // Runtime functions were appended before user-slot pre-assignment. Scan
    // the actual defined-function table so a source function with a reserved
    // helper-like name cannot shadow the runtime entry in funcMap.
    const localIdx = ctx.mod.functions.findIndex((func) => func.name === name);
    if (localIdx < 0) throw new Error(`linear-ir: runtime helper '${name}' missing`);
    return ctx.numImportFuncs + localIdx;
  };

  const ensureAggregateHelper = (
    layout: LinearRecordLayoutPlan,
    allocate: LinearRuntimeOperation,
    fields: readonly { readonly name: string; readonly type: ValType; readonly offset: number }[],
  ): number => {
    const key = `${layout.id}:${linearRuntimeOperationKey(allocate)}`;
    const cached = helperByShape.get(key);
    if (cached !== undefined) return cached;

    const funcIdx = helperStartFuncIdx + helpers.length;
    const name = `__linear_ir_aggregate_new_${helpers.length}`;
    const typeIdx = internLinearFuncType(ctx, {
      kind: "func",
      params: fields.map((field) => field.type),
      results: [{ kind: "i32" }],
    });
    helpers.push({ funcIdx, name, typeIdx, fields, layout, allocate });
    helperByShape.set(key, funcIdx);
    ctx.funcMap.set(name, funcIdx);
    return funcIdx;
  };

  const allocationFor = (layoutId: string, alloc?: AllocSiteId): LinearAllocationSitePlan | undefined => {
    const plan = memoryPlan;
    if (!plan) return undefined;
    if (alloc !== undefined) {
      const allocation = plan.allocation(alloc);
      if (!allocation) throw new Error(`linear-ir: allocation site ${alloc as number} is absent from the plan`);
      if (allocation.layoutId !== layoutId) {
        throw new Error(
          `linear-ir: allocation site ${alloc as number} planned '${allocation.layoutId}', expected '${layoutId}'`,
        );
      }
      return allocation;
    }
    return plan.allocationsForLayout(layoutId)[0];
  };

  const plannedOperation = (
    layout: Parameters<typeof defaultOperationsForLayout>[0],
    allocation: LinearAllocationSitePlan | undefined,
    predicate: (operation: LinearRuntimeOperation) => boolean,
    label: string,
  ): LinearRuntimeOperation => {
    const operation = (allocation?.operations ?? defaultOperationsForLayout(layout)).find(predicate);
    if (!operation) throw new Error(`linear-ir: plan has no ${label} operation for '${layout.id}'`);
    return operation;
  };

  const linearFieldType = (storage: LinearStorageKind): ValType | null => {
    if (storage === "f64") return { kind: "f64" };
    if (storage === "i32" || storage === "pointer") return { kind: "i32" };
    return null;
  };

  const f64VecHandle = (alloc?: AllocSiteId): IrVecLowering & LinearVecLowering => {
    const layout = memoryPlan?.layoutForVector(f64IrType) ?? provisionalF64VectorLayout;
    const allocation = allocationFor(layout.id, alloc);
    const allocate = plannedOperation(
      layout,
      allocation,
      (operation) => operation.family === "vector" && operation.operation === "allocate",
      "vector allocation",
    );
    const initializeElement = plannedOperation(
      layout,
      allocation,
      (operation) => operation.family === "vector" && operation.operation === "initialize-element",
      "vector element initialization",
    );
    return {
      vecStructTypeIdx: 0,
      lengthFieldIdx: 0,
      dataFieldIdx: 0,
      arrayTypeIdx: 0,
      elementValType: { kind: "f64" },
      linearMemory: { allocation, layout, allocate, initializeElement },
    };
  };

  const resolver: IrLowerResolver & IrFromAstResolver = {
    resolveFunc(ref: IrFuncRef): number {
      // #2956 L3: from-ast keeps string comparison/method choice abstract.
      // Resolve those names onto the canonical linear UTF-8 runtime here.
      if (ref.name === IR_STRING_COMPARE_FN) return resolveRuntimeFunc("__str_cmp");
      if (ref.name === LINEAR_IR_STRING_CHAR_CODE_AT_FN || ref.name === "__str_slice") {
        return resolveRuntimeFunc(ref.name);
      }
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
      // Landed linear shapes resolve through their dedicated handles; symbolic
      // module type refs remain outside the claimed surface.
      throw new Error(`linear-ir: symbolic type '${ref.name}' outside the claimed scope`);
    },
    internFuncType(def: FuncTypeDef): number {
      return internLinearFuncType(ctx, def);
    },
    // #2956 L3: every linear string is the direct backend's canonical i32
    // arena pointer. The four string.* ops route through the same runtime
    // helpers/data-segment registry as direct AST codegen.
    resolveString(): ValType {
      return { kind: "i32" };
    },
    stringIsExternref(): boolean {
      return false;
    },
    hasHostNumberBox(): boolean {
      return false;
    },
    hasHostNumberToString(): boolean {
      return false;
    },
    stringMethodPlan(method: string) {
      if (method === "charCodeAt") {
        return {
          funcName: LINEAR_IR_STRING_CHAR_CODE_AT_FN,
          indexArgRep: "i32" as const,
          padOmitted: "charcode-zero" as const,
        };
      }
      if (method === "slice") {
        return {
          funcName: "__str_slice",
          indexArgRep: "i32" as const,
          padOmitted: "native-slice-len" as const,
        };
      }
      return null;
    },
    emitStringConst(value: string, alloc?: AllocSiteId): readonly Instr[] {
      const plan = memoryPlan;
      const layout = plan?.layouts.find((candidate) => candidate.kind === "string") ?? planLinearStringLayout();
      if (layout.kind !== "string") throw new Error("linear-ir: invalid string layout");
      const allocation = allocationFor(layout.id, alloc);
      const operation = plannedOperation(
        layout,
        allocation,
        (candidate) => candidate.family === "string" && candidate.operation === "materialize-data",
        "string materialization",
      );
      if (!plan || !allocation?.dataSegmentId) {
        throw new Error("linear-ir: string literal is absent from the completed memory plan");
      }
      const segment = plan.requireDataSegment(allocation.dataSegmentId);
      return linearStringLiteralInstrs(ctx, value, resolveLinearRuntimeOperation(ctx, operation), segment.bytes);
    },
    emitStringConcat(alloc?: AllocSiteId): readonly Instr[] {
      const layout = memoryPlan?.layouts.find((candidate) => candidate.kind === "string") ?? planLinearStringLayout();
      if (layout.kind !== "string") throw new Error("linear-ir: invalid string layout");
      const allocation = allocationFor(layout.id, alloc);
      const operation = plannedOperation(
        layout,
        allocation,
        (candidate) => candidate.family === "string" && candidate.operation === "concatenate",
        "string concatenation",
      );
      return [{ op: "call", funcIdx: resolveLinearRuntimeOperation(ctx, operation) }];
    },
    emitStringEquals(): readonly Instr[] {
      return [{ op: "call", funcIdx: resolveRuntimeFunc("__str_eq") }];
    },
    emitStringLen(): readonly Instr[] {
      return [{ op: "call", funcIdx: resolveRuntimeFunc("__str_length_utf16") }];
    },
    resolveObject(shape: IrObjectShape, alloc?: AllocSiteId): LinearObjectLowering | null {
      const layout = memoryPlan?.layoutForObjectShape(shape);
      if (!layout) throw new Error("linear-ir: object layout is absent from the completed memory plan");
      const allocation = allocationFor(layout.id, alloc);
      const allocate = plannedOperation(
        layout,
        allocation,
        (operation) => operation.family === "memory" && operation.operation === "allocate",
        "record allocation",
      );
      const key = `${layout.id}:${linearRuntimeOperationKey(allocate)}`;
      const cached = objects.get(key);
      if (cached) return cached;

      const fields = shape.fields.map((field, fieldIdx) => {
        const memory = layout.fields.find((candidate) => candidate.name === field.name);
        if (!memory) throw new Error(`linear-ir: object layout has no field '${field.name}'`);
        const type = linearFieldType(memory.storage);
        if (!type)
          throw new Error(`linear-ir: object field '${field.name}' has unsupported '${memory.storage}' storage`);
        return {
          name: field.name,
          fieldIdx,
          offset: memory.offset,
          type,
        };
      });
      const newFuncIdx = ensureAggregateHelper(layout, allocate, fields);
      const byName = new Map(fields.map((field) => [field.name, field]));
      const lowering: LinearObjectLowering = {
        typeIdx: 0,
        fieldIdx(name: string): number {
          const field = byName.get(name);
          if (!field) throw new Error(`linear-ir: object shape has no field '${name}'`);
          return field.fieldIdx;
        },
        linearMemory: {
          allocation,
          layout,
          allocate,
          newFuncIdx,
          fieldCount: fields.length,
          field(name: string): LinearMemoryFieldLowering {
            const field = byName.get(name);
            if (!field) throw new Error(`linear-ir: object shape has no field '${name}'`);
            return field;
          },
        },
      };
      objects.set(key, lowering);
      return lowering;
    },
    resolveRefCell(inner: ValType, alloc?: AllocSiteId): IrRefCellLowering | null {
      if (inner.kind !== "i32" && inner.kind !== "f64") return null;
      const layout = memoryPlan?.layoutForRefCell(irVal(inner));
      if (!layout) throw new Error("linear-ir: ref-cell layout is absent from the completed memory plan");
      const allocation = allocationFor(layout.id, alloc);
      const allocate = plannedOperation(
        layout,
        allocation,
        (operation) => operation.family === "memory" && operation.operation === "allocate",
        "ref-cell allocation",
      );
      const key = `${layout.id}:${linearRuntimeOperationKey(allocate)}`;
      const cached = refCells.get(key);
      if (cached) return cached;
      const value = layout.fields.find((field) => field.name === "value");
      if (!value) throw new Error("linear-ir: ref-cell layout has no value field");
      const memoryValue: LinearMemoryFieldLowering = { offset: value.offset, type: inner };
      const newFuncIdx = ensureAggregateHelper(layout, allocate, [
        { name: "value", type: inner, offset: value.offset },
      ]);
      const lowering: LinearRefCellLowering = {
        typeIdx: 0,
        fieldIdx: 0,
        linearMemory: { layout, allocate, newFuncIdx, value: memoryValue },
      };
      refCells.set(key, lowering);
      return lowering;
    },
    resolveVec(valType: ValType): IrVecLowering | null {
      return valType.kind === "i32" ? f64VecHandle() : null;
    },
    resolveVecForElement(elementValType: ValType, alloc?: AllocSiteId): IrVecLowering | null {
      return elementValType.kind === "f64" ? f64VecHandle(alloc) : null;
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

  return {
    resolver,
    helpers,
    bindMemoryPlan(plan: LinearMemoryPlan): void {
      if (memoryPlan) throw new Error("linear-ir: memory plan already bound");
      memoryPlan = plan;
    },
  };
}

/** Bind a symbolic plan operation to the existing linear runtime adapter. */
function resolveLinearRuntimeOperation(ctx: LinearContext, operation: LinearRuntimeOperation): number {
  let name: string | undefined;
  if (operation.family === "memory" && operation.operation === "allocate" && operation.allocationClass === "arena") {
    name = "__malloc";
  } else if (
    operation.family === "memory" &&
    operation.operation === "allocate" &&
    operation.allocationClass === "stack"
  ) {
    name = "__linear_stack_alloc";
  } else if (
    operation.family === "vector" &&
    operation.operation === "allocate" &&
    operation.allocationClass === "arena" &&
    operation.elementStorage === "f64"
  ) {
    name = "__arr_new";
  } else if (
    operation.family === "vector" &&
    operation.operation === "initialize-element" &&
    operation.allocationClass === "arena" &&
    operation.elementStorage === "f64"
  ) {
    name = LINEAR_IR_VEC_INIT_F64_FN;
  } else if (
    operation.family === "string" &&
    operation.operation === "materialize-data" &&
    operation.allocationClass === "arena" &&
    operation.elementStorage === "i8"
  ) {
    name = "__str_from_data";
  } else if (
    operation.family === "string" &&
    operation.operation === "concatenate" &&
    operation.allocationClass === "arena" &&
    operation.elementStorage === "i8"
  ) {
    name = "__str_concat";
  } else if (operation.family === "stack" && operation.operation === "mark") {
    name = "__linear_stack_mark";
  } else if (operation.family === "stack" && operation.operation === "restore") {
    name = "__linear_stack_restore";
  }
  if (!name) throw new Error(`linear-ir: no runtime binding for '${linearRuntimeOperationKey(operation)}'`);
  const localIdx = ctx.mod.functions.findIndex((func) => func.name === name);
  if (localIdx < 0) throw new Error(`linear-ir: runtime helper '${name}' missing`);
  return ctx.numImportFuncs + localIdx;
}

function stackFrameOperations(
  plan: LinearMemoryPlan,
  ownerFunction: string,
): { readonly mark: LinearRuntimeOperation; readonly restore: LinearRuntimeOperation } | null {
  const allocation = plan.allocations.find(
    (candidate) => candidate.ownerFunction === ownerFunction && candidate.allocationClass === "stack",
  );
  if (!allocation) return null;
  const mark = allocation.operations.find(
    (operation) => operation.family === "stack" && operation.operation === "mark",
  );
  const restore = allocation.operations.find(
    (operation) => operation.family === "stack" && operation.operation === "restore",
  );
  if (!mark || !restore) throw new Error(`linear-ir: stack allocation in '${ownerFunction}' lacks frame operations`);
  return { mark, restore };
}

function instrumentLinearStackFrame(
  body: Instr[],
  markLocal: number,
  markFuncIdx: number,
  restoreFuncIdx: number,
): void {
  const restore: Instr[] = [
    { op: "local.get", index: markLocal },
    { op: "call", funcIdx: restoreFuncIdx },
  ];
  const visit = (instrs: Instr[]): void => {
    for (let index = instrs.length - 1; index >= 0; index--) {
      const instr = instrs[index]!;
      if (instr.op === "return") {
        instrs.splice(index, 0, ...restore.map((item) => ({ ...item })));
      } else if (instr.op === "block" || instr.op === "loop") {
        visit(instr.body);
      } else if (instr.op === "if") {
        visit(instr.then);
        if (instr.else) visit(instr.else);
      } else if (instr.op === "try") {
        visit(instr.body);
        for (const clause of instr.catches) visit(clause.body);
        if (instr.catchAll) visit(instr.catchAll);
      }
    }
  };
  visit(body);
  body.unshift({ op: "call", funcIdx: markFuncIdx }, { op: "local.set", index: markLocal });
}

/** Materialize a deferred constructor after every user function slot exists. */
export function materializeLinearIrHelper(ctx: LinearContext, helper: LinearIrHelper): WasmFunction {
  if (helper.layout.size.kind !== "constant") {
    throw new Error(`linear-ir: aggregate helper '${helper.name}' requires a constant-size record`);
  }
  const totalSize = helper.layout.size.bytes;
  const pointerLocal = helper.fields.length;
  const body: Instr[] = [
    { op: "i32.const", value: totalSize },
    { op: "call", funcIdx: resolveLinearRuntimeOperation(ctx, helper.allocate) },
    { op: "local.tee", index: pointerLocal },
    { op: "i32.const", value: LINEAR_GENERIC_OBJECT_TAG },
    { op: "i32.store8", align: 0, offset: helper.layout.typeTagOffset },
    { op: "local.get", index: pointerLocal },
    { op: "i32.const", value: totalSize - helper.layout.headerBytes },
    { op: "i32.store", align: 2, offset: helper.layout.payloadSizeOffset },
  ];
  helper.fields.forEach((field, paramIndex) => {
    body.push({ op: "local.get", index: pointerLocal }, { op: "local.get", index: paramIndex });
    if (field.type.kind === "i32") {
      body.push({ op: "i32.store", align: 2, offset: field.offset });
    } else if (field.type.kind === "f64") {
      body.push({ op: "f64.store", align: 3, offset: field.offset });
    } else {
      throw new Error(`linear-ir: aggregate helper cannot store '${field.type.kind}' field '${field.name}'`);
    }
  });
  body.push({ op: "local.get", index: pointerLocal });
  return {
    name: helper.name,
    typeIdx: helper.typeIdx,
    locals: [{ name: "$aggregate_ptr", type: { kind: "i32" } }],
    body,
    exported: false,
  };
}

function internLinearFuncType(ctx: LinearContext, def: FuncTypeDef): number {
  const sameValType = (a: ValType, b: ValType): boolean =>
    a.kind === b.kind && (a as { typeIdx?: number }).typeIdx === (b as { typeIdx?: number }).typeIdx;
  for (let i = 0; i < ctx.mod.types.length; i++) {
    const type = ctx.mod.types[i]!;
    if (type.kind !== "func") continue;
    if (type.params.length !== def.params.length || type.results.length !== def.results.length) continue;
    if (
      type.params.every((param, index) => sameValType(param, def.params[index]!)) &&
      type.results.every((result, index) => sameValType(result, def.results[index]!))
    ) {
      return i;
    }
  }
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push(def);
  return typeIdx;
}

function linearValueTypeConverter(resolver: IrLowerResolver, funcName: string): TypeConverter<ValType> {
  return {
    backend: "linear",
    convertType(type: IrType): readonly ValType[] {
      if (type.kind === "val") return [type.val];
      if (type.kind === "string") return [{ kind: "i32" }];
      if (type.kind === "object" && resolver.resolveObject?.(type.shape)) return [{ kind: "i32" }];
      if (type.kind === "boxed") {
        const inner = asVal(type.inner);
        if (inner && resolver.resolveRefCell?.(inner)) return [{ kind: "i32" }];
      }
      throw new Error(`linear-ir: cannot carry IR type '${type.kind}' in ${funcName}`);
    },
  };
}
