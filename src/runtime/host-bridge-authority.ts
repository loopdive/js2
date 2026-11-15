// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6979 S7-d) Instance lifecycle: the export-view authority for the
 * compiler-emitted closure and data-struct host-bridge manifests (the
 * `$c*`/`$d*`/`$v*` physical aliases), the branded `instance.exports` getter
 * and the immutable-global / exact-funcref-table probes that certify a manifest
 * belongs to the instance that published it. Split out of `src/runtime.ts`.
 */

import { sameAssociationToken, sameExportedFunction } from "./exported-function-identity.js";

const _VEC_HOST_BRIDGE_EXPORTS = [
  ["__vec_len", "$v0"],
  ["__vec_get", "$v1"],
  ["__is_vec", "$v2"],
  ["__vec_mut_supported", "$v3"],
  ["__vec_push", "$v4"],
  ["__vec_pop", "$v5"],
] as const;

const _CLOSURE_HOST_BRIDGE_EXPORTS = [
  ["__call_fn_0", "$c0"],
  ["__call_fn_1", "$c1"],
  ["__call_fn_2", "$c2"],
  ["__call_fn_3", "$c3"],
  ["__call_fn_4", "$c4"],
  ["__call_fn_method_0", "$c5"],
  ["__call_fn_method_1", "$c6"],
  ["__call_fn_method_2", "$c7"],
  ["__call_fn_method_3", "$c8"],
  ["__call_fn_method_4", "$c9"],
  ["__call_fn_method_5", "$ca"],
  ["__call_fn_method_6", "$cb"],
  ["__call_fn_method_7", "$cc"],
  ["__call_fn_method_8", "$cd"],
  ["__closure_arity", "$ce"],
  ["__is_closure", "$cf"],
  ["__closure_has_rest", "$cg"],
  ["__is_ctor_closure", "$ch"],
] as const;

const _DATA_STRUCT_HOST_BRIDGE_EXPORTS = [
  ["__is_data_struct", "$d0"],
  ["__struct_field_names", "$d1"],
] as const;

const _CLOSURE_HOST_BRIDGE_MANIFEST = ["__\0js2_closure_host_bridge", "$cm"] as const;
const _CLOSURE_HOST_BRIDGE_MARKER = ["__\0js2_closure_host_bridge_marker", "$ct"] as const;
const _CLOSURE_HOST_BRIDGE_BINDINGS = ["__\0js2_closure_host_bridge_bindings", "$cu"] as const;
const _CLOSURE_HOST_BRIDGE_MANIFEST_MAGIC = 0x5a200000;
const _CLOSURE_HOST_BRIDGE_MANIFEST_MAGIC_MASK = 0xfff00000;
const _CLOSURE_HOST_BRIDGE_MANIFEST_BITS_MASK = 0x0003ffff; // (#4661) bit 17 = __is_ctor_closure
const _CLOSURE_HOST_BRIDGE_MANIFEST_RESERVED_MASK = 0x000c0000;
const _DATA_STRUCT_HOST_BRIDGE_MANIFEST = ["__\0js2_data_struct_host_bridge", "$dm"] as const;
const _DATA_STRUCT_HOST_BRIDGE_MARKER = ["__\0js2_data_struct_host_bridge_marker", "$dt"] as const;
const _DATA_STRUCT_HOST_BRIDGE_BINDINGS = ["__\0js2_data_struct_host_bridge_bindings", "$du"] as const;
const _DATA_STRUCT_HOST_BRIDGE_TOKEN = ["__\0js2_data_struct_host_bridge_token", "$dv"] as const;
export const DATA_STRUCT_HOST_BRIDGE_TOKEN_VALUE = "\0js2_data_struct_host_bridge_token";
const _DATA_STRUCT_HOST_BRIDGE_MANIFEST_MAGIC = 0x5a300000;
const _DATA_STRUCT_HOST_BRIDGE_MANIFEST_MAGIC_MASK = 0xfff00000;
const _DATA_STRUCT_HOST_BRIDGE_MANIFEST_BITS_MASK = 0x00000003;
const _DATA_STRUCT_HOST_BRIDGE_MANIFEST_RESERVED_MASK = 0x000ffffc;
const _immutableI32GlobalVerdict = new WeakSet<WebAssembly.Global>();
let _immutableI32GlobalProbeModule: WebAssembly.Module | undefined;
const _emptyFuncrefTableVerdict = new WeakSet<WebAssembly.Table>();
const _bindingFuncrefTableVerdict = new WeakSet<WebAssembly.Table>();
const _dataBindingFuncrefTableVerdict = new WeakSet<WebAssembly.Table>();
let _emptyFuncrefTableProbeModule: WebAssembly.Module | undefined;
let _bindingFuncrefTableProbeModule: WebAssembly.Module | undefined;
let _dataBindingFuncrefTableProbeModule: WebAssembly.Module | undefined;
const _reflectApply = Reflect.apply;
const _objectHasOwnProperty = Object.prototype.hasOwnProperty;
const _instanceExportsGetter = Object.getOwnPropertyDescriptor(WebAssembly.Instance.prototype, "exports")?.get;

