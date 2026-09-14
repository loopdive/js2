// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5384 — the host-free exception renderer must survive the standalone export
// policy.
//
// #2962 added `__exn_render_prepare` / `__exn_render_char` so a natively-thrown
// WasmGC payload renders ("TypeError: boom") with ZERO host imports, and
// `scripts/lib/wasm-exn-render.mjs` is its only consumer. But the #4035 policy
// sink (`stripHostBridgeExports`) listed `__exn_render_` among the JS host
// bridge prefixes, so `hostBridge: "off"` — the DEFAULT for standalone/WASI —
// removed the pair from every deployed binary. The emitter ran, pushed the
// exports, and the sink deleted them again: measured export list for a
// standalone module that throws at top level was exactly `run,__exn_tag`.
// Effect: every host-free throw was unattributable ("uncaught Wasm-GC exception
// (non-stringifiable payload)", #2870), which is what blocked the #5383
// standalone Temporal provider from being diagnosed at all.
//
// The keep is gated on the source having a `throw` statement, NOT on
// `ctx.exnTagIdx >= 0`: the export-boundary bridge arms the tag for essentially
// every standalone module, so a tag-gated keep republishes the renderer — and
// with it `__any_to_string` → `number_toString` → the Ryu tables — in modules
// that never throw. That is #4034's cascade (measured: an arith-only module
// 6,076 → 49,032 B), so the last test here guards the floor as tightly as the
// first two guard the renderer.

import { describe, expect, it } from "vitest";
import { renderHarnessThrownText } from "../scripts/lib/wasm-exn-render.mjs";
import { compile, compileMulti } from "../src/index.js";

const THROWING = `throw new TypeError("boom from top level");\nexport function run() { return 1; }`;

async function compileStandaloneJs(source: string, deferTopLevelInit: boolean) {
  const result = await compileMulti({ "t.js": source }, "t.js", {
    target: "standalone",
    hostBridge: "off",
    allowJs: true,
    deferTopLevelInit,
  });
  expect(result.success, result.success ? undefined : result.errors?.[0]?.message).toBe(true);
  return result.binary as Uint8Array;
}

function exportNames(binary: Uint8Array): string[] {
  return WebAssembly.Module.exports(new WebAssembly.Module(binary)).map((e) => e.name);
}

describe("#5384 standalone exception-render exports", () => {
  it("a standalone module that throws exports the host-free renderer", async () => {
    for (const deferTopLevelInit of [true, false]) {
      const names = exportNames(await compileStandaloneJs(THROWING, deferTopLevelInit));
      expect(names, `deferTopLevelInit: ${deferTopLevelInit}`).toContain("__exn_render_prepare");
      expect(names, `deferTopLevelInit: ${deferTopLevelInit}`).toContain("__exn_render_char");
    }
  });

  it("renderHarnessThrownText attributes the thrown payload with no host imports", async () => {
    const binary = await compileStandaloneJs(THROWING, true);
    const module = new WebAssembly.Module(binary);
    // The whole point of the renderer: nothing is imported, so this is what a
    // wasmtime embedder sees too.
    expect(WebAssembly.Module.imports(module)).toHaveLength(0);
    const { instance } = await WebAssembly.instantiate(binary, {});

    let thrown: unknown;
    try {
      (instance.exports.__module_init as () => void)();
    } catch (error) {
      thrown = error;
    }
    expect(thrown, "__module_init must throw the top-level TypeError").toBeDefined();
    expect(renderHarnessThrownText(thrown, instance)).toBe("TypeError: boom from top level");
  });

  it("a WASI module that throws keeps the renderer too", async () => {
    const result = await compile(
      "export function run(n: number): number { if (n < 0) throw new TypeError('neg'); return n; }",
      {
        fileName: "issue-5384.ts",
        target: "wasi",
        hostBridge: "off",
      },
    );
    expect(result.success, result.success ? undefined : result.errors?.[0]?.message).toBe(true);
    expect(exportNames(result.binary as Uint8Array)).toContain("__exn_render_prepare");
  });

  it("keeps the #4034 floor: a module without a source throw publishes nothing", async () => {
    const result = await compile("export function run(n: number): number { return n; }", {
      fileName: "issue-5384-floor.ts",
      target: "standalone",
      hostBridge: "off",
      optimize: 3,
    });
    expect(result.success).toBe(true);
    const binary = result.binary as Uint8Array;
    expect(exportNames(binary)).not.toContain("__exn_render_prepare");
    // 6,076 B when this landed. The bound guards the cascade, not a byte count:
    // a tag-gated keep would put this at ~49 kB.
    expect(binary.length).toBeLessThan(12_000);
  });

  it("does not disturb the js-host lane", async () => {
    // `emitExceptionRenderExports` is gated on standalone/WASI and the policy
    // sink returns early when the bridge is published, so the gc lane neither
    // gains nor loses an export.
    const result = await compile("export function run(): number { throw new TypeError('boom'); }", {
      fileName: "issue-5384-host.ts",
    });
    expect(result.success).toBe(true);
    const names = exportNames(result.binary as Uint8Array);
    expect(names).not.toContain("__exn_render_prepare");
    expect(names).toContain("run");
  });
});
