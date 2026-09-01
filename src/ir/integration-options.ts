// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ts } from "../ts-api.js";
import type { IrBindingId, IrUnitId } from "./identity.js";
import type {
  PendingPreparedProgramComponentReceipt,
  PreparedComponentModuleCallableAliasDescriptor,
  PreparedComponentPublicationDraft,
} from "./prepared-component-publication.js";

/** Configuration shared by single-source and aggregate IR integration. */
export interface IrIntegrationOptions {
  /**
   * Derive post-pass R2 components and seal every dependency-complete ABI
   * component before lowering. Components with still-implicit runtime/layout
   * support retain the established transitional route.
   */
  readonly sealPreparedComponents?: boolean;
  /** Source files participating in one aggregate IR integration. */
  readonly integrationSourceFiles?: readonly ts.SourceFile[];
  /** Seal and withdraw the exact aggregate as one component. */
  readonly atomicComponent?: boolean;
  /** Exact non-source bindings included in the component seal. */
  readonly preparedBindingIdsByTerminalUnitId?: ReadonlyMap<IrUnitId, ReadonlySet<IrBindingId>>;
  /** Keep the exact aggregate scope open and return detached body patches. */
  readonly deferPreparedPublication?: boolean;
  /** Sink used by the aggregate-only integration entry to receive a receipt. */
  readonly preparedComponentPublicationSink?: {
    readonly publish: (draft: PreparedComponentPublicationDraft) => PendingPreparedProgramComponentReceipt;
    readonly abort?: () => void;
  };
  /** Opaque module-callable-alias descriptor staged with the open scope. */
  readonly preparedModuleCallableAliasDescriptor?: PreparedComponentModuleCallableAliasDescriptor;
}
