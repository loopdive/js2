// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ImportDescriptor, ImportIntent } from "./index.js";
import type { WasmModule } from "./ir/types.js";
import type { CompileEnvironment, HostAcceleratorFamily } from "./target-profile.js";
import { isDomCapabilityImportDescriptor, isDomInteractionImportDescriptor } from "./dom-capability-contract.js";

export type HostImportPolicyClass =
  | "platform-capability"
  | "value-adapter"
  | "instance-lifecycle"
  | "host-accelerator"
  | "regime-gap"
  | "unknown";

export interface HostImportPolicy {
  readonly classification: HostImportPolicyClass;
  readonly family: string;
  readonly ownerIssue: number;
  readonly nativeFallback: boolean;
  readonly reason: string;
}

export interface HostImportInventoryEntry extends HostImportPolicy {
  readonly module: string;
  readonly name: string;
  readonly kind: "func" | "global" | "memory" | "table" | "tag";
  readonly intentType?: ImportIntent["type"];
}

export interface HostImportInventorySummary {
  readonly total: number;
  readonly byClassification: Readonly<Record<HostImportPolicyClass, number>>;
  readonly byFamily: Readonly<Record<string, number>>;
}

const policy = (
  classification: HostImportPolicyClass,
  family: string,
  ownerIssue: number,
  nativeFallback: boolean,
  reason: string,
): HostImportPolicy => Object.freeze({ classification, family, ownerIssue, nativeFallback, reason });

const VALUE_ADAPTER_BUILTINS = new Set([
  "__str_from_mem",
  "__str_to_mem",
  "__str_extern_len",
  "__get_caught_exception",
  // (#5247) Export-boundary rethrow: hands the `__exn` tag's externref payload
  // to a JS frame so an uncaught compiled throw reaches the host as the Error
  // itself. Same "exception transfer" family as `__get_caught_exception`, and
  // the native fallback is structural — a host-free profile never registers it
  // and simply keeps raising the wasm exception.
  "__rethrow_host_exception",
  "__unwrap_for_wasm",
]);

const INSTANCE_LIFECYCLE_PREFIXES = ["__register_"] as const;

/**
 * (#7091) Is this extern class an ECMAScript builtin rather than a platform
 * capability? The IR's platform-extern lane (JS environment, native regime)
 * admits only the classes `classifyHostImport` calls `platform-capability`.
 */
export function isEcmascriptExternClass(className: string): boolean {
  return ECMASCRIPT_EXTERN_CLASSES.has(className);
}

/**
 * (#6979) ECMAScript builtins. The native semantic regime owns them, so a host
 * extern-class import of one is a retired host-semantic import (compile error),
 * while any other declared class stays an embedder capability. RegExp, Date and
 * Intl reach the host only through their selected accelerator (#6978/#6986).
 */
