// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6770, #6797) The object-model leaves' view of the codegen core.
 *
 * The leaves in `object-model/` are called BY the core (object-runtime,
 * the Proxy dispatch, the call lowerers) and need a handful of core helpers
 * back — a string constant, the objvec builders, the object-literal compiler.
 * A direct value import of those would close an import cycle and pull every
 * leaf into the core's strongly connected component, which
 * `scripts/check-import-cycles.mjs` forbids from growing. So the dependency is
 * inverted: the leaves import this module (which value-imports nothing — every
 * import below is `import type`), and the core installs the implementations
 * once, lazily, from `codegen/index.ts`.
 *
 * {@link port} throws when a port is read before installation — that means a
 * leaf ran outside a compile, which cannot happen through `compile()`.
 */
import type * as TryTable from "../../ir/try-table.js";
import type * as AnyHelpers from "../any-helpers.js";
import type * as ArraySubclassReceiver from "../array-subclass-receiver.js";
import type * as BuiltinProtoMemberOverride from "../builtin-proto-member-override.js";
import type * as BuiltinValueRead from "../builtin-value-read.js";
import type * as Calls from "../expressions/calls.js";
import type * as Literals from "../literals.js";
import type * as NativeProto from "../native-proto.js";
import type * as NativeStrings from "../native-strings.js";
import type * as ObjectRuntime from "../object-runtime.js";
import type * as RegistryImports from "../registry/imports.js";

export interface ObjectModelPorts {
  addStringConstantGlobal: typeof RegistryImports.addStringConstantGlobal;
  nextModuleGlobalIdx: typeof RegistryImports.nextModuleGlobalIdx;
  stringConstantExternrefInstrs: typeof NativeStrings.stringConstantExternrefInstrs;
  undefinedExternInstrs: typeof AnyHelpers.undefinedExternInstrs;
  ensureExternStrictEqHelper: typeof AnyHelpers.ensureExternStrictEqHelper;
  ensureObjVecBuilders: typeof ObjectRuntime.ensureObjVecBuilders;
  ensureObjectRuntime: typeof ObjectRuntime.ensureObjectRuntime;
  reserveApplyClosure: typeof ObjectRuntime.reserveApplyClosure;
  withArraySubclassReceiverAsVec: typeof ArraySubclassReceiver.withArraySubclassReceiverAsVec;
  sourceOverridesBuiltinPrototypeMember: typeof BuiltinProtoMemberOverride.sourceOverridesBuiltinPrototypeMember;
  tryEnsureNativeProtoBrand: typeof BuiltinValueRead.tryEnsureNativeProtoBrand;
  emitFnctorSubclassDynamicMethodCall: typeof Calls.emitFnctorSubclassDynamicMethodCall;
  emitLazyNativeProtoGet: typeof NativeProto.emitLazyNativeProtoGet;
  compileObjectLiteral: typeof Literals.compileObjectLiteral;
  compileObjectLiteralAsExternref: typeof Literals.compileObjectLiteralAsExternref;
  objectLiteralForcesHostPath: typeof Literals.objectLiteralForcesHostPath;
  buildStandardTryTable: typeof TryTable.buildStandardTryTable;
}

let resolve: (() => ObjectModelPorts) | undefined;
let installed: ObjectModelPorts | undefined;

/** Called once by the core. `make` runs on first use, after every module has evaluated. */
export function installObjectModelPorts(make: () => ObjectModelPorts): void {
  resolve = make;
  installed = undefined;
}

/** The core implementation of one port. */
export function port<K extends keyof ObjectModelPorts>(name: K): ObjectModelPorts[K] {
  if (installed === undefined) {
    if (resolve === undefined) throw new Error(`object-model port "${name}" read before installObjectModelPorts`);
    installed = resolve();
  }
  return installed[name];
}

/**
 * A module-level stand-in for one port, callable like the core function it
 * names (`const f = bound("f")` replaces `import { f } from "<core>"`). The
 * port is resolved per call, so defining it at module scope is safe.
 */
export function bound<K extends keyof ObjectModelPorts>(name: K): ObjectModelPorts[K] {
  const call = (...args: unknown[]): unknown => (port(name) as (...a: unknown[]) => unknown)(...args);
  return call as ObjectModelPorts[K];
}
