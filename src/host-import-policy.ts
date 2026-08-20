// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ImportDescriptor, ImportIntent } from "./index.js";
import type { WasmModule } from "./ir/types.js";
import type { CompileEnvironment } from "./target-profile.js";
import { isDomCapabilityImportDescriptor, isDomInteractionImportDescriptor } from "./dom-capability-contract.js";

export type HostImportPolicyClass =
  | "platform-capability"
  | "value-adapter"
  | "instance-lifecycle"
  | "host-accelerator"
  | "legacy-semantic"
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
]);

const INSTANCE_LIFECYCLE_PREFIXES = ["__register_"] as const;

const LEGACY_SEMANTIC_BUILTIN_PREFIXES = [
  "JSON_",
  "Promise_",
  "RegExp_",
  "Map_",
  "Set_",
  "WeakMap_",
  "WeakSet_",
  "number_",
  "bigint_",
  "parse",
  "decodeURI",
  "encodeURI",
  "escape",
  "unescape",
  "string_",
  "__array_",
  "__js_array_",
  "__async_iterator",
  "__bind_function",
  "__call_",
  "__concat_",
  "__construct",
  "__create_async_generator",
  "__create_generator",
  "__defineProperty_",
  "__delete_property",
  "__extern_",
  "__for_in_",
  "__gen_",
  "__getOwnPropertyDescriptor",
  "__getPrototypeOf",
  "__host_set_struct_proto",
  "__is_truthy",
  "__iterator",
  "__new_",
  "__object_",
  "__reflect_",
  "__typeof",
] as const;

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
  if (LEGACY_SEMANTIC_BUILTIN_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return policy("legacy-semantic", "ecmascript-runtime", 4397, false, "implicit JavaScript semantic fallback");
  }
  return policy("unknown", "unclassified", 4401, false, `unclassified env builtin '${name}'`);
}

/**
 * Classify an emitted `env` import by its typed intent. The exhaustive switch
 * makes a new intent a compile error until policy is chosen; name-based
 * `builtin` fallbacks may still return `unknown`, which is deliberately loud.
 */
export function classifyHostImport(descriptor: ImportDescriptor, environment?: CompileEnvironment): HostImportPolicy {
  if (environment === "none" && isDomInteractionImportDescriptor(descriptor)) {
    return policy("platform-capability", "dom-interaction", 4577, false, "explicit DOM interaction capability");
  }
  if (environment === "none" && isDomCapabilityImportDescriptor(descriptor)) {
    return policy("platform-capability", "dom", 4576, false, "explicit bounded DOM subtree capability");
  }
  const intent = descriptor.intent;
  switch (intent.type) {
    case "string_literal":
    case "string_method":
      return policy("legacy-semantic", "strings", 4397, true, "host-backed ECMAScript string provider");
    case "math":
      return intent.method === "random"
        ? policy("platform-capability", "randomness", 4398, false, "entropy/randomness capability")
        : policy("host-accelerator", "math", 4397, true, "host math accelerator with native Wasm fallback");
    case "console_log":
      return policy("platform-capability", "console", 4398, false, "explicit host console capability");
    case "extern_class":
      return ECMASCRIPT_EXTERN_CLASSES.has(intent.className)
        ? policy("legacy-semantic", `builtin:${intent.className}`, 4397, false, "host-backed ECMAScript builtin")
        : policy("platform-capability", `extern:${intent.className}`, 4398, false, "declared external API capability");
    case "builtin":
      return classifyBuiltin(intent.name);
    case "callback_maker":
    case "getter_callback_maker":
      return policy("value-adapter", "callbacks", 4399, true, "JS/Wasm callback adapter");
    case "box":
    case "unbox":
      return policy("value-adapter", "dynamic-values", 4399, true, "JS/Wasm dynamic value conversion");
    case "await":
      return policy("legacy-semantic", "promise-await", 4397, true, "legacy host Promise/await driver");
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
      return policy("legacy-semantic", "dynamic-language-operations", 4397, false, "implicit host language semantics");
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
      return policy("legacy-semantic", "date", 4397, true, "host-backed Date semantics");
    case "date_now":
      return environment === "none"
        ? policy("platform-capability", "clock", 4577, false, "explicit standalone embedder clock capability")
        : policy("platform-capability", "clock", 4398, true, "wall-clock capability");
    case "declared_global":
      return policy("platform-capability", `global:${intent.name}`, 4398, false, "declared ambient host capability");
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
    return policy("legacy-semantic", "strings", 4397, true, "host-backed string representation provider");
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
  return policy("unknown", "unclassified", 4401, false, `unclassified import namespace '${module}'`);
}

/** Build a deterministic, machine-readable policy inventory for every import. */
export function buildHostImportInventory(
  mod: WasmModule,
  envManifest: readonly ImportDescriptor[],
  linkedNamespaces: readonly string[] = [],
  environment?: CompileEnvironment,
): HostImportInventoryEntry[] {
  const envByName = new Map(envManifest.map((descriptor) => [descriptor.name, descriptor] as const));
  const linkedNamespaceSet = new Set(linkedNamespaces);
  return mod.imports.map((entry) => {
    const descriptor = entry.module === "env" ? envByName.get(entry.name) : undefined;
    const classified = descriptor
      ? classifyHostImport(descriptor, environment)
      : entry.module === "env"
        ? policy("unknown", "unclassified", 4401, false, `env import '${entry.name}' has no typed intent`)
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
    "legacy-semantic": 0,
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