/**
 * Test ownership without consulting mutable Function.prototype.call or a
 * subsequently replaced Reflect.apply.
 */
export function hasOwn(value: unknown, key: PropertyKey): boolean {
  return _reflectApply(_objectHasOwnProperty, value, [key]) as boolean;
}

/**
 * Read exports through the WebAssembly.Instance internal-slot brand check.
 *
 * `instanceof` is insufficient: an ordinary object can inherit from
 * WebAssembly.Instance.prototype, and a Proxy around an instance retains that
 * prototype. The captured intrinsic application also remains valid if user
 * code later replaces Function.prototype.call.
 */
export function brandedInstanceExports(value: unknown): WebAssembly.Exports | undefined {
  if (!_instanceExportsGetter) return undefined;
  try {
    return _reflectApply(_instanceExportsGetter, value, []) as WebAssembly.Exports;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the terminal compiler alias in one collision-safe physical family.
 */
function _terminalHostBridgeAlias(exports: Record<string, any>, physicalBase: string): unknown {
  let physicalName = physicalBase;
  let helper: unknown;
  while (hasOwn(exports, physicalName)) {
    helper = exports[physicalName];
    physicalName += "$";
  }
  return helper;
}

/** Prove a Global's exact type and mutability through Wasm import validation. */
function _isImmutableI32Global(value: unknown): value is WebAssembly.Global {
  if (!(value instanceof WebAssembly.Global)) return false;
  if (_immutableI32GlobalVerdict.has(value)) return true;
  try {
    _immutableI32GlobalProbeModule ??= new WebAssembly.Module(
      Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 2, 8, 1, 1, 101, 1, 103, 3, 127, 0]),
    );
    new WebAssembly.Instance(_immutableI32GlobalProbeModule, { e: { g: value } });
    _immutableI32GlobalVerdict.add(value);
    return true;
  } catch {
    return false;
  }
}

/** Prove a Table's exact funcref limits through Wasm import validation. */
function _isExactFuncrefTable(value: unknown, size: 0 | 2 | 18): value is WebAssembly.Table {
  try {
    if (!(value instanceof WebAssembly.Table) || value.length !== size) return false;
    const verdict =
      size === 0
        ? _emptyFuncrefTableVerdict
        : size === 2
          ? _dataBindingFuncrefTableVerdict
          : _bindingFuncrefTableVerdict;
    if (verdict.has(value)) return true;
    const bytes =
      size === 0
        ? [0, 97, 115, 109, 1, 0, 0, 0, 2, 10, 1, 1, 101, 1, 116, 1, 112, 1, 0, 0]
        : size === 2
          ? [0, 97, 115, 109, 1, 0, 0, 0, 2, 10, 1, 1, 101, 1, 116, 1, 112, 1, 2, 2]
          : [0, 97, 115, 109, 1, 0, 0, 0, 2, 10, 1, 1, 101, 1, 116, 1, 112, 1, 18, 18];
    let probe =
      size === 0
        ? _emptyFuncrefTableProbeModule
        : size === 2
          ? _dataBindingFuncrefTableProbeModule
          : _bindingFuncrefTableProbeModule;
    if (!probe) {
      probe = new WebAssembly.Module(Uint8Array.from(bytes));
      if (size === 0) _emptyFuncrefTableProbeModule = probe;
      else if (size === 2) _dataBindingFuncrefTableProbeModule = probe;
      else _bindingFuncrefTableProbeModule = probe;
    }
    new WebAssembly.Instance(probe, { e: { t: value } });
    verdict.add(value);
    return true;
  } catch {
    return false;
  }
}

