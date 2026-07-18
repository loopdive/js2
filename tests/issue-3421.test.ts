// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3421 — the console_log import intent must honor a caller-provided console
// (`deps.console`). The test262 runners pass a capturing consoleProxy so the
// async harness protocol ($DONE → print → console.log("Test262:AsyncTest…"))
// can be observed; binding the global console leaked the marker to real stdout
// and failed every `flags: [async]` test (~4.6k).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("#3421 console_log routes through deps.console", () => {
  it("captures console.log output via a partial console proxy (log only)", async () => {
    const r = await compile(
      `var myPrint = function (v: any) { console.log(v); };
function go() { myPrint("Test262:AsyncTestComplete"); }
go();
`,
      {
        allowJs: true,
        fileName: "test.ts",
        skipSemanticDiagnostics: true,
        inferModuleStrictArguments: false,
        deferTopLevelInit: true,
      },
    );
    expect(r.success).toBe(true);
    const lines: string[] = [];
    const consoleProxy = { log: (...v: unknown[]) => lines.push(v.map(String).join(" ")) };
    const imports = buildImports(r.imports!, { console: consoleProxy }, r.stringPool) as any;
    const { instance } = await WebAssembly.instantiate(r.binary!, imports);
    imports.setExports?.(instance.exports);
    (instance.exports as any).__module_init?.();
    expect(lines).toContain("Test262:AsyncTestComplete");
  });
});
