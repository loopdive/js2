// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("#4376 — unchanged deno_core bootstrap graph", () => {
  // The exact graph needs more than Vitest's deliberately small 512 MiB fork
  // heap. Compile it in a bounded child so an infrastructure OOM cannot be
  // mistaken for a compiler verdict and the parent releases all compiler state.
  it("runs the exact wrapper, core-module, info-array, and hello-world usage stages", () => {
    const probe = fileURLToPath(new URL("./helpers/deno-core-bootstrap-probe.ts", import.meta.url));
    const result = spawnSync(
      process.execPath,
      ["--max-old-space-size=2048", "--experimental-wasm-exnref", "--import", "tsx", probe],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout) as {
      bytes: number;
      artifactSha256: string;
      bridgeExports: string[];
      calls: string[];
      hashes: Record<string, string>;
      fnvHashes: Record<string, string>;
      hostOps: Array<{
        sumCommits: number;
        printCommits: number;
        error: { kind: number; message: string } | null;
        output: string[];
      }>;
      imports: string[];
      infoBridgeManifest: Record<string, Record<string, string | number>>;
      storedCallbackManifest: Array<Record<string, string>>;
      stages: Array<Record<string, number | number[] | { value: number | null; blocker: string | null }>>;
    };
    expect(report.hashes).toEqual({
      "00_infra.js": "33984000be930f3b02a2d1149ac0319724e8d95891623c8cc74699da4ce97287",
      "00_primordials.js": "5a2dfbdc4bb81412575d035901a11788001c7e0110e3f736d16289891af44a52",
      "02_timers.js": "305596528c679be30d0ac61fa049ec0f1777c287054d119ff4b341575afac7f9",
      "01_core.js": "6e67972322cc5385a2b642a4f7e941fccb6f992c9de662a5111d11fd0aaf1a3a",
      "mod.js": "6850db621a5325d8737ad87d2d24cbc35b7010d5e5f36c88dc53c16610cc40e5",
      "hello_world_usage.js": "33bf6b9698833319ad98c0cf88f2fb4dd7634859816ec784aa8902b3eeba1804",
    });
    expect(report.fnvHashes).toEqual({
      "00_infra.js": "0xe1a2673875ca364c",
      "00_primordials.js": "0x49d0171d7d2c3f4d",
      "02_timers.js": "0xcbd26ee0c68dcb66",
      "01_core.js": "0xd2f9d9c62c037a70",
      "mod.js": "0xcb8eac5051e421a4",
      "hello_world_usage.js": "0xd9c8b2cb5b20c3bc",
    });
    expect(report.bytes).toBe(10_004_942);
    // The raw Wasm custom-section/layout bytes vary across producer platforms
    // (Darwin arm64 vs Linux x64), even though the graph, size, and behavior are
    // identical. Keep reporting a digest for local artifact handoff, but pin the
    // portable source and runtime invariants below instead of one host's digest.
    expect(report.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.bridgeExports).toEqual([
      "__v8x_read_deno_immediate_info",
      "__v8x_read_deno_tick_info",
      "__v8x_read_deno_timer_info",
      "__v8x_set_deno_immediate_info",
      "__v8x_set_deno_tick_info",
      "__v8x_set_deno_timer_info",
      "__v8x_write_deno_immediate_info",
      "__v8x_write_deno_tick_info",
      "__v8x_write_deno_timer_info",
    ]);
    expect(report.imports).toEqual([
      "js2wasm:runtime-eval::__runtime_apply_interpreted",
      "js2wasm:runtime-eval::__runtime_indirect_eval",
      "v8x:deno::__v8x_deno_error_kind",
      "v8x:deno::__v8x_deno_error_utf16_code_unit",
      "v8x:deno::__v8x_deno_error_utf16_length",
      "v8x:deno::__v8x_deno_print_begin",
      "v8x:deno::__v8x_deno_print_code_unit",
      "v8x:deno::__v8x_deno_print_end",
      "v8x:deno::__v8x_deno_sum_begin",
      "v8x:deno::__v8x_deno_sum_end",
      "v8x:deno::__v8x_deno_sum_value",
    ]);
    expect(report.infoBridgeManifest).toEqual({
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
    });
    expect(report.storedCallbackManifest).toEqual([
      {
        coreProperty: "__eventLoopTick",
        rustSlot: "js_event_loop_tick_cb",
        callShape: "variadic (promiseId, isOk, result) triples",
      },
      {
        coreProperty: "__processTimers",
        rustSlot: "js_process_timers_cb",
        callShape: "(now: number) -> number",
      },
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
      {
        coreProperty: "runImmediateCallbacks",
        rustSlot: "run_immediate_callbacks_cb",
        callShape: "() -> void",
      },
    ]);
    const expectedStage = {
      afterInit: 0,
      realmFunction: 1,
      wrappers: 42,
      afterWrappers: 1,
      module: 43,
      afterModule: 2,
      infoLengths: 231,
      tickInfoIdentity: 2,
      immediateInfoIdentity: 3,
      tickInfoSetter: 52,
      immediateInfoSetter: 53,
      timerInfoSetter: 51,
      infoAfterSetters: [7, 11, 13, 17, 19, -23],
      tickInfoWrite: 255,
      immediateInfoWrite: 2_000_000_000,
      timerInfoWrite: -2_000_000_000,
      infoAfterWrites: [255, 2_000_000_000, -2_000_000_000],
      infoSetterCalls: 111,
      callbackBindings: 6,
      repeatedSetters: [0, 0, 0],
      namespace: {
        value: null,
        blocker: "module namespace checkpoint: [object WebAssembly.Exception]",
      },
      usageBindings: { value: 2, blocker: null },
      usage: {
        value: 44,
        blocker: null,
      },
      afterUsage: 3,
      outputCount: 6,
      eventCount: 10,
      rawOutputCount: 6,
      rawEventCount: 10,
    };
    // Named imports prove that mod.js exports the exact live bootstrap values.
    // Wrapper reads observe the retained tick/immediate arrays, all three
    // setters run exactly once, and indexed host writes round-trip in each
    // isolated instance. The independent namespace-object checkpoint remains
    // explicit while the exact named exports and usage both execute.
    expect(report.stages).toEqual([expectedStage, expectedStage]);
    const expectedHostOps = {
      sumCommits: 2,
      printCommits: 6,
      error: {
        kind: 1,
        message: "serde_v8 error: invalid type; expected: array, got: Number",
      },
      output: [
        "The sum of\n",
        "1,2,3\n",
        "is\n",
        "6\n",
        "Exception:\n",
        "TypeError: serde_v8 error: invalid type; expected: array, got: Number\n",
      ],
    };
    expect(report.hostOps).toEqual([expectedHostOps, expectedHostOps]);
    // The captured-eval bootstrap path must seed Function locally: unresolved
    // runtime-eval provider imports would be recorded here before throwing.
    expect(report.calls).toEqual([]);
  }, 120_000);
});
