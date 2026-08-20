// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "../codegen/context/types.js";
import { ts } from "../ts-api.js";
import type { IrBackendTargetCapability } from "./backend/legality.js";
import type { IrStandaloneDomCapabilityPlan } from "./dom-capability.js";
import { makeIrHostVoidCallbackResolver } from "./host-extern.js";

export interface CalendarIrSelectionSupport {
  readonly supportsDateSnapshots: boolean;
  readonly resolveHostVoidCallback?: ReturnType<typeof makeIrHostVoidCallbackResolver>;
  readonly backendCapabilitySelectionOptions: {
    readonly supportsBackendCapability: (capability: IrBackendTargetCapability) => boolean;
  };
}

/** Project exact standalone Calendar providers onto the backend-neutral selector. */
export function makeCalendarIrSelectionSupport(
  ctx: CodegenContext,
  jsHostExterns: boolean,
  standaloneDomCapability: IrStandaloneDomCapabilityPlan | undefined,
  supportsBackendCapability: (capability: IrBackendTargetCapability) => boolean,
): CalendarIrSelectionSupport {
  const supportsStandaloneDomInteraction = standaloneDomCapability?.requiresInteraction === true;
  const supportsDateSnapshots =
    supportsBackendCapability("host-date-snapshot") || ctx.requiresStandaloneClockCapability === true;
  const baseHostVoidCallbackResolver =
    jsHostExterns || supportsStandaloneDomInteraction ? makeIrHostVoidCallbackResolver(ctx.checker) : undefined;
  const resolveHostVoidCallback = baseHostVoidCallbackResolver
    ? jsHostExterns
      ? baseHostVoidCallbackResolver
      : (call: ts.CallExpression) =>
          standaloneDomCapability?.operation(call)?.importName === "HTMLElement_addEventListener"
            ? baseHostVoidCallbackResolver(call)
            : undefined
    : undefined;
  return {
    supportsDateSnapshots,
    ...(resolveHostVoidCallback ? { resolveHostVoidCallback } : {}),
    backendCapabilitySelectionOptions: {
      supportsBackendCapability: (capability) =>
        capability === "host-date-snapshot" ? supportsDateSnapshots : supportsBackendCapability(capability),
    },
  };
}
