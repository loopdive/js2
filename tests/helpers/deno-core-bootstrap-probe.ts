// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMulti } from "../../src/index.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/deno-core-0.407.0");

const upstreamFiles = [
  ["00_primordials.js", "5a2dfbdc4bb81412575d035901a11788001c7e0110e3f736d16289891af44a52", "0x49d0171d7d2c3f4d"],
  ["00_infra.js", "33984000be930f3b02a2d1149ac0319724e8d95891623c8cc74699da4ce97287", "0xe1a2673875ca364c"],
  ["02_timers.js", "305596528c679be30d0ac61fa049ec0f1777c287054d119ff4b341575afac7f9", "0xcbd26ee0c68dcb66"],
  ["01_core.js", "6e67972322cc5385a2b642a4f7e941fccb6f992c9de662a5111d11fd0aaf1a3a", "0xd2f9d9c62c037a70"],
  ["mod.js", "6850db621a5325d8737ad87d2d24cbc35b7010d5e5f36c88dc53c16610cc40e5", "0xcb8eac5051e421a4"],
  ["hello_world_usage.js", "33bf6b9698833319ad98c0cf88f2fb4dd7634859816ec784aa8902b3eeba1804", "0xd9c8b2cb5b20c3bc"],
] as const;

const storedCallbackManifest = [
  {
    coreProperty: "__eventLoopTick",
    rustSlot: "js_event_loop_tick_cb",
    callShape: "variadic (promiseId, isOk, result) triples",
  },
  { coreProperty: "__processTimers", rustSlot: "js_process_timers_cb", callShape: "(now: number) -> number" },
  {
    coreProperty: "__drainNextTickAndMacrotasks",
    rustSlot: "js_drain_next_tick_and_macrotasks_cb",
    callShape: "() -> void",
  },
  {
    coreProperty: "__handleRejections",
    rustSlot: "js_handle_rejections_cb",
    callShape: "variadic (promise, reason, context) triples",
  },
  {
    coreProperty: "buildCustomError",
    rustSlot: "js_build_custom_error_cb",
    callShape: "(className, message, additionalProperties) -> Error",
  },
  { coreProperty: "runImmediateCallbacks", rustSlot: "run_immediate_callbacks_cb", callShape: "() -> void" },
] as const;

const infoBridgeManifest = {
  tick: {
    element: "u8",
    length: 2,
    setter: "__v8x_set_deno_tick_info",
    read: "__v8x_read_deno_tick_info",
    write: "__v8x_write_deno_tick_info",
  },
  immediate: {
    element: "u32",
    length: 3,
    setter: "__v8x_set_deno_immediate_info",
    read: "__v8x_read_deno_immediate_info",
    write: "__v8x_write_deno_immediate_info",
  },
  timer: {
    element: "i32",
    length: 1,
    setter: "__v8x_set_deno_timer_info",
    read: "__v8x_read_deno_timer_info",
    write: "__v8x_write_deno_timer_info",
  },
} as const;