interface ClosureHostBridgeMetadata {
  bits: number;
  bindings: WebAssembly.Table;
}

interface DataStructHostBridgeMetadata {
  bits: number;
  marker: WebAssembly.Table;
  manifest: WebAssembly.Global;
  bindings: WebAssembly.Table;
  token: WebAssembly.Global;
}

export interface DataStructHostBridgeAuthority extends DataStructHostBridgeMetadata {
  helpers: readonly (Function | undefined)[];
}

const _dataStructHostBridgeAuthorityByManifest = new WeakMap<WebAssembly.Global, DataStructHostBridgeAuthority>();

/** Read and authenticate compiler-authored closure-helper metadata. */
function _closureHostBridgeMetadata(exports: Record<string, any>): ClosureHostBridgeMetadata | undefined {
  const [markerLogicalName, markerPhysicalBase] = _CLOSURE_HOST_BRIDGE_MARKER;
  if (!hasOwn(exports, markerLogicalName)) return undefined;
  const marker = _terminalHostBridgeAlias(exports, markerPhysicalBase);
  if (!_isExactFuncrefTable(marker, 0)) return undefined;

  const [logicalName, physicalBase] = _CLOSURE_HOST_BRIDGE_MANIFEST;
  if (!hasOwn(exports, logicalName)) return undefined;
  const manifest = _terminalHostBridgeAlias(exports, physicalBase);
  if (!_isImmutableI32Global(manifest) || typeof manifest.value !== "number") return undefined;
  const value = manifest.value | 0;
  if ((value & _CLOSURE_HOST_BRIDGE_MANIFEST_MAGIC_MASK) !== _CLOSURE_HOST_BRIDGE_MANIFEST_MAGIC) return undefined;
  if ((value & _CLOSURE_HOST_BRIDGE_MANIFEST_RESERVED_MASK) !== 0) return undefined;
  const bits = value & _CLOSURE_HOST_BRIDGE_MANIFEST_BITS_MASK;

  const [bindingsLogicalName, bindingsPhysicalBase] = _CLOSURE_HOST_BRIDGE_BINDINGS;
  if (!hasOwn(exports, bindingsLogicalName)) return undefined;
  const bindings = _terminalHostBridgeAlias(exports, bindingsPhysicalBase);
  if (!_isExactFuncrefTable(bindings, 18)) return undefined;
  try {
    for (let bit = 0; bit < _CLOSURE_HOST_BRIDGE_EXPORTS.length; bit++) {
      const binding = bindings.get(bit);
      if ((bits & (1 << bit)) !== 0 ? typeof binding !== "function" : binding !== null) return undefined;
    }
  } catch {
    return undefined;
  }
  return { bits, bindings };
}

/**
 * Read and authenticate compiler-authored data-struct helper metadata.
 *
 * The exported binding table is necessarily mutable. Its shape and current
 * contents therefore cannot authenticate callable identity by themselves.
 * Establish authority only from the frozen `WebAssembly.Instance.exports`
 * object, then pin the exact marker/global/table and callable identities in
 * runtime-owned state. A later caller-supplied projection may use the same
 * immutable manifest as its lookup key, but cannot redirect either callable by
 * mutating or replacing the exported table.
 */
