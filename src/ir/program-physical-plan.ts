// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3518 package C — the source-free PHYSICAL SETUP PLAN for one accepted
// backend/target projection of a `PreparedIrProgram`.
//
// Acceptance derives this plan from the program's authoritative ABI entries,
// startup plans and the selected runtime projection — nothing else. It names
// every physical resource emission will reserve (imports, globals, function
// slots, exports with their index space, start adapter, exception tag) and,
// just as importantly, every resource this increment cannot yet materialize.
// A gap is a located, typed `unsupported` at ACCEPTANCE time; it is never a
// smaller module. The returned plan is deep-frozen data over A's types; this
// module imports no backend, codegen or frontend code.

import { irGlobalBindingKey } from "./abi-bindings.js";
import { irCallableBindingKey, irUnitCallableBindingId } from "./callable-bindings.js";
import type { IrBindingId, IrUnitId } from "./identity.js";
import { forEachInstrDeep, type IrFunction, type IrType } from "./nodes.js";
import type { IrPreparationFailure } from "./outcomes.js";
import {
  freezePreparedIrValue,
  preparedIrProgramOwner,
  PreparedIrProgramInvariantError,
  type PreparedIrAbiEntry,
  type PreparedIrBackendOptions,
  type PreparedIrProgram,
  type PreparedIrProgramFailure,
  type PreparedIrProgramRuntimeProjection,
} from "./program.js";
import type { ValType } from "./types.js";

export interface PhysicalFunctionSlot {
  readonly unitId: IrUnitId;
  readonly bindingId: IrBindingId;
  readonly name: string;
  readonly params: readonly ValType[];
  readonly results: readonly ValType[];
}

export interface PhysicalImportedFunction {
  readonly bindingId: IrBindingId;
  readonly referenceKey: string;
  readonly module: string;
  readonly field: string;
  readonly params: readonly ValType[];
  readonly results: readonly ValType[];
}

export interface PhysicalDefinedGlobal {
  readonly bindingId: IrBindingId;
  readonly referenceKey: string;
  readonly name: string;
  readonly type: ValType;
  readonly mutable: boolean;
}

export interface PhysicalImportedGlobal extends PhysicalDefinedGlobal {
  readonly module: string;
  readonly field: string;
}

export interface PhysicalExport {
  readonly externalName: string;
  readonly targetBindingId: IrBindingId;
  /** Index space of the canonical target, decided at planning. */
  readonly space: "function" | "global";
}

export interface PhysicalStartup {
  /** Executable startup bodies in semantic module-evaluation order. */
  readonly units: readonly IrUnitId[];
  readonly adapter: "none" | "wasm-start" | "deferred-export";
}

export interface PhysicalExceptionTag {
  /** Some body throws or catches, so a `__exn` tag must exist. */
  readonly required: boolean;
  /** Requested by the options: import `env.__exn` instead of defining a local tag. */
  readonly shared: boolean;
}

/** Everything emission will reserve, in the order it will reserve it. Deep-frozen. */
export interface PhysicalSetupPlan {
  readonly backend: PreparedIrBackendOptions["backend"];
  readonly target: PreparedIrBackendOptions["target"];
  readonly exceptionTag: PhysicalExceptionTag;
  readonly importedFunctions: readonly PhysicalImportedFunction[];
  readonly importedGlobals: readonly PhysicalImportedGlobal[];
  readonly definedGlobals: readonly PhysicalDefinedGlobal[];
  /** Projection order; every physical body gets exactly one slot. */
  readonly functions: readonly PhysicalFunctionSlot[];
  readonly exports: readonly PhysicalExport[];
  readonly startup: PhysicalStartup;
}

export type PhysicalSetupOutcome =
  | { readonly kind: "planned"; readonly plan: PhysicalSetupPlan }
  | PreparedIrProgramFailure;

function scalar(type: IrType): ValType | undefined {
  return type.kind === "val" ? type.val : undefined;
}

function numeric(type: ValType): boolean {
  return type.kind === "i32" || type.kind === "i64" || type.kind === "f32" || type.kind === "f64";
}

function typeLabel(type: IrType): string {
  return type.kind === "val" ? type.val.kind : type.kind;
}

class Gaps {
  readonly rows: { readonly unitId: IrUnitId | undefined; readonly detail: string }[] = [];
  add(detail: string, unitId?: IrUnitId): void {
    this.rows.push({ unitId, detail });
  }
}

/** Follow export aliases to the canonical required entry. */
function canonicalEntry(
  entries: ReadonlyMap<IrBindingId, PreparedIrAbiEntry>,
  id: IrBindingId,
): PreparedIrAbiEntry | undefined {
  const seen = new Set<IrBindingId>();
  let current = entries.get(id);
  while (current && current.plan.slotPolicy === "alias" && !seen.has(current.plan.id)) {
    seen.add(current.plan.id);
    current = entries.get(current.plan.aliasOf);
  }
  return current;
}

/**
 * Derive the physical setup for one projection, or the first located gap.
 * Only scalar carriers, unit/import callables, source/import globals, export
 * aliases onto functions or globals, wasm-start / deferred-export startup and
 * the `__exn` tag are materializable in this increment; every other need is
 * reported.
 */