const runtimeSeed = `
  declare function __v8x_deno_sum_begin(isArray: boolean, length: number): void;
  declare function __v8x_deno_sum_value(index: number, value: number): void;
  declare function __v8x_deno_sum_end(): number;
  declare function __v8x_deno_error_kind(): number;
  declare function __v8x_deno_error_utf16_length(): number;
  declare function __v8x_deno_error_utf16_code_unit(index: number): number;
  declare function __v8x_deno_print_begin(isError: boolean, length: number): void;
  declare function __v8x_deno_print_code_unit(index: number, unit: number): void;
  declare function __v8x_deno_print_end(): void;

  function takeDenoBridgeError(): Error | undefined {
    const kind = __v8x_deno_error_kind();
    if (kind === 0) return undefined;
    const length = __v8x_deno_error_utf16_length();
    let message = "";
    for (let index = 0; index < length; index++) {
      message += String.fromCharCode(__v8x_deno_error_utf16_code_unit(index));
    }
    return kind === 1 ? new TypeError(message) : new Error(message);
  }

  const probeState: any = {
    stage: 0,
    seedCore: undefined,
    usageEvents: [],
    usageOutput: [],
  };
  const extrasBinding = {
    getContinuationPreservedEmbedderData() { return undefined; },
    setContinuationPreservedEmbedderData(_value: any) {},
  };
  const importMetaPrototype: any = {};
  const ops: any = {
    op_get_extras_binding_object() {
      return extrasBinding;
    },
    op_get_ext_import_meta_proto() {
      return importMetaPrototype;
    },
    op_set_captured_bootstrap(bootstrap: any) {
      (globalThis as any).__capturedBootstrap = bootstrap;
    },
    op_print(message: string, isError?: boolean) {
      probeState.usageEvents.push(20);
      probeState.usageOutput.push(message);
      __v8x_deno_print_begin(isError === true, message.length);
      for (let index = 0; index < message.length; index++) {
        __v8x_deno_print_code_unit(index, message.charCodeAt(index));
      }
      __v8x_deno_print_end();
      const error = takeDenoBridgeError();
      if (error !== undefined) throw error;
    },
    // A real op2 callback receives an arbitrary V8 value and performs its
    // serde conversion inside Rust. Keep this backing callback dynamically
    // typed so the invalid-number call reaches the same explicit conversion
    // failure instead of being rejected by a Wasm function-entry cast.
    op_sum(value: unknown) {
      probeState.usageEvents.push(10);
      if (Array.isArray(value)) {
        __v8x_deno_sum_begin(true, value.length);
        for (let index = 0; index < value.length; index++) {
          __v8x_deno_sum_value(index, Number(value[index]));
        }
      } else {
        __v8x_deno_sum_begin(false, 1);
        __v8x_deno_sum_value(0, Number(value));
      }
      const total = __v8x_deno_sum_end();
      const error = takeDenoBridgeError();
      if (error !== undefined) {
        probeState.usageEvents.push(11);
        throw error;
      }
      probeState.usageEvents.push(12);
      return total;
    },
    op_timer_schedule(..._args: any[]) {
      throw new Error("op_timer_schedule called during bootstrap");
    },
    op_timer_track(..._args: any[]) {
      throw new Error("op_timer_track called during bootstrap");
    },
    op_timer_untrack(..._args: any[]) {
      throw new Error("op_timer_untrack called during bootstrap");
    },
    op_timer_now(..._args: any[]) {
      throw new Error("op_timer_now called during bootstrap");
    },
    op_leak_tracing_submit(..._args: any[]) {
      throw new Error("op_leak_tracing_submit called during bootstrap");
    },
  };
  const core: any = {
    ops,
    callConsole(_v8Method: any, denoMethod: any, ...args: any[]) {
      return denoMethod(...args);
    },
  };
  probeState.seedCore = core;
  (globalThis as any).Deno = { core };
  (globalThis as any).__v8xDenoProbeState = probeState;
`;