function _dataStructHostBridgeMetadata(
  exports: Record<string, any>,
  expectedAuthority?: DataStructHostBridgeAuthority,
  expectedToken?: WebAssembly.Global,
  mayEstablishAuthority = false,
  mayConsumeGlobalAuthority = false,
): DataStructHostBridgeAuthority | undefined {
  const [markerLogicalName, markerPhysicalBase] = _DATA_STRUCT_HOST_BRIDGE_MARKER;
  if (!hasOwn(exports, markerLogicalName)) return undefined;
  const marker = _terminalHostBridgeAlias(exports, markerPhysicalBase);
  if (!_isExactFuncrefTable(marker, 0)) return undefined;

  const [logicalName, physicalBase] = _DATA_STRUCT_HOST_BRIDGE_MANIFEST;
  if (!hasOwn(exports, logicalName)) return undefined;
  const manifest = _terminalHostBridgeAlias(exports, physicalBase);
  if (!_isImmutableI32Global(manifest) || typeof manifest.value !== "number") return undefined;
  const value = manifest.value | 0;
  if ((value & _DATA_STRUCT_HOST_BRIDGE_MANIFEST_MAGIC_MASK) !== _DATA_STRUCT_HOST_BRIDGE_MANIFEST_MAGIC) {
    return undefined;
  }
  if ((value & _DATA_STRUCT_HOST_BRIDGE_MANIFEST_RESERVED_MASK) !== 0) return undefined;
  const bits = value & _DATA_STRUCT_HOST_BRIDGE_MANIFEST_BITS_MASK;

  const [bindingsLogicalName, bindingsPhysicalBase] = _DATA_STRUCT_HOST_BRIDGE_BINDINGS;
  if (!hasOwn(exports, bindingsLogicalName)) return undefined;
  const bindings = _terminalHostBridgeAlias(exports, bindingsPhysicalBase);
  if (!_isExactFuncrefTable(bindings, 2)) return undefined;
  try {
    for (let bit = 0; bit < _DATA_STRUCT_HOST_BRIDGE_EXPORTS.length; bit++) {
      const binding = bindings.get(bit);
      if ((bits & (1 << bit)) !== 0 ? typeof binding !== "function" : binding !== null) return undefined;
    }
  } catch {
    return undefined;
  }

  const [tokenLogicalName, tokenPhysicalBase] = _DATA_STRUCT_HOST_BRIDGE_TOKEN;
  if (!hasOwn(exports, tokenLogicalName)) return undefined;
  const token = _terminalHostBridgeAlias(exports, tokenPhysicalBase);
  if (!(token instanceof WebAssembly.Global)) return undefined;
  if (expectedToken !== undefined && !sameAssociationToken(token, expectedToken)) return undefined;

  const helpers: (Function | undefined)[] = [];
  for (let bit = 0; bit < _DATA_STRUCT_HOST_BRIDGE_EXPORTS.length; bit++) {
    const [, physicalBase] = _DATA_STRUCT_HOST_BRIDGE_EXPORTS[bit]!;
    const helper = _terminalHostBridgeAlias(exports, physicalBase);
    if ((bits & (1 << bit)) !== 0) {
      if (typeof helper !== "function" || !sameExportedFunction(helper, bindings.get(bit))) return undefined;
      helpers.push(helper);
    } else {
      helpers.push(undefined);
    }
  }

  const authority =
    expectedAuthority ??
    (mayConsumeGlobalAuthority ? _dataStructHostBridgeAuthorityByManifest.get(manifest) : undefined);
  if (authority !== undefined) {
    if (
      authority.bits !== bits ||
      authority.marker !== marker ||
      authority.manifest !== manifest ||
      authority.bindings !== bindings ||
      !sameAssociationToken(token, authority.token)
    ) {
      return undefined;
    }
    for (let bit = 0; bit < helpers.length; bit++) {
      if (authority.helpers[bit] !== helpers[bit] || !sameExportedFunction(authority.helpers[bit], bindings.get(bit)))
        return undefined;
    }
    return authority;
  }

  // Only a branded instance path may establish first authority. Raw records
  // can contain genuine donor functions and immutable globals, so their shape
  // is not evidence of origin.
  if (!mayEstablishAuthority) return undefined;
  const established = Object.freeze({
    bits,
    marker,
    manifest,
    bindings,
    token,
    helpers: Object.freeze(helpers),
  });
  _dataStructHostBridgeAuthorityByManifest.set(manifest, established);
  return established;
}