export function planPhysicalSetup(
  program: PreparedIrProgram,
  options: PreparedIrBackendOptions,
  projection: PreparedIrProgramRuntimeProjection,
): PhysicalSetupOutcome {
  const gaps = new Gaps();
  const physical = projection.prepared.functions;
  const bodies = new Map<IrUnitId, IrFunction>(physical.map((fn) => [fn.unitId, fn] as const));
  const entries = new Map<IrBindingId, PreparedIrAbiEntry>(program.abi.entries.map((entry) => [entry.plan.id, entry]));

  const convert = (types: readonly IrType[], where: string, unitId?: IrUnitId): ValType[] => {
    const out: ValType[] = [];
    for (const type of types) {
      const value = scalar(type);
      if (!value) {
        gaps.add(
          `${where} carries non-scalar IR type ${typeLabel(type)}; physical carrier materialization is not available`,
          unitId,
        );
      } else out.push(value);
    }
    return out;
  };

  // 1. Function slots: one per physical body, signature from the body's own ABI contract.
  const functions: PhysicalFunctionSlot[] = [];
  for (const fn of physical) {
    const bindingId = irUnitCallableBindingId(fn.unitId);
    const own = entries.get(bindingId);
    if (own?.contract.kind !== "callable") {
      gaps.add(`body ${fn.name} has no declared callable ABI entry`, fn.unitId);
      continue;
    }
    if (fn.asyncPlan || fn.asyncRuntime) {
      gaps.add(`async body ${fn.name} needs scheduler/promise runtime materialization`, fn.unitId);
    }
    functions.push({
      unitId: fn.unitId,
      bindingId,
      name: fn.name,
      params: convert(own.contract.params, `body ${fn.name} params`, fn.unitId),
      results: convert(own.contract.results, `body ${fn.name} results`, fn.unitId),
    });
  }

  // 2. Every other required slot: imports, globals, or a gap. Exports are resolved to their space.
  const importedFunctions: PhysicalImportedFunction[] = [];
  const importedGlobals: PhysicalImportedGlobal[] = [];
  const definedGlobals: PhysicalDefinedGlobal[] = [];
  const exports: PhysicalExport[] = [];
  for (const entry of program.abi.entries) {
    const { plan, contract } = entry;
    if (contract.kind === "export") {
      const target = canonicalEntry(entries, contract.targetId);
      if (!target || target.plan.slotPolicy !== "required") {
        gaps.add(`export ${contract.externalName} does not resolve to a required binding`);
      } else if (target.plan.slotSpace === "function" || target.plan.slotSpace === "global") {
        exports.push({
          externalName: contract.externalName,
          targetBindingId: contract.targetId,
          space: target.plan.slotSpace,
        });
      } else {
        gaps.add(
          `export ${contract.externalName} targets the ${target.plan.slotSpace} index space, which is not exportable`,
        );
      }
      continue;
    }
    if (plan.slotPolicy !== "required") continue;
    if (contract.kind === "callable") {
      const binding = contract.ref.binding;
      if (binding.kind === "unit") {
        if (!bodies.has(binding.unitId)) {
          gaps.add(
            `callable ${contract.ref.name} has no physical body in the ${options.backend}:${options.target} projection`,
            binding.unitId,
          );
        }
        continue;
      }
      if (binding.kind === "import") {
        importedFunctions.push({
          bindingId: plan.id,
          referenceKey: irCallableBindingKey(binding),
          module: binding.module,
          field: binding.field,
          params: convert(contract.params, `import ${binding.module}.${binding.field} params`),
          results: convert(contract.results, `import ${binding.module}.${binding.field} results`),
        });
        continue;
      }
      gaps.add(`${binding.kind} callable ${contract.ref.name} needs runtime function materialization`);
      continue;
    }
    if (contract.kind === "global") {
      const binding = contract.ref.binding;
      const type = scalar(contract.type);
      if (!type) {
        gaps.add(`global ${contract.ref.name} carries non-scalar IR type ${typeLabel(contract.type)}`);
        continue;
      }
      const base = {
        bindingId: plan.id,
        referenceKey: irGlobalBindingKey(binding),
        name: contract.ref.name,
        type,
        mutable: contract.mutable,
      };
      if (binding.kind === "import") {
        importedGlobals.push({ ...base, module: binding.module, field: binding.field });
      } else if (binding.kind === "source") {
        if (!numeric(type)) gaps.add(`source global ${contract.ref.name} needs a reference-typed default initializer`);
        else definedGlobals.push(base);
      } else {
        gaps.add(`${binding.kind} global ${contract.ref.name} needs runtime storage materialization`);
      }
      continue;
    }
    if (contract.kind === "type" || contract.kind === "class") {
      gaps.add(`${contract.kind} layout ${contract.ref.name} needs type materialization`);
      continue;
    }
    gaps.add(`support binding ${plan.id} (${contract.role}) needs runtime materialization`);
  }
  const exportNames = new Set<string>();
  for (const exported of exports) {
    if (exportNames.has(exported.externalName)) gaps.add(`export ${exported.externalName} is declared twice`);
    exportNames.add(exported.externalName);
  }

  // 3. Bodies may only reference what the plan reserves; exception use is a reserved resource too.
  const reserved = new Set<string>([
    ...functions.map((slot) => irCallableBindingKey({ kind: "unit", unitId: slot.unitId })),
    ...importedFunctions.map((fn) => fn.referenceKey),
  ]);
  const reservedGlobals = new Set<string>([...importedGlobals, ...definedGlobals].map((global) => global.referenceKey));
  let exceptionRequired = false;
  for (const fn of physical) {
    for (const buffer of [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((s) => s.body) ?? []),
    ]) {
      for (const root of buffer) {
        forEachInstrDeep(root, (instruction) => {
          if (instruction.kind === "call" || instruction.kind === "closure.new") {
            const ref = instruction.kind === "call" ? instruction.target : instruction.liftedFunc;
            if (!reserved.has(irCallableBindingKey(ref.binding))) {
              gaps.add(
                `body ${fn.name} references ${ref.binding.kind} callable ${ref.name} that the plan cannot reserve`,
                fn.unitId,
              );
            }
          } else if (instruction.kind === "global.get" || instruction.kind === "global.set") {
            if (!reservedGlobals.has(irGlobalBindingKey(instruction.target.binding))) {
              gaps.add(
                `body ${fn.name} references global ${instruction.target.name} that the plan cannot reserve`,
                fn.unitId,
              );
            }
          } else if (instruction.kind === "intrinsic") {
            const provider = instruction.provider;
            if (!provider) gaps.add(`body ${fn.name} intrinsic ${instruction.id} has no physical provider`, fn.unitId);
            else if (
              provider.kind !== "backend-op" &&
              provider.kind !== "backend-sequence" &&
              provider.kind !== "backend-composite"
            ) {
              gaps.add(
                `body ${fn.name} intrinsic ${instruction.id} needs ${provider.kind} provider materialization`,
                fn.unitId,
              );
            }
          } else if (instruction.kind === "throw" || instruction.kind === "try") {
            exceptionRequired = true;
          }
        });
      }
    }
  }

  // 4. Startup: executable units in semantic order, one adapter.
  const startupUnits: IrUnitId[] = [];
  let adapter: PhysicalStartup["adapter"] = "none";
  for (const plan of program.startup) {
    if (!plan.executable || plan.unitId === null) continue;
    if (!bodies.has(plan.unitId))
      gaps.add(`startup source ${plan.sourceId} has no physical initializer body`, plan.unitId);
    startupUnits.push(plan.unitId);
    const kind = plan.invocation.kind;
    if (kind === "wasm-start" || kind === "deferred-export") {
      if (adapter !== "none" && adapter !== kind) {
        gaps.add(`startup sources disagree on the invocation adapter (${adapter} vs ${kind})`, plan.unitId);
      }
      adapter = kind;
    } else {
      gaps.add(`startup adapter ${kind} is not materializable (only wasm-start and deferred-export)`, plan.unitId);
    }
  }
  if (adapter === "deferred-export" && exportNames.has("__module_init")) {
    gaps.add("deferred startup export __module_init collides with a program export of the same name");
  }

  // 5. Linear physical needs beyond scalar bodies.
  if (options.backend === "linear" && program.allocations.size > 0) {
    gaps.add(`linear memory plan for ${program.allocations.size} allocation site(s) is not materializable`);
  }

  if (gaps.rows.length > 0) {
    const first = gaps.rows[0]!;
    const unitId = first.unitId ?? physical[0]?.unitId ?? program.inventory.terminalUnits[0]?.id;
    if (!unitId) {
      throw new PreparedIrProgramInvariantError("invalid-prepared-data", `physical plan: ${first.detail}`);
    }
    const failure: IrPreparationFailure = {
      kind: "unsupported",
      code: "body-shape-rejected",
      stage: "build",
      detail: `${options.backend}:${options.target} physical setup cannot be materialized (${gaps.rows.length} gap${
        gaps.rows.length === 1 ? "" : "s"
      }): ${gaps.rows.map((row) => row.detail).join("; ")}`,
    };
    const owner = preparedIrProgramOwner(program, unitId);
    if (!owner)
      throw new PreparedIrProgramInvariantError("invalid-prepared-data", `physical plan cannot locate ${unitId}`);
    return Object.freeze({ ...failure, unitId: owner.unitId, location: owner.location, sourceFile: owner.sourceFile });
  }

  const plan: PhysicalSetupPlan = {
    backend: options.backend,
    target: options.target,
    exceptionTag: { required: exceptionRequired || options.sharedExceptionTag, shared: options.sharedExceptionTag },
    importedFunctions,
    importedGlobals,
    definedGlobals,
    functions,
    exports,
    startup: { units: startupUnits, adapter },
  };
  // Deep-frozen, null-prototype copy: nested records and arrays included.
  return { kind: "planned", plan: freezePreparedIrValue(plan) as PhysicalSetupPlan };
}
