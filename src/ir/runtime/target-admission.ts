// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CompileTargetProfile } from "../../shared/contracts/compile-target-policy.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";
import { IrUnsupportedError } from "../../shared/contracts/ir-preparation-errors.js";
function refusal(detail: string): never {
  throw new IrUnsupportedError("target-environment-unsupported", "select", detail);
}
function value(record: unknown, key: string): unknown {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
  const d = Object.getOwnPropertyDescriptor(record, key);
  return d && "value" in d ? d.value : undefined;
}
function field(record: unknown, key: string, optional = false): unknown {
  if (record === null || typeof record !== "object" || Array.isArray(record))
    refusal("IR policy must be explicit DATA");
  const d = Object.getOwnPropertyDescriptor(record, key);
  if (!d) {
    if (optional && !(key in record)) return undefined;
    refusal(`IR policy ${key} must be own DATA`);
  }
  if (!("value" in d)) refusal(`IR policy ${key} must be own DATA`);
  return d.value;
}
/** Admission uses the real execution environment, never backend/regime heuristics. */
export function isNativeIrCompileProfile(profile: CompileTargetProfile): boolean {
  const target = value(profile, "target"),
    environment = value(profile, "environment"),
    backend = value(profile, "backend");
  return (
    (backend === "wasmgc" || backend === "linear") &&
    value(profile, "hostValueInterop") === "off" &&
    ((target === "standalone" && environment === "none") || (target === "wasi" && environment === "wasi"))
  );
}
export function assertNativeIrCompileProfile(profile: CompileTargetProfile): void {
  if (!isNativeIrCompileProfile(profile))
    refusal("IR requires an explicit standalone/none or WASI/WASI profile without JavaScript value interop");
}
function provider(
  policy: RuntimeManifestPolicy,
  family: string,
  leaf: string,
  allowed: readonly string[],
  optionalLeaf = false,
): unknown {
  const record = field(policy, family, true);
  if (record === undefined) return undefined;
  const selected = field(record, leaf, optionalLeaf);
  if (selected === "host")
    throw new IrUnsupportedError(
      "host-surface-unavailable",
      "select",
      `IR does not support JavaScript-host policy ${family}.${leaf}`,
    );
  if (selected === undefined && optionalLeaf) return undefined;
  if (typeof selected !== "string" || !allowed.includes(selected)) refusal(`Unknown IR policy ${family}.${leaf}`);
  return selected;
}
/** Omitted providers remain unsupported; this boundary does not select providers or imports. */
export function assertNativeIrPolicy(policy: RuntimeManifestPolicy): void {
  const target = field(policy, "target"),
    backend = field(policy, "backend");
  if ((target !== "standalone" && target !== "wasi") || (backend !== "wasmgc" && backend !== "linear"))
    refusal("IR requires an explicit native target and declared Wasm backend");
  const ordinary = ["native", "unsupported"] as const;
  provider(policy, "numberBoundary", "box", ordinary);
  provider(policy, "numberBoundary", "unbox", ordinary);
  provider(policy, "booleanBoundary", "box", ordinary);
  // This schema has never admitted a JavaScript-host unbox arm.
  const booleanUnbox = field(policy, "booleanBoundary", true);
  if (booleanUnbox !== undefined) {
    const arm = field(booleanUnbox, "unbox", true);
    if (arm !== undefined && arm !== "native" && arm !== "unsupported")
      refusal("Unknown IR policy booleanBoundary.unbox");
  }
  provider(policy, "externIsUndefined", "probe", ordinary);
  provider(policy, "generatorNumberBox", "box", ordinary);
  provider(policy, "stringCompare", "compare", ordinary);
  provider(policy, "stringEq", "eq", ordinary);
  provider(policy, "stringLen", "len", ordinary);
  const concat = provider(policy, "stringConcat", "concat", ordinary);
  provider(policy, "stringCharCodeAt", "charCodeAt", ordinary);
  const batch = provider(policy, "stringConcatMany", "batch", ["native", "off"]);
  provider(policy, "stringConst", "storage", ordinary);
  provider(policy, "hostCallbackWrap", "wrap", ["native-dispatch", "unsupported"]);
  const call = field(policy, "functionPrototypeCall", true);
  if (call !== undefined) {
    const arm = field(call, "call");
    if (arm !== "native" && arm !== "unsupported") refusal("Unknown IR policy functionPrototypeCall.call");
  }
  if (batch === "native" && concat !== "native")
    refusal("IR stringConcatMany.batch disagrees with stringConcat.concat");
}

/** Recognize only the pre-existing host preparation policy, never a native opt-in. */
export function isLegacyHostIrPolicy(policy: RuntimeManifestPolicy): boolean {
  const backend = value(policy, "backend");
  return value(policy, "target") === "host" && (backend === "wasmgc" || backend === "linear");
}