/**
 * Compose vec, closure, and data-struct projections from one raw export object.
 *
 * Vec keeps its collision-only logical-name gate. Closure and data-struct
 * availability come only from their compiler-authored manifests;
 * user-controlled helper-like names never establish ownership. All overrides
 * land in one prototype view so no bridge family hides another's raw own
 * properties.
 */
interface HostBridgeAuthorityOptions {
  expectedDataStructAuthority?: DataStructHostBridgeAuthority;
  expectedDataStructToken?: WebAssembly.Global;
  establishDataStructAuthority?: (authority: DataStructHostBridgeAuthority) => void;
  mayEstablishDataStructAuthority?: boolean;
  mayConsumeGlobalDataStructAuthority?: boolean;
  recordExportView?: (rawExports: Record<string, any>, finalExports: Record<string, any>) => void;
}

export function hostBridgeExportView<T extends Record<string, any>>(
  exports: T,
  options: HostBridgeAuthorityOptions = {},
): T {
  const overrides = new Map<string, unknown>();
  for (const [logicalName, physicalBase] of _VEC_HOST_BRIDGE_EXPORTS) {
    if (!hasOwn(exports, logicalName)) continue;
    const helper = _terminalHostBridgeAlias(exports, physicalBase);
    if (typeof helper !== "function" || exports[logicalName] === helper) continue;
    overrides.set(logicalName, helper);
  }

  const closureMetadata = _closureHostBridgeMetadata(exports);
  for (let bit = 0; bit < _CLOSURE_HOST_BRIDGE_EXPORTS.length; bit++) {
    const [logicalName, physicalBase] = _CLOSURE_HOST_BRIDGE_EXPORTS[bit]!;
    if (!hasOwn(exports, logicalName)) continue;
    let helper: unknown;
    if (closureMetadata !== undefined && (closureMetadata.bits & (1 << bit)) !== 0) {
      helper = _terminalHostBridgeAlias(exports, physicalBase);
      if (typeof helper !== "function" || !sameExportedFunction(helper, closureMetadata.bindings.get(bit)))
        helper = undefined;
    }
    if (exports[logicalName] === helper) continue;
    overrides.set(logicalName, helper);
  }

  const dataStructMetadata = _dataStructHostBridgeMetadata(
    exports,
    options.expectedDataStructAuthority,
    options.expectedDataStructToken,
    options.mayEstablishDataStructAuthority,
    options.mayConsumeGlobalDataStructAuthority,
  );
  if (dataStructMetadata !== undefined) options.establishDataStructAuthority?.(dataStructMetadata);
  for (let bit = 0; bit < _DATA_STRUCT_HOST_BRIDGE_EXPORTS.length; bit++) {
    const [logicalName, physicalBase] = _DATA_STRUCT_HOST_BRIDGE_EXPORTS[bit]!;
    if (!hasOwn(exports, logicalName)) continue;
    let helper: unknown;
    if (dataStructMetadata !== undefined && (dataStructMetadata.bits & (1 << bit)) !== 0) {
      helper = _terminalHostBridgeAlias(exports, physicalBase);
      if (typeof helper !== "function" || !sameExportedFunction(helper, dataStructMetadata.bindings.get(bit)))
        helper = undefined;
    }
    if (exports[logicalName] === helper) continue;
    overrides.set(logicalName, helper);
  }

  if (overrides.size === 0) {
    options.recordExportView?.(exports, exports);
    return exports;
  }
  const view = Object.create(exports) as T;
  for (const [logicalName, helper] of overrides) {
    Object.defineProperty(view, logicalName, {
      value: helper,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  options.recordExportView?.(exports, view);
  return view;
}
