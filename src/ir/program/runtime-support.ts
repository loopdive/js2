// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachNestedBuffer, type AllocSiteId, type IrFunction, type IrInstr } from "../core/nodes.js";
import type { IrSupportRefType, IrType } from "../core/types.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrSourceId, IrUnitId } from "../../shared/contracts/ir-identity.js";
import { irNativeAsyncCallableDeclaration } from "../runtime/native-async-callables.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import { preparedIrDataMismatch } from "./data.js";
import { irCallableBindingKey } from "../core/callable-bindings.js";
import { numberFormatRadixSupportDeclarations } from "./formatter-support.js";
import type { TypedIrProgramInput } from "./input-contracts.js";

export type IrFormatterKernelRole = "new" | "get" | "set" | "fin" | "trap";

/** A compiler support declaration, distinct from an ordinary source callable. */
export interface IrRuntimeSupportCallable {
  readonly ref: IrFuncRef;
  readonly params: readonly IrType[];
  readonly results: readonly IrType[];
}

export interface IrRuntimeSupportCallOccurrence {
  readonly path: readonly (string | number)[];
  readonly target: IrFuncRef;
}

export interface IrRuntimeSupportLiteralOccurrence {
  readonly path: readonly (string | number)[];
  readonly value: string;
  readonly alloc: AllocSiteId;
}

/** Fully built semantic IR, never source text or a deferred compiler callback. */
export interface IrNumberFormatRadixSupport {
  readonly kind: "number-format-radix-v1";
  readonly sourceId: IrSourceId;
  readonly demandOwners: readonly IrUnitId[];
  readonly source: {
    readonly definition: "numToStringRadixDef";
    readonly functionName: "__sh_num_toString_radix";
    readonly utf8Bytes: 1618;
    readonly sha256: "7b13099fbed0a87079f92e9bddbf75959065ed28daf66d5ad344e0b240037dc6";
  };
  readonly scratch: {
    readonly type: IrSupportRefType;
    readonly storage: { readonly kind: "array"; readonly element: "i16"; readonly mutable: true };
    readonly stringDataRole: readonly ["string-type", "data"];
  };
  readonly kernels: readonly [
    IrRuntimeSupportCallable & { readonly role: "new" },
    IrRuntimeSupportCallable & { readonly role: "get" },
    IrRuntimeSupportCallable & { readonly role: "set" },
    IrRuntimeSupportCallable & { readonly role: "fin" },
    IrRuntimeSupportCallable & { readonly role: "trap" },
  ];
  readonly implementation: {
    readonly declaration: IrRuntimeSupportCallable;
    readonly body: IrFunction;
  };
  /** Post-hygiene occurrences; source call counts are a separate proof. */
  readonly calls: readonly IrRuntimeSupportCallOccurrence[];
  readonly literals: readonly IrRuntimeSupportLiteralOccurrence[];
}

export interface IrRuntimeSupport {
  readonly schema: "ir-runtime-support-v1";
  readonly batches: readonly IrNumberFormatRadixSupport[];
}

function invalidSupport(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `runtime support: ${detail}`);
}

function sameSupport(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) invalidSupport(detail);
}

type SupportPath = readonly (string | number)[];

/** Paths only: the canonical walker below remains the buffer-population authority. */
function childPaths(instr: IrInstr): readonly SupportPath[] {
  switch (instr.kind) {
    case "if":
    case "if.stmt":
      return [["then"], ["else"]];
    case "forof.vec":
    case "forof.iter":
    case "forof.string":
    case "labeled.block":
      return [["body"]];
    case "while.loop":
      return [["cond"], ["body"]];
    case "for.loop":
      return [["cond"], ["body"], ["update"]];
    case "try":
      return [
        ["body"],
        ...(instr.catchClause ? [["catchClause", "body"]] : []),
        ...(instr.finallyBody ? [["finallyBody"]] : []),
      ];
    case "switch":
      return instr.bodies.map((_, index) => ["bodies", index]);
    default:
      return [];
  }
}

