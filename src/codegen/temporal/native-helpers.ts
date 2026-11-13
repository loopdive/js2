// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7012) The in-module replacements for the ten `env::__temporal_*` host
 * imports of the #661 Temporal lowering.
 *
 * Which build gets them: every build whose strings are the WasmGC
 * `$NativeString` (`ctx.nativeStrings`) — standalone, WASI, the native-first
 * regime in a JavaScript environment, and any explicit native-strings build.
 * Those builds cannot exchange a JS string with a host helper, and the
 * host-free ones have no host at all; before #7012 they still emitted the
 * imports (an uninstantiable standalone binary, a native-first compile error,
 * and on WASI a silent `""` / zero result). The host-assisted lane with
 * `wasm:js-string` strings keeps the `runtime.ts` implementations.
 *
 * Each helper is registered in `ctx.funcMap` under the import's own name, so a
 * later `ensureLateImport(name)` resolves the in-module function and no import
 * is created.
 */
import type { CodegenContext } from "../context/types.js";
import { ensurePlainDateAddField, ensurePlainTimeAddField } from "./native-arith.js";
import {
  ensureDurationSign,
  ensureDurationToString,
  ensurePlainDateMonthCode,
  ensurePlainDateToString,
  ensurePlainTimeToString,
} from "./native-format.js";
import { ensureDurationFromStringField } from "./native-parse-duration.js";
import { ensurePlainDateFromStringField, ensurePlainTimeFromStringField } from "./native-parse-iso.js";
import { bindTemporalHelperServices, type TemporalHelperServices } from "./wasm-kit.js";

type Emitter = (ctx: CodegenContext) => number;

const HELPERS: Readonly<Record<string, Emitter>> = {
  // string results (`$NativeString`)
  __temporal_plain_date_to_string: ensurePlainDateToString,
  __temporal_plain_date_month_code: ensurePlainDateMonthCode,
  __temporal_plain_time_to_string: ensurePlainTimeToString,
  __temporal_duration_to_string: ensureDurationToString,
  // f64 results
  __temporal_plain_date_from_string_field: ensurePlainDateFromStringField,
  __temporal_plain_time_from_string_field: ensurePlainTimeFromStringField,
  __temporal_duration_from_string_field: ensureDurationFromStringField,
  __temporal_plain_date_add_field: ensurePlainDateAddField,
  __temporal_plain_time_add_field: ensurePlainTimeAddField,
  __temporal_duration_sign: ensureDurationSign,
};

/** Do this build's Temporal helpers live in the module (see the file comment)? */
export function temporalHelpersInModule(ctx: CodegenContext): boolean {
  return ctx.nativeStrings;
}

/**
 * Define the in-module helper `name` (once) and return its function index.
 * `services` are the codegen services the helpers build on (see
 * `TemporalHelperServices`). Throws for a name outside the ten: a new host
 * helper must get a native twin here, never a silent import on a native-string
 * build.
 */
export function ensureInModuleTemporalHelper(
  ctx: CodegenContext,
  name: string,
  services: TemporalHelperServices,
): number {
  bindTemporalHelperServices(ctx, services);
  const emitter = HELPERS[name];
  if (emitter) return emitter(ctx);
  throw new Error(`#7012: Temporal helper ${name} has no in-module implementation for a native-string build`);
}
