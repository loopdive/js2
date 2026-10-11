// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6710 — out-of-process probe for tests/issue-6710-native-regime-promise-reaction-dispatch.test.ts.
// A native-regime compile of the assembled test262 harness exceeds the 512 MB
// Vitest fork, so the test runs this script with a larger heap. For each
// (file, profile) it compiles, instantiates, runs the deferred init, drains the
// native microtask queue, and prints one JSON array of
// { file, profile, sha256, complete, error }.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { compile } from "../../src/index.ts";
import { buildImports } from "../../src/runtime.ts";
import { assembleOriginalHarness } from "../test262-original-harness.ts";
import { createTestSandbox, parseMeta } from "../test262-runner.ts";

const PROFILES: Record<string, Record<string, unknown>> = {
  regime: { semanticProviders: "native-first" },
  standalone: { target: "standalone" },
  default: {},
};

// The harness's global reads route through the runtime-eval dynamic scope in a
// JS environment; no row here evaluates code, so a refusing stub stands in for
// the prebuilt provider artifact the sharded runner links.
function stubMissingModules(module: WebAssembly.Module, imports: Record<string, Record<string, unknown>>): void {
  for (const { module: mod, name, kind } of WebAssembly.Module.imports(module)) {
    if (kind !== "function") continue;
    imports[mod] ??= {};
    imports[mod]![name] ??= () => {
      throw new Error(`#6710 probe: ${mod}.${name} is not provided`);
    };
  }
}

const [filesArg = "", profilesArg = "regime,standalone,default"] = process.argv.slice(2);
const out: { file: string; profile: string; sha256?: string; complete: boolean; error: string | null }[] = [];
for (const file of filesArg.split(",").filter(Boolean)) {
  const src = readFileSync(`test262/test/${file}`, "utf-8");
  const source = assembleOriginalHarness(src, parseMeta(src) as never).primary.source;
  for (const profile of profilesArg.split(",")) {
    const r = (await compile(source, {
      skipSemanticDiagnostics: true,
      inferModuleStrictArguments: false,
      deferTopLevelInit: profile !== "standalone",
      ...PROFILES[profile],
    } as never)) as {
      success: boolean;
      binary: Uint8Array;
      errors?: { message: string }[];
      imports?: unknown;
      stringPool?: unknown;
    };
    if (!r.success) {
      out.push({ file, profile, complete: false, error: `compile error: ${r.errors?.[0]?.message}` });
      continue;
    }
    const sha256 = createHash("sha256").update(r.binary).digest("hex");
    const lines: string[] = [];
    const sink = { log: (...v: unknown[]) => lines.push(v.map(String).join(" ")) };
    const consoleProxy = { log: sink.log, error: sink.log, warn: sink.log };
    let error: string | null = null;
    try {
      const module = new WebAssembly.Module(r.binary);
      const io = (
        profile === "standalone"
          ? {}
          : buildImports(r.imports as never, { console: consoleProxy } as never, r.stringPool as never, {
              globalSandbox: createTestSandbox(consoleProxy as unknown as Console),
            })
      ) as Record<string, Record<string, unknown>> & { setInstance?: (i: WebAssembly.Instance) => void };
      stubMissingModules(module, io);
      const instance = new WebAssembly.Instance(module, io as WebAssembly.Imports);
      io.setInstance?.(instance);
      const exp = instance.exports as Record<string, (...a: unknown[]) => unknown>;
      exp.__module_init?.();
      exp.__drain_microtasks?.();
      for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 5));
    } catch (e) {
      error = String((e as Error)?.message ?? e).split("\n")[0]!;
    }
    out.push({ file, profile, sha256, complete: lines.some((l) => l.includes("Test262:AsyncTestComplete")), error });
  }
}
process.stdout.write(JSON.stringify(out));