function walkSupportBody(body: IrFunction, visit: (instr: IrInstr, path: SupportPath) => void): void {
  const active = new Set<readonly IrInstr[]>();
  const walk = (buffer: readonly IrInstr[], prefix: SupportPath): void => {
    if (!Array.isArray(buffer) || active.has(buffer)) invalidSupport("missing or cyclic support buffer");
    active.add(buffer);
    for (let index = 0; index < buffer.length; index++) {
      const instr = buffer[index];
      if (!Object.hasOwn(buffer, index) || !instr) invalidSupport("sparse support buffer");
      const path = [...prefix, index];
      visit(instr, path);
      const paths = childPaths(instr);
      let ordinal = 0;
      forEachNestedBuffer(instr, (child) => {
        const relative = paths[ordinal++];
        if (!relative) invalidSupport("unmapped canonical child buffer");
        let target: unknown = instr;
        for (const key of relative) {
          if (!target || typeof target !== "object" || !Object.hasOwn(target, key))
            invalidSupport("missing child-buffer path");
          target = (target as Record<string | number, unknown>)[key];
        }
        if (target !== child) invalidSupport("child-buffer path disagrees with canonical traversal");
        walk(child, [...path, ...relative]);
      });
      if (ordinal !== paths.length) invalidSupport("extra child-buffer path");
    }
    active.delete(buffer);
  };
  if (!Array.isArray(body.blocks) || body.blocks.length === 0) invalidSupport("missing support entry block");
  for (let index = 0; index < body.blocks.length; index++) {
    if (!Object.hasOwn(body.blocks, index) || !body.blocks[index]) invalidSupport("sparse support blocks");
    walk(body.blocks[index]!.instrs, ["blocks", index, "instrs"]);
  }
}

/** Recount executable positions, including aliased sibling buffers separately. */
export function irRuntimeSupportOccurrences(body: IrFunction): {
  readonly calls: readonly IrRuntimeSupportCallOccurrence[];
  readonly literals: readonly IrRuntimeSupportLiteralOccurrence[];
} {
  const calls: IrRuntimeSupportCallOccurrence[] = [];
  const literals: IrRuntimeSupportLiteralOccurrence[] = [];
  walkSupportBody(body, (instr, path) => {
    if (instr.kind === "call") calls.push({ path, target: instr.target });
    if (instr.kind === "string.const") {
      if (instr.alloc === undefined) invalidSupport("support literal has no allocation identity");
      literals.push({ path, value: instr.value, alloc: instr.alloc });
    }
  });
  return { calls, literals };
}

function exactSupportKeys(value: unknown, keys: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidSupport(`invalid ${label}`);
  sameSupport(Object.keys(value).sort(), [...keys].sort(), `${label} field population`);
}

/** Structural support checks; full SSA and allocation analyses stay in program validation. */
export function assertIrRuntimeSupport(
  input: Pick<TypedIrProgramInput, "inventory" | "ir" | "derivedUnits" | "allocations">,
  support: IrRuntimeSupport | undefined,
): void {
  const demanded = irNumberFormatDemandOwners(input.ir.functions);
  if (demanded.length === 0) {
    if (support !== undefined) invalidSupport("support supplied without primary demand");
    return;
  }
  if (!support) invalidSupport("missing demanded formatter support");
  exactSupportKeys(support, ["schema", "batches"], "support");
  if (support.schema !== "ir-runtime-support-v1" || !Array.isArray(support.batches) || support.batches.length !== 1)
    invalidSupport("invalid support schema or batch population");
  const batch = support.batches[0];
  exactSupportKeys(
    batch,
    ["kind", "sourceId", "demandOwners", "source", "scratch", "kernels", "implementation", "calls", "literals"],
    "radix batch",
  );
  const entries = input.inventory.sources.filter((source) => source.kind === "entry");
  if (entries.length !== 1 || !batch || batch.sourceId !== entries[0]!.id || batch.kind !== "number-format-radix-v1")
    invalidSupport("invalid radix source anchor");
  sameSupport(batch.demandOwners, demanded, "stale primary demand owners");
  for (const owner of demanded) {
    const records = [...input.inventory.allUnits, ...input.derivedUnits].filter((record) => record.id === owner);
    if (records.length !== 1 || !input.inventory.sources.some((source) => source.id === records[0]!.sourceId))
      invalidSupport("formatter demand has no exact source owner");
  }
  sameSupport(
    batch.source,
    {
      definition: "numToStringRadixDef",
      functionName: "__sh_num_toString_radix",
      utf8Bytes: 1618,
      sha256: "7b13099fbed0a87079f92e9bddbf75959065ed28daf66d5ad344e0b240037dc6",
    },
    "changed radix source provenance",
  );
  const declared = numberFormatRadixSupportDeclarations(batch.sourceId);
  sameSupport(batch.scratch, declared.scratch, "changed scratch contract");
  sameSupport(batch.kernels, declared.kernels, "changed kernel declarations");
  exactSupportKeys(batch.implementation, ["declaration", "body"], "radix implementation");
  sameSupport(batch.implementation.declaration, declared.implementation, "changed radix declaration");
  const body = batch.implementation.body;
  if (
    [...input.inventory.allUnits, ...input.derivedUnits].some((unit) => unit.id === declared.ownerUnitId) ||
    input.ir.functions.some((fn) => fn.unitId === declared.ownerUnitId)
  )
    invalidSupport("support body contaminates the ordinary source population");
  if (!body || body.unitId !== declared.ownerUnitId || body.name !== declared.implementation.ref.name || body.exported)
    invalidSupport("foreign support body identity");
  if (
    (body.funcKind !== undefined && body.funcKind !== "regular") ||
    ["closureSubtype", "asyncPlan", "asyncRuntime", "generatorBufferSlot"].some((key) => Object.hasOwn(body, key))
  )
    invalidSupport("unsupported radix attachment");
  sameSupport(
    body.params.map((param: IrFunction["params"][number]) => param.type),
    declared.implementation.params,
    "changed radix parameters",
  );
  sameSupport(body.resultTypes, declared.implementation.results, "changed radix results");
  const occurrences = irRuntimeSupportOccurrences(body);
  sameSupport(batch.calls, occurrences.calls, "stale support call occurrences");
  sameSupport(batch.literals, occurrences.literals, "stale support literal occurrences");
  const kernels = new Map(declared.kernels.map((kernel) => [irCallableBindingKey(kernel.ref.binding), kernel]));
  walkSupportBody(body, (instr) => {
    if (instr.kind === "call") {
      const callee = kernels.get(irCallableBindingKey(instr.target.binding));
      if (!callee) invalidSupport("undeclared support callable");
      sameSupport(instr.target, callee.ref, "changed support callable reference");
      if (instr.args.length !== callee.params.length) invalidSupport("support call argument count");
      sameSupport(instr.resultType, callee.results[0] ?? null, "support call result contract");
      if (callee.role === "fin" && instr.alloc === undefined) invalidSupport("fin result has no string allocation");
    }
    if (
      instr.kind.startsWith("global.") ||
      instr.kind.startsWith("closure.") ||
      instr.kind.startsWith("class.") ||
      instr.kind.startsWith("extern.") ||
      instr.kind === "raw.wasm" ||
      instr.kind === "await"
    )
      invalidSupport("undeclared support dependency");
    if (instr.alloc !== undefined) {
      let id: number = instr.alloc;
      const visited = new Set<number>();
      for (;;) {
        if (!Number.isSafeInteger(id) || id < 0 || id >= input.allocations.size || visited.has(id))
          invalidSupport("missing or cyclic support allocation");
        visited.add(id);
        const entry = input.allocations.entries[id];
        if (!entry || entry.state === "retired") invalidSupport("support allocation is not live");
        if (entry.state === "aliased") {
          id = entry.to;
          continue;
        }
        if (entry.site.id !== id || entry.site.kind !== "string") invalidSupport("foreign support allocation kind");
        sameSupport(entry.site.type, { kind: "string" }, "support allocation type");
        break;
      }
    }
  });
}