const entrySource = `
  import "./runtime-seed.ts";
  import "./00_primordials.js";
  import "./00_infra.js";
  import "./02_timers.js";
  import "./01_core.js";
  import {
    core as moduleCore,
    internals as moduleInternals,
    primordials as modulePrimordials,
  } from "./mod.js";
  import * as coreModuleNamespace from "./mod.js";
  import {
    probeUsageBindings,
    runExactHelloWorldUsage,
  } from "./hello-world-usage-stage.ts";

  let tickInfoRoot: Uint8Array | null = null;
  let immediateInfoRoot: Uint32Array | null = null;
  let timerInfoRoot: Int32Array | null = null;
  let tickInfoSetterCalls = 0;
  let immediateInfoSetterCalls = 0;
  let timerInfoSetterCalls = 0;

  function wrappersReady(global: any, state: any): boolean {
    const bootstrap: any = global.__bootstrap;
    if (bootstrap == null) return false;
    const core: any = bootstrap.core;
    const captured: any = global.__capturedBootstrap;
    return core != null &&
      global.Deno.core === core &&
      state.seedCore === core &&
      typeof core.queueNextTick === "function" &&
      typeof core.setAsyncHooksEmit === "function" &&
      typeof core.registerErrorClass === "function" &&
      typeof core.__processTimers === "function" &&
      typeof core.__setTimerInfo === "function" &&
      typeof core.createTimer === "function" &&
      typeof core.cancelTimer === "function" &&
      typeof core.refreshTimer === "function" &&
      typeof core.refTimer === "function" &&
      typeof core.unrefTimer === "function" &&
      typeof global.queueMicrotask === "function" &&
      bootstrap.internals != null &&
      captured != null &&
      typeof captured.core.queueNextTick === "function" &&
      captured.internals === bootstrap.internals;
  }

  function usageOutputIsExact(state: any): boolean {
    const output: any[] = state.usageOutput;
    return output.length === 6 &&
      output[0] === "The sum of\\n" &&
      output[1] === "1,2,3\\n" &&
      output[2] === "is\\n" &&
      output[3] === "6\\n" &&
      output[4] === "Exception:\\n" &&
      output[5] === "TypeError: serde_v8 error: invalid type; expected: array, got: Number\\n";
  }

  function usageEventsAreExact(state: any): boolean {
    const events: any[] = state.usageEvents;
    return events.length === 10 &&
      events[0] === 20 &&
      events[1] === 20 &&
      events[2] === 20 &&
      events[3] === 10 &&
      events[4] === 12 &&
      events[5] === 20 &&
      events[6] === 10 &&
      events[7] === 11 &&
      events[8] === 20 &&
      events[9] === 20;
  }

  export function __v8x_stage_deno_core_wrappers(): number {
    const global: any = globalThis;
    const state: any = global.__v8xDenoProbeState;
    if (state.stage !== 0 || !wrappersReady(global, state)) return 0;
    state.stage = 1;
    return 42;
  }

  // This entry module reaches the runtime-eval boundary through captured eval,
  // but it never reads bare Function. The realm binding must still be the same
  // native singleton exposed as every compiled function's constructor.
  export function __v8x_probe_deno_realm_function(): number {
    const realm: any = globalThis;
    const realmFunction: any = realm.Function;
    const witness = function () {};
    return typeof realmFunction === "function" && realmFunction === witness.constructor ? 1 : 0;
  }

  export function __v8x_stage_deno_core_module(): number {
    const global: any = globalThis;
    const state: any = global.__v8xDenoProbeState;
    const bootstrap: any = global.__bootstrap;
    if (state.stage !== 1 ||
      moduleCore !== state.seedCore ||
      moduleCore !== bootstrap.core ||
      moduleInternals !== bootstrap.internals ||
      modulePrimordials !== bootstrap.primordials) return 0;
    state.stage = 2;
    return 43;
  }

  export function __v8x_probe_deno_core_module_namespace(): number {
    const bootstrap: any = (globalThis as any).__bootstrap;
    return coreModuleNamespace.core === moduleCore &&
      coreModuleNamespace.core === bootstrap.core &&
      coreModuleNamespace.internals === bootstrap.internals &&
      coreModuleNamespace.primordials === bootstrap.primordials ? 3 : 0;
  }

  export function __v8x_set_deno_tick_info(first: number, second: number): number {
    if (tickInfoSetterCalls !== 0) return 0;
    const root = new Uint8Array(2);
    root[0] = first;
    root[1] = second;
    tickInfoRoot = root;
    moduleCore.__setTickInfo(root);
    tickInfoSetterCalls++;
    return 52;
  }

  export function __v8x_set_deno_immediate_info(first: number, second: number, third: number): number {
    if (immediateInfoSetterCalls !== 0) return 0;
    const root = new Uint32Array(3);
    root[0] = first;
    root[1] = second;
    root[2] = third;
    immediateInfoRoot = root;
    moduleCore.__setImmediateInfo(root);
    immediateInfoSetterCalls++;
    return 53;
  }

  export function __v8x_set_deno_timer_info(first: number): number {
    if (timerInfoSetterCalls !== 0) return 0;
    const root = new Int32Array(1);
    root[0] = first;
    timerInfoRoot = root;
    moduleCore.__setTimerInfo(root);
    timerInfoSetterCalls++;
    return 51;
  }

  export function __v8x_read_deno_tick_info(index: number): number {
    const root = tickInfoRoot;
    return root !== null && index >= 0 && index < 2 ? root[index] : -1;
  }

  export function __v8x_write_deno_tick_info(index: number, value: number): number {
    const root = tickInfoRoot;
    if (root === null || index < 0 || index >= 2) return -1;
    root[index] = value;
    return root[index];
  }

  export function __v8x_read_deno_immediate_info(index: number): number {
    const root = immediateInfoRoot;
    return root !== null && index >= 0 && index < 3 ? root[index] : -1;
  }

  export function __v8x_write_deno_immediate_info(index: number, value: number): number {
    const root = immediateInfoRoot;
    if (root === null || index < 0 || index >= 3) return -1;
    root[index] = value;
    return root[index];
  }

  export function __v8x_read_deno_timer_info(index: number): number {
    const root = timerInfoRoot;
    return root !== null && index === 0 ? root[0] : -1;
  }

  export function __v8x_write_deno_timer_info(index: number, value: number): number {
    const root = timerInfoRoot;
    if (root === null || index !== 0) return -1;
    root[0] = value;
    return root[0];
  }

  export function __v8x_probe_deno_info_setter_calls(): number {
    return tickInfoSetterCalls * 100 + immediateInfoSetterCalls * 10 + timerInfoSetterCalls;
  }

  export function __v8x_probe_deno_info_lengths(): number {
    const tick = tickInfoRoot;
    const immediate = immediateInfoRoot;
    const timer = timerInfoRoot;
    if (tick === null || immediate === null || timer === null) return 0;
    return tick.length * 100 + immediate.length * 10 + timer.length;
  }

  export function __v8x_probe_deno_tick_info_identity(): number {
    const root = tickInfoRoot;
    if (root === null) return 0;
    root[0] = 0;
    const falseRead = (moduleCore.hasTickScheduled as () => boolean)();
    root[0] = 1;
    const trueRead = (moduleCore.hasTickScheduled as () => boolean)();
    return !falseRead && trueRead ? 2 : 0;
  }

  export function __v8x_probe_deno_immediate_info_identity(): number {
    const root = immediateInfoRoot;
    if (root === null) return 0;
    root[1] = 29;
    return moduleCore.getActiveImmediateCount() === 29 ? 3 : 0;
  }

  export function __v8x_probe_deno_stored_callbacks(): number {
    return typeof moduleCore.__eventLoopTick === "function" &&
      typeof moduleCore.__processTimers === "function" &&
      typeof moduleCore.__drainNextTickAndMacrotasks === "function" &&
      typeof moduleCore.__handleRejections === "function" &&
      typeof moduleCore.buildCustomError === "function" &&
      typeof moduleCore.runImmediateCallbacks === "function" ? 6 : 0;
  }

  export function __v8x_probe_deno_usage_bindings(): number {
    return probeUsageBindings();
  }

  export function __v8x_stage_deno_hello_world_usage(): number {
    const global: any = globalThis;
    const state: any = global.__v8xDenoProbeState;
    if (state.stage !== 2 || moduleCore !== state.seedCore) return 0;
    runExactHelloWorldUsage();
    if (!usageOutputIsExact(state) || !usageEventsAreExact(state)) return 0;
    state.stage = 3;
    return 44;
  }

  export function __v8x_probe_deno_stage_state(): number {
    const global: any = globalThis;
    const state: any = global.__v8xDenoProbeState;
    return wrappersReady(global, state) ? state.stage : -1;
  }

  export function __v8x_probe_deno_usage_output_count(): number {
    const state: any = (globalThis as any).__v8xDenoProbeState;
    return usageOutputIsExact(state) ? state.usageOutput.length : 0;
  }

  export function __v8x_probe_deno_usage_event_count(): number {
    const state: any = (globalThis as any).__v8xDenoProbeState;
    return usageEventsAreExact(state) ? state.usageEvents.length : 0;
  }

  export function __v8x_probe_deno_raw_usage_output_count(): number {
    return (globalThis as any).__v8xDenoProbeState.usageOutput.length;
  }

  export function __v8x_probe_deno_raw_usage_event_count(): number {
    return (globalThis as any).__v8xDenoProbeState.usageEvents.length;
  }
`;

