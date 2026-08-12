// #3630 — runtime eval compiled to a host-instantiated core-Wasm side module.
// The native Wasmtime provider has a separately documented manual acceptance
// command because building the embedding crate is intentionally not part of the
// JavaScript unit-test latency budget.
import { describe, expect, it } from "vitest";
import { EVAL_EXPORT_NAME, buildRuntimeEvalBroker } from "../examples/runtime-eval-side-module/broker.mjs";
import { createJavaScriptSideModuleHost } from "../examples/runtime-eval-side-module/js-host.mjs";

describe("#3630 runtime-eval side-module broker", () => {
  it("declares only the narrow compiler and WebAssembly object capabilities", () => {
    const brokerBytes = buildRuntimeEvalBroker();
    expect(WebAssembly.validate(brokerBytes)).toBe(true);

    const imports = WebAssembly.Module.imports(new WebAssembly.Module(brokerBytes))
      .map(({ module, name, kind }) => `${module}::${name}:${kind}`)
      .sort();
    expect(imports).toEqual([
      "WebAssembly.Instance::callExportF64:function",
      "WebAssembly::Instance:function",
      "WebAssembly::Module:function",
      "WebAssembly::memory:memory",
      "js2wasm:compiler::compileEval:function",
    ]);
  });

  it("compiles runtime source, instantiates its zero-import module, and executes it", async () => {
    const host = await createJavaScriptSideModuleHost();

    expect(await host.evaluate(["20", "+", "22"].join(" "))).toBe(42);
    expect(await host.evaluate("9 * 9")).toBe(81);

    const telemetry = host.telemetry();
    expect(telemetry.compileCount).toBe(2);
    expect(telemetry.lastSideModuleBytes).not.toBeNull();

    const sideModule = new WebAssembly.Module(telemetry.lastSideModuleBytes!);
    expect(WebAssembly.Module.imports(sideModule)).toEqual([]);
    expect(WebAssembly.Module.exports(sideModule).map(({ name }) => name)).toContain(EVAL_EXPORT_NAME);
  });
});