/**
 * Recollect demand from primary executable bodies, independently of a batch's
 * own demand receipt. This is a demand census, not selected-provider authority.
 * Source preparation and final validation use the same traversal on their own
 * current bodies; support functions never manufacture primary demand owners.
 */
export function irNumberFormatDemandOwners(functions: readonly IrFunction[]): readonly IrUnitId[] {
  const owners: IrUnitId[] = [];
  const seen = new Set<IrUnitId>();
  const active = new Set<readonly IrInstr[]>();
  const dense = <T>(items: readonly T[], label: string, visit: (item: T) => void): void => {
    if (!Array.isArray(items)) invalidSupport(`missing ${label}`);
    for (let index = 0; index < items.length; index++) {
      if (!Object.hasOwn(items, index) || items[index] === undefined) invalidSupport(`sparse ${label}`);
      visit(items[index]!);
    }
  };
  dense(functions, "primary functions", (fn) => {
    if (!fn || !fn.unitId || seen.has(fn.unitId)) invalidSupport("missing or duplicate primary owner");
    seen.add(fn.unitId);
    let demanded = false;
    const visit = (buffer: readonly IrInstr[]): void => {
      if (active.has(buffer)) invalidSupport("cyclic executable buffer");
      active.add(buffer);
      dense(buffer, "executable instructions", (instr) => {
        if (!instr) invalidSupport("missing executable instruction");
        const ref = instr.kind === "call" ? instr.target : instr.kind === "closure.new" ? instr.liftedFunc : undefined;
        if (ref && irNativeAsyncCallableDeclaration(ref)?.feature === "async.native.number-to-string") {
          if (instr.kind !== "call") invalidSupport("formatter support requires a direct canonical call");
          demanded = true;
        }
        // Never stop after the first hit: malformed later buffers still fail.
        forEachNestedBuffer(instr, visit);
      });
      active.delete(buffer);
    };
    dense(fn.blocks, "primary blocks", (block) => visit(block.instrs));
    if (fn.asyncPlan) dense(fn.asyncPlan.states, "semantic async states", (state) => visit(state.body));
    if (demanded) owners.push(fn.unitId);
  });
  return Object.freeze(owners);
}

/** Additional bodies only; never substitutes for the primary program population. */
export function irRuntimeSupportFunctions(support: IrRuntimeSupport | undefined): readonly IrFunction[] {
  return support === undefined ? [] : support.batches.map((batch) => batch.implementation.body);
}