function sha256(source: string | Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

function fnv1a64(source: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(source)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `0x${hash.toString(16).padStart(16, "0")}`;
}

const files: Record<string, string> = {
  "/deno-bootstrap/entry.ts": entrySource,
  "/deno-bootstrap/runtime-seed.ts": runtimeSeed,
};
const hashes: Record<string, string> = {};
const fnvHashes: Record<string, string> = {};
let usageSource = "";
for (const [fileName, expectedHash, expectedFnvHash] of upstreamFiles) {
  const source = readFileSync(join(fixtureDir, fileName), "utf8");
  const actualHash = sha256(source);
  if (actualHash !== expectedHash) {
    throw new Error(`${fileName} changed: expected ${expectedHash}, received ${actualHash}`);
  }
  hashes[fileName] = actualHash;
  const actualFnvHash = fnv1a64(source);
  if (actualFnvHash !== expectedFnvHash) {
    throw new Error(`${fileName} changed: expected FNV-1a64 ${expectedFnvHash}, received ${actualFnvHash}`);
  }
  fnvHashes[fileName] = actualFnvHash;
  if (fileName === "hello_world_usage.js") {
    usageSource = source;
  } else {
    files[`/deno-bootstrap/${fileName}`] = source;
  }
}
files["/deno-bootstrap/hello-world-usage-stage.ts"] =
  `type UsageDeno = {\n` +
  `  core: {\n` +
  `    print(message: string, isError?: boolean): void;\n` +
  `    ops: { op_sum(nums: number[]): number };\n` +
  `  };\n` +
  `};\n` +
  `export function probeUsageBindings(): number {\n` +
  `  const Deno = (globalThis as any).Deno as UsageDeno;\n` +
  `  return typeof Deno.core.print === "function" &&\n` +
  `    typeof Deno.core.ops.op_sum === "function" ? 2 : 0;\n` +
  `}\n` +
  `export function runExactHelloWorldUsage(): void {\n` +
  `  const Deno = (globalThis as any).Deno as UsageDeno;` +
  `${usageSource}}\n`;

const result = await compileMulti(files, "/deno-bootstrap/entry.ts", {
  target: "standalone",
  platform: "deno",
  allowJs: true,
  skipSemanticDiagnostics: true,
  deferTopLevelInit: true,
  externImportModule: "v8x:deno",
  link: ["v8x:deno"],
});
if (!result.success) {
  throw new Error(result.errors.map((error) => error.message).join("\n"));
}

const artifactOutput = process.env.DENO_CORE_BOOTSTRAP_WASM_OUTPUT;
if (artifactOutput) writeFileSync(artifactOutput, result.binary);
const module = new WebAssembly.Module(result.binary);
const moduleImports = WebAssembly.Module.imports(module);
const imports = moduleImports.map(({ module, name }) => `${module}::${name}`).sort();
const bridgeExports = WebAssembly.Module.exports(module)
  .map(({ name }) => name)
  .filter((name) => /^__v8x_(?:set|read|write)_deno_(?:tick|immediate|timer)_info$/.test(name))
  .sort();
const calls: string[] = [];
type ProbeOutcome = { value: number | null; blocker: string | null };
type StageReport = Record<string, number | number[] | ProbeOutcome>;
type DenoHostBridgeReport = {
  sumCommits: number;
  printCommits: number;
  error: { kind: number; message: string } | null;
  output: string[];
};
const stages: StageReport[] = [];
const hostOps: DenoHostBridgeReport[] = [];
const serdeArrayNumberError = "serde_v8 error: invalid type; expected: array, got: Number";

function createDenoHostBridge(): { imports: Record<string, Function>; report: () => DenoHostBridgeReport } {
  let sumOpen = false;
  let sumIsArray = false;
  let sumLength = 0;
  let sumValues: number[] = [];
  let sumSeen: boolean[] = [];
  let printOpen = false;
  let printLength = 0;
  let printUnits: number[] = [];
  let printSeen: boolean[] = [];
  let pendingErrorKind = 0;
  let errorMessage = "";
  let lastError: DenoHostBridgeReport["error"] = null;
  let sumCommits = 0;
  let printCommits = 0;
  const output: string[] = [];

  function checkedLength(name: string, value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} received invalid length ${value}`);
    }
    return value;
  }

  function checkedIndex(name: string, value: number, length: number): number {
    if (!Number.isSafeInteger(value) || value < 0 || value >= length) {
      throw new Error(`${name} received invalid index ${value} for length ${length}`);
    }
    return value;
  }

  const imports: Record<string, Function> = {
    __v8x_deno_sum_begin(isArray: number, length: number): void {
      if (sumOpen) throw new Error("sum bridge begin called before the previous commit");
      sumOpen = true;
      sumIsArray = isArray !== 0;
      sumLength = checkedLength("sum bridge", length);
      sumValues = new Array<number>(sumLength);
      sumSeen = new Array<boolean>(sumLength).fill(false);
      pendingErrorKind = 0;
      errorMessage = "";
    },
    __v8x_deno_sum_value(index: number, value: number): void {
      if (!sumOpen) throw new Error("sum bridge value called without begin");
      const checked = checkedIndex("sum bridge", index, sumLength);
      sumValues[checked] = value;
      sumSeen[checked] = true;
    },
    __v8x_deno_sum_end(): number {
      if (!sumOpen) throw new Error("sum bridge end called without begin");
      if (sumSeen.some((seen) => !seen)) throw new Error("sum bridge ended before every value arrived");
      sumOpen = false;
      sumCommits++;
      if (!sumIsArray) {
        pendingErrorKind = 1;
        errorMessage = serdeArrayNumberError;
        lastError = { kind: pendingErrorKind, message: errorMessage };
        return 0;
      }
      let total = 0;
      for (const value of sumValues) total += value;
      return total;
    },
    __v8x_deno_error_kind(): number {
      const kind = pendingErrorKind;
      pendingErrorKind = 0;
      return kind;
    },
    __v8x_deno_error_utf16_length(): number {
      return errorMessage.length;
    },
    __v8x_deno_error_utf16_code_unit(index: number): number {
      return errorMessage.charCodeAt(checkedIndex("error bridge", index, errorMessage.length));
    },
    __v8x_deno_print_begin(_isError: number, length: number): void {
      if (printOpen) throw new Error("print bridge begin called before the previous commit");
      printOpen = true;
      printLength = checkedLength("print bridge", length);
      printUnits = new Array<number>(printLength);
      printSeen = new Array<boolean>(printLength).fill(false);
    },
    __v8x_deno_print_code_unit(index: number, unit: number): void {
      if (!printOpen) throw new Error("print bridge code unit called without begin");
      const checked = checkedIndex("print bridge", index, printLength);
      if (!Number.isSafeInteger(unit) || unit < 0 || unit > 0xffff) {
        throw new Error(`print bridge received invalid UTF-16 code unit ${unit}`);
      }
      printUnits[checked] = unit;
      printSeen[checked] = true;
    },
    __v8x_deno_print_end(): void {
      if (!printOpen) throw new Error("print bridge end called without begin");
      if (printSeen.some((seen) => !seen)) throw new Error("print bridge ended before every code unit arrived");
      printOpen = false;
      let message = "";
      for (const unit of printUnits) message += String.fromCharCode(unit);
      output.push(message);
      printCommits++;
    },
  };

  return {
    imports,
    report: () => ({
      sumCommits,
      printCommits,
      error: lastError === null ? null : { ...lastError },
      output: [...output],
    }),
  };
}

function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const own = error.message.length === 0 ? error.name : `${error.name}: ${error.message}`;
  if (!("cause" in error) || error.cause == null) return own;
  return `${own}; cause=${errorSummary(error.cause)}`;
}
function captureProbe(name: string, probe: () => number): ProbeOutcome {
  try {
    return { value: probe(), blocker: null };
  } catch (error) {
    return { value: null, blocker: `${name}: ${errorSummary(error)}` };
  }
}
function callStage(name: string, stage: () => number | undefined): number {
  try {
    return stage() ?? 0;
  } catch (error) {
    throw new Error(`${name} trapped`, { cause: error });
  }
}
function callUsageStage(exports: Record<string, WebAssembly.ExportValue>): number {
  try {
    return (exports.__v8x_stage_deno_hello_world_usage as () => number)();
  } catch (error) {
    const outputCount = (exports.__v8x_probe_deno_raw_usage_output_count as () => number)();
    const eventCount = (exports.__v8x_probe_deno_raw_usage_event_count as () => number)();
    throw new Error(`hello_world usage trapped after ${outputCount} output and ${eventCount} op events`, {
      cause: error,
    });
  }
}
for (let instanceIndex = 0; instanceIndex < 2; instanceIndex++) {
  const importObject: Record<string, Record<string, Function>> = {};
  const denoHostBridge = createDenoHostBridge();
  for (const descriptor of moduleImports) {
    importObject[descriptor.module] ??= {};
    if (descriptor.module === "v8x:deno") {
      const imported = denoHostBridge.imports[descriptor.name];
      if (imported === undefined) throw new Error(`unknown Deno host import ${descriptor.name}`);
      importObject[descriptor.module]![descriptor.name] = imported;
      continue;
    }
    importObject[descriptor.module]![descriptor.name] = () => {
      calls.push(`${descriptor.module}::${descriptor.name}`);
      throw new Error(`bootstrap called unresolved import ${descriptor.module}::${descriptor.name}`);
    };
  }
  const instance = await WebAssembly.instantiate(module, importObject);
  const exports = instance.exports as Record<string, WebAssembly.ExportValue>;
  callStage("__module_init", instance.exports.__module_init as () => void);
  const stageState = exports.__v8x_probe_deno_stage_state as () => number;
  const afterInit = callStage("state after init", stageState);
  const realmFunction = callStage("realm Function identity", exports.__v8x_probe_deno_realm_function as () => number);
  const wrappers = callStage("wrapper checkpoint", exports.__v8x_stage_deno_core_wrappers as () => number);
  const afterWrappers = callStage("state after wrappers", stageState);
  const coreModule = callStage("module checkpoint", exports.__v8x_stage_deno_core_module as () => number);
  const afterModule = callStage("state after module", stageState);
  const readTickInfo = exports.__v8x_read_deno_tick_info as (index: number) => number;
  const writeTickInfo = exports.__v8x_write_deno_tick_info as (index: number, value: number) => number;
  const readImmediateInfo = exports.__v8x_read_deno_immediate_info as (index: number) => number;
  const writeImmediateInfo = exports.__v8x_write_deno_immediate_info as (index: number, value: number) => number;
  const readTimerInfo = exports.__v8x_read_deno_timer_info as (index: number) => number;
  const writeTimerInfo = exports.__v8x_write_deno_timer_info as (index: number, value: number) => number;
  const tickInfoSetter = callStage("tick info setter", () =>
    (exports.__v8x_set_deno_tick_info as (first: number, second: number) => number)(7, 11),
  );
  const immediateInfoSetter = callStage("immediate info setter", () =>
    (exports.__v8x_set_deno_immediate_info as (first: number, second: number, third: number) => number)(13, 17, 19),
  );
  const timerInfoSetter = callStage("timer info setter", () =>
    (exports.__v8x_set_deno_timer_info as (first: number) => number)(-23),
  );
  const infoLengths = callStage("info root lengths", exports.__v8x_probe_deno_info_lengths as () => number);
  const infoAfterSetters = [
    readTickInfo(0),
    readTickInfo(1),
    readImmediateInfo(0),
    readImmediateInfo(1),
    readImmediateInfo(2),
    readTimerInfo(0),
  ];
  const tickInfoIdentity = callStage("tick info identity", exports.__v8x_probe_deno_tick_info_identity as () => number);
  const immediateInfoIdentity = callStage(
    "immediate info identity",
    exports.__v8x_probe_deno_immediate_info_identity as () => number,
  );
  const tickInfoWrite = writeTickInfo(1, 255);
  const immediateInfoWrite = writeImmediateInfo(2, 2_000_000_000);
  const timerInfoWrite = writeTimerInfo(0, -2_000_000_000);
  const infoAfterWrites = [readTickInfo(1), readImmediateInfo(2), readTimerInfo(0)];
  const infoSetterCalls = callStage(
    "info setter call count",
    exports.__v8x_probe_deno_info_setter_calls as () => number,
  );
  const callbackBindings = callStage(
    "stored callback bindings",
    exports.__v8x_probe_deno_stored_callbacks as () => number,
  );
  const repeatedSetters = [
    (exports.__v8x_set_deno_tick_info as (first: number, second: number) => number)(1, 2),
    (exports.__v8x_set_deno_immediate_info as (first: number, second: number, third: number) => number)(1, 2, 3),
    (exports.__v8x_set_deno_timer_info as (first: number) => number)(1),
  ];
  const namespace = captureProbe(
    "module namespace checkpoint",
    exports.__v8x_probe_deno_core_module_namespace as () => number,
  );
  const usageBindings = captureProbe(
    "usage binding checkpoint",
    exports.__v8x_probe_deno_usage_bindings as () => number,
  );
  const usage = captureProbe("hello_world usage", () => callUsageStage(exports));
  stages.push({
    afterInit,
    realmFunction,
    wrappers,
    afterWrappers,
    module: coreModule,
    afterModule,
    infoLengths,
    tickInfoIdentity,
    immediateInfoIdentity,
    tickInfoSetter,
    immediateInfoSetter,
    timerInfoSetter,
    infoAfterSetters,
    tickInfoWrite,
    immediateInfoWrite,
    timerInfoWrite,
    infoAfterWrites,
    infoSetterCalls,
    callbackBindings,
    repeatedSetters,
    namespace,
    usageBindings,
    usage,
    afterUsage: callStage("state after usage", stageState),
    outputCount: callStage("usage output probe", exports.__v8x_probe_deno_usage_output_count as () => number),
    eventCount: callStage("usage event probe", exports.__v8x_probe_deno_usage_event_count as () => number),
    rawOutputCount: callStage(
      "raw usage output probe",
      exports.__v8x_probe_deno_raw_usage_output_count as () => number,
    ),
    rawEventCount: callStage("raw usage event probe", exports.__v8x_probe_deno_raw_usage_event_count as () => number),
  });
  hostOps.push(denoHostBridge.report());
}

process.stdout.write(
  `${JSON.stringify({
    bytes: result.binary.byteLength,
    artifactSha256: sha256(result.binary),
    bridgeExports,
    calls,
    hostOps,
    hashes,
    fnvHashes,
    imports,
    infoBridgeManifest,
    storedCallbackManifest,
    stages,
  })}\n`,
);