const ECMASCRIPT_EXTERN_CLASSES = new Set([
  "Array",
  "ArrayBuffer",
  "BigInt",
  "DataView",
  "Date",
  "DisposableStack",
  "Error",
  "EvalError",
  "FinalizationRegistry",
  "Map",
  "Object",
  "Promise",
  "RangeError",
  "ReferenceError",
  "RegExp",
  "Set",
  "SharedArrayBuffer",
  "SuppressedError",
  "Symbol",
  "SyntaxError",
  "TypeError",
  "URIError",
  "WeakMap",
  "WeakRef",
  "WeakSet",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

/**
 * (#6979) Would a host extern-class import of `className` be a retired
 * host-semantic import under these accelerators? ECMAScript builtins are owned
 * by the native regime; RegExp/Date reach the host only through their selected
 * accelerator. Codegen uses this to stop registering imports the publication
 * gate would reject.
 */
export function isRetiredEcmaScriptExternClass(
  className: string,
  accelerators: readonly HostAcceleratorFamily[] | undefined,
): boolean {
  if (!ECMASCRIPT_EXTERN_CLASSES.has(className)) return false;
  if (className === "RegExp") return accelerators?.includes("regexp") !== true;
  if (className === "Date") return accelerators?.includes("date") !== true;
  return true;
}

function classifyBuiltin(name: string): HostImportPolicy {
  if (VALUE_ADAPTER_BUILTINS.has(name)) {
    return policy("value-adapter", "js-value-bridge", 4399, true, "JS/Wasm value marshaling or exception transfer");
  }
  if (INSTANCE_LIFECYCLE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return policy("instance-lifecycle", "instance-wiring", 4399, true, "instance/export registration lifecycle");
  }
  if (name === "__extern_eval" || name === "__extern_direct_eval" || name === "__date_parse_host") {
    return policy(
      "host-accelerator",
      "dynamic-or-specialized-host-engine",
      4397,
      true,
      "explicit exceptional host engine with a native or linked-provider path",
    );
  }
  if (name === "__crypto_random_uuid" || name === "__crypto_get_random_values") {
    // (#6749) Web Crypto is entropy, not ECMAScript semantics: the same
    // `randomness` capability as `Math.random` / WASI `random_get`. No native
    // fallback by design — a host-free build throws rather than degrade to a
    // PRNG (#1503/#6659).
    return policy("platform-capability", "randomness", 4398, false, "Web Crypto entropy capability");
  }
  if (name === "__get_process" || name.startsWith("__get_process_")) {
    // (#1490, #6910) The live Node `process` (and its env/argv/platform/…
    // members): an environment capability, not ECMAScript semantics. A
    // host-free build substitutes its stand-in at compile time.
    return policy("platform-capability", "node", 1490, false, "Node process capability");
  }
  const gap = regimeGapOfBuiltin(name);
  if (gap) return gap;
  return retired(`env builtin '${name}' is not an adapter, capability, lifecycle hook or accelerator`);
}

/**
 * (#6979) Every import that is not a platform capability, value adapter,
 * instance-lifecycle hook, selected host accelerator or named regime gap. The
 * host-semantic implementation is retired, so publishing one is a compile
 * error on every WasmGC profile.
 */
function retired(reason: string): HostImportPolicy {
  return policy("unknown", "retired-host-semantics", 6979, false, reason);
}

/**
 * (#6979, #5385) Named regime gaps: host imports that are still the ONLY
 * implementation of a construct on the native regime. Exactly these two
 * families; `scripts/check-host-import-policy.ts` holds the explicit name
 * ceiling so a third cannot slip in. Each is a #5385 regime slice to close.
 * (`shared-array-buffer` closed with #7011's native provider.)
 */
export const REGIME_GAP_FAMILIES = {
  "eager-generator-buffer":
    "eager-buffer generator fallback for generator shapes the native generator lowering declines (#680)",
  "temporal-strings": "Temporal string parsing/formatting and duration field arithmetic have no native provider",
} as const;
export type RegimeGapFamily = keyof typeof REGIME_GAP_FAMILIES;

function regimeGap(family: RegimeGapFamily): HostImportPolicy {
  return policy("regime-gap", family, 5385, false, REGIME_GAP_FAMILIES[family]);
}

function regimeGapOfBuiltin(name: string): HostImportPolicy | undefined {
  if (name.startsWith("__gen_") || name === "__create_generator" || name === "__create_async_generator") {
    return regimeGap("eager-generator-buffer");
  }
  return name.startsWith("__temporal_") ? regimeGap("temporal-strings") : undefined;
}

/**
 * #6707: `env.__exn` is the one `WebAssembly.Tag` the JS embedder hands to
 * every module of a linked graph (`sharedExceptionTag`, package linker) so a
 * provider's throw is catchable in its consumer. It is instance/link wiring,
 * not an ECMAScript semantic fallback; a host-free build keeps a module-local
 * tag, so the native fallback is real. Environment-shaped, so it classifies
 * identically with or without the native regime.
 *
 * Keyed on the non-`func` kind as well as the name: the import manifest records
 * a wasm `tag` import as `kind: "global"` with an untyped `builtin` intent, and
 * both the compile-time publication gate and the native-first runtime adapter
 * gate classify that manifest descriptor, so this is the one place both see.
 */
function isSharedExceptionTag(descriptor: ImportDescriptor): boolean {
  return descriptor.module === "env" && descriptor.kind !== "func" && descriptor.name === "__exn";
}

/**
 * (#6978) The host-accelerator family an import belongs to, if any. Only these
 * four families may be re-classified by a selected accelerator; everything
 * else keeps its intrinsic class whatever the profile says.
 */
function acceleratorFamilyOfEnvImport(descriptor: ImportDescriptor): HostAcceleratorFamily | undefined {
  const intent = descriptor.intent;
  switch (intent.type) {
    case "string_literal":
    case "string_method":
      return "js-string";
    case "date_new":
    case "date_method":
      return "date";
    case "extern_class":
      if (intent.className === "RegExp") return "regexp";
      if (intent.className === "Date") return "date";
      return intent.className === "Intl" || intent.namespacePath?.[0] === "Intl" ? "intl" : undefined;
    case "declared_global":
      return intent.name === "Intl" ? "intl" : undefined;
    case "builtin":
      if (intent.name === "__date_parse_host") return "date";
      if (intent.name.startsWith("__intl_")) return "intl"; // (#6986) locale-sensitive builtin methods
      return intent.name.startsWith("RegExp_") || intent.name.startsWith("__regexp_host_") ? "regexp" : undefined;
    default:
      return undefined;
  }
}

function acceleratorFamilyOfNonEnvImport(module: string): HostAcceleratorFamily | undefined {
  return module === "wasm:js-string" || module === "string_constants" || module === "string_constants16"
    ? "js-string"
    : undefined;
}

function acceleratedPolicy(family: HostAcceleratorFamily): HostImportPolicy {
  return policy(
    "host-accelerator",
    family,
    6978,
    true,
    `selected '${family}' host accelerator; the native ${family} provider is the fallback`,
  );
}

/**
 * Classify an emitted `env` import by its typed intent. The exhaustive switch
 * makes a new intent a compile error until policy is chosen. Anything that is
 * neither an adapter, a capability, a lifecycle hook, a selected accelerator
 * nor a named regime gap classifies `unknown` (retired host semantics, #6979),
 * which the publication gate rejects on every WasmGC profile.
 *
 * (#6978) `accelerators` is the profile's selected host-accelerator list: an
 * import of a selected family classifies as `host-accelerator`; unselected
 * families keep their intrinsic class.
 */
export function classifyHostImport(
  descriptor: ImportDescriptor,
  environment?: CompileEnvironment,
  accelerators?: readonly HostAcceleratorFamily[],
): HostImportPolicy {
  if (accelerators !== undefined && accelerators.length > 0) {
    const family = acceleratorFamilyOfEnvImport(descriptor);
    if (family !== undefined && accelerators.includes(family)) return acceleratedPolicy(family);
  }
  return classifyIntrinsicHostImport(descriptor, environment);
}

function classifyIntrinsicHostImport(descriptor: ImportDescriptor, environment?: CompileEnvironment): HostImportPolicy {
  if (environment === "none" && isDomInteractionImportDescriptor(descriptor)) {
    return policy("platform-capability", "dom-interaction", 4577, false, "explicit DOM interaction capability");
  }
  if (environment === "none" && isDomCapabilityImportDescriptor(descriptor)) {
    return policy("platform-capability", "dom", 4576, false, "explicit bounded DOM subtree capability");
  }
  if (isSharedExceptionTag(descriptor)) {
    return policy(
      "instance-lifecycle",
      "shared-exception-tag",
      5226,
      true,
      "linker-owned shared exception tag; a host-free build keeps a module-local tag",
    );
  }
  const intent = descriptor.intent;
  switch (intent.type) {
    case "string_literal":
    case "string_method":
      return retired("host string provider; strings are native unless the js-string accelerator is selected");
    case "math":
      return intent.method === "random"
        ? policy("platform-capability", "randomness", 4398, false, "entropy/randomness capability")
        : policy("host-accelerator", "math", 4397, true, "host math accelerator with native Wasm fallback");
    case "console_log":
      return policy("platform-capability", "console", 4398, false, "explicit host console capability");
    case "extern_class":
      return ECMASCRIPT_EXTERN_CLASSES.has(intent.className)
        ? retired(`host ECMAScript builtin '${intent.className}'`)
        : policy("platform-capability", `extern:${intent.className}`, 4398, false, "declared external API capability");
    case "builtin":
      return classifyBuiltin(intent.name);
    case "declared_function":
      return policy(
        "platform-capability",
        `declared:${intent.name}`,
        6979,
        false,
        "ambient function declared by the source and supplied by the embedder",
      );
    case "callback_maker":
    case "getter_callback_maker":
      return policy("value-adapter", "callbacks", 4399, true, "JS/Wasm callback adapter");
    case "box":
    case "unbox":
      return policy("value-adapter", "dynamic-values", 4399, true, "JS/Wasm dynamic value conversion");
    case "typeof_check":
    case "any_to_index":
    case "extern_get":
    case "extern_call_raw_callable":
    case "extern_set":
    case "extern_set_strict":
    case "truthy_check":
    case "host_eq":
    case "host_loose_eq":
    case "host_add":
    case "host_bigint_binop":
    case "host_compare":
    case "same_value_zero":
    case "proxy_create":
      return retired(`host language operation '${intent.type}'`);
    case "boundary_object":
      return policy(
        "value-adapter",
        "boundary-object",
        4399,
        false,
        "explicit access to a JS-owned object admitted at the module boundary",
      );
    case "boundary_callback":
      return policy(
        "value-adapter",
        "callbacks",
        4399,
        false,
        "explicit invocation of a JS callback admitted at the module boundary",
      );
    case "boundary_promise":
      return policy(
        "value-adapter",
        "boundary-promise",
        4399,
        false,
        "settlement notification for a Wasm-owned Promise exposed at the JavaScript boundary",
      );
    case "caught_exception":
      return policy(
        "instance-lifecycle",
        "instance-wiring",
        4399,
        true,
        "per-instance recovery of a caught host exception",
      );
    case "date_new":
    case "date_method":
      return retired("host Date semantics; Date is native unless the date accelerator is selected");
    case "date_now":
      return environment === "none"
        ? policy("platform-capability", "clock", 4577, false, "explicit standalone embedder clock capability")
        : policy("platform-capability", "clock", 4398, true, "wall-clock capability");
    case "declared_global":
      // (#6890) `global_console` is the console capability read as a VALUE.
      return intent.name === "console"
        ? policy("platform-capability", "console", 4398, false, "explicit host console object capability")
        : policy("platform-capability", `global:${intent.name}`, 4398, false, "declared ambient host capability");
    case "dynamic_import":
      return policy("platform-capability", "module-loader", 4398, false, "dynamic module loading capability");
    case "node_builtin":
    case "node_builtin_fn":
    case "node_dirname":
    case "node_filename":
    case "node_import_meta_url":
      return policy("platform-capability", "node", 4398, false, "explicit Node platform capability");
    case "web_storage":
      return policy("platform-capability", "web-storage", 4398, false, "explicit Web Storage capability");
    case "timer_set":
    case "timer_clear":
      return policy("platform-capability", "timers", 4398, false, "explicit timer capability");
    case "jsx_runtime":
      return policy("platform-capability", "jsx-runtime", 4398, false, "declared application/runtime capability");
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}

function wasmImportKind(desc: WasmModule["imports"][number]["desc"]): HostImportInventoryEntry["kind"] {
  switch (desc.kind) {
    case "func":
    case "global":
    case "memory":
    case "table":
    case "tag":
      return desc.kind;
  }
}

function classifyNonEnvImport(module: string, name: string, linkedNamespaces: ReadonlySet<string>): HostImportPolicy {
  if (module === "wasm:js-string" || module === "string_constants" || module === "string_constants16") {
    return retired("host string representation; strings are native unless the js-string accelerator is selected");
  }
  if (module === "js2wasm:runtime-eval" || module === "js2wasm:qjs") {
    return policy("host-accelerator", "dynamic-code", 4397, true, "replaceable linked Wasm provider");
  }
  if (module === "wasi_snapshot_preview1" && name === "clock_time_get") {
    return policy("platform-capability", "clock", 4398, true, "WASI Preview 1 clock provider ABI");
  }
  if (module === "wasi_snapshot_preview1" && name === "random_get") {
    return policy("platform-capability", "randomness", 4398, true, "WASI Preview 1 randomness provider ABI");
  }
  if (module === "wasi_snapshot_preview1" || module.startsWith("node:")) {
    return policy("platform-capability", module, 4398, false, "declared platform/provider ABI");
  }
  if (linkedNamespaces.has(module)) {
    return policy(
      "platform-capability",
      `linked:${module}`,
      2783,
      false,
      "explicitly declared link-time provider namespace",
    );
  }
  return retired(`import namespace '${module}' is not a declared provider`);
}

/** Build a deterministic, machine-readable policy inventory for every import. */
export function buildHostImportInventory(
  mod: WasmModule,
  envManifest: readonly ImportDescriptor[],
  linkedNamespaces: readonly string[] = [],
  environment?: CompileEnvironment,
  accelerators: readonly HostAcceleratorFamily[] = [],
): HostImportInventoryEntry[] {
  const envByName = new Map(envManifest.map((descriptor) => [descriptor.name, descriptor] as const));
  const linkedNamespaceSet = new Set(linkedNamespaces);
  return mod.imports.map((entry) => {
    const descriptor = entry.module === "env" ? envByName.get(entry.name) : undefined;
    const nonEnvFamily = descriptor ? undefined : acceleratorFamilyOfNonEnvImport(entry.module);
    const classified = descriptor
      ? classifyHostImport(descriptor, environment, accelerators)
      : entry.module === "env"
        ? retired(`env import '${entry.name}' has no typed intent`)
        : nonEnvFamily !== undefined && accelerators.includes(nonEnvFamily)
          ? acceleratedPolicy(nonEnvFamily)
          : classifyNonEnvImport(entry.module, entry.name, linkedNamespaceSet);
    return Object.freeze({
      module: entry.module,
      name: entry.name,
      kind: wasmImportKind(entry.desc),
      ...(descriptor ? { intentType: descriptor.intent.type } : {}),
      ...classified,
    });
  });
}

/** Deterministic totals suitable for explain output and monotonic CI ratchets. */
export function summarizeHostImportInventory(
  inventory: readonly HostImportInventoryEntry[],
): HostImportInventorySummary {
  const byClassification: Record<HostImportPolicyClass, number> = {
    "platform-capability": 0,
    "value-adapter": 0,
    "instance-lifecycle": 0,
    "host-accelerator": 0,
    "regime-gap": 0,
    unknown: 0,
  };
  const byFamily: Record<string, number> = Object.create(null);
  for (const entry of inventory) {
    byClassification[entry.classification] += 1;
    byFamily[entry.family] = (byFamily[entry.family] ?? 0) + 1;
  }
  return Object.freeze({
    total: inventory.length,
    byClassification: Object.freeze(byClassification),
    byFamily: Object.freeze(
      Object.fromEntries(Object.entries(byFamily).sort(([left], [right]) => left.localeCompare(right))),
    ),
  });
}
