// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrFunction } from "../core/nodes.js";
import type { PreparedIrProgram } from "./prepared-contracts.js";
import { preparedIrJsClassDefinitions } from "./js-class-definition.js";
import { assertNativeJsClassAllocations } from "./native-js-class-allocation-validation.js";

export interface PhysicalStartup {
  /** Executable startup bodies in semantic module-evaluation order. */
  readonly units: readonly IrUnitId[];
  readonly adapter: "none" | "wasm-start" | "deferred-export" | "wasi-start-export";
  readonly onceGuard?: true;
}

export function planPhysicalStartup(
  program: PreparedIrProgram,
  bodies: ReadonlyMap<IrUnitId, IrFunction>,
  exportNames: ReadonlySet<string>,
  gaps: { add(detail: string, unitId?: IrUnitId): void },
  target: RuntimeManifestPolicy["target"],
): PhysicalStartup {
  // 4. Startup: executable units in semantic order, one adapter.
  const startupUnits: IrUnitId[] = [];
  let adapter: PhysicalStartup["adapter"] = "none";
  for (const plan of program.startup) {
    if (!plan.executable || plan.unitId === null) continue;
    if (!bodies.has(plan.unitId))
      gaps.add(`startup source ${plan.sourceId} has no physical initializer body`, plan.unitId);
    startupUnits.push(plan.unitId);
    if ((target === "standalone" || target === "wasi") && typeof plan.invocation.deferTopLevelInit !== "boolean") {
      gaps.add("native startup lacks its explicit semantic deferral choice", plan.unitId);
      continue;
    }
    const kind =
      target === "wasi"
        ? "wasi-start-export"
        : target === "standalone"
          ? plan.invocation.deferTopLevelInit
            ? "deferred-export"
            : "wasm-start"
          : plan.invocation.kind;
    if (kind === "wasm-start" || kind === "deferred-export" || kind === "wasi-start-export") {
      if (adapter !== "none" && adapter !== kind) {
        gaps.add(`startup sources disagree on the invocation adapter (${adapter} vs ${kind})`, plan.unitId);
      }
      adapter = kind;
    } else {
      gaps.add(
        `startup adapter ${kind} is not materializable (only wasm-start, deferred-export and wasi-start-export)`,
        plan.unitId,
      );
    }
  }
  if (adapter === "deferred-export" && exportNames.has("__module_init")) {
    gaps.add("deferred startup export __module_init collides with a program export of the same name");
  }

  if (adapter === "wasi-start-export" && exportNames.has("_start"))
    gaps.add("WASI startup export _start collides with a program export of the same name");

  const onceGuard = program.abi.entries.some(
    ({ contract }) =>
      contract.kind === "global" && contract.ref.binding.kind === "source" && contract.type.kind === "vec",
  );
  const classes = target === "standalone" || target === "wasi" ? preparedIrJsClassDefinitions(program.abi.entries) : [];
  const classOnceGuard = classes.some(({ definition }) =>
    [definition.outerBinding, definition.innerBinding].some((binding) => binding?.storage === "module"),
  );
  // Module class initialization mutates its constructor/TDZ pair once. A
  // deferred or WASI adapter must not recreate that identity on a second call.
  // Declaration presence alone supplies no canonical class proof.
  if (classOnceGuard && !assertNativeJsClassAllocations(program))
    throw Error("native class startup lacks complete original/selected evidence");
  return { units: startupUnits, adapter, ...(onceGuard || classOnceGuard ? { onceGuard: true as const } : {}) };
}

/** Exact materialization guard after canonical native bindings have been authenticated. */
