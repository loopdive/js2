// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6689 — out-of-process probe for tests/issue-6689-extern-set-decide-fnctor-proto.test.ts.
// A native-regime compile of the assembled test262 harness exceeds the 512 MB
// Vitest fork (same pattern as issue-6687-regime-probe.mts). Per (file, profile)
// prints the validation error (null = valid), whether instantiation + module
// init completed (`run`: null = ran clean, else the thrown message) and a sha256.
//
// Profiles:
//   regime      native-first + JS2WASM_NATIVE_REGIME_JS=1, run with the JS runtime
//   standalone  target standalone (hash only — the elision pre-pass removes the
//               harness's dead `eval`, so the #4504 runtime is inactive here)
//   default     gc host (hash only)
//   standalone-dyn  target standalone with a live `Function(...)` call injected,
//               which activates the #4504 inherited-set runtime without a JS host
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { compile } from "../../src/index.ts";
import { buildCompiledImports } from "../../src/runtime.ts";
import { assembleOriginalHarness } from "../test262-original-harness.ts";
import { parseMeta } from "../test262-runner.ts";

const DYN = 'if (f === 12345) Function("return 1");\n';

const [filesArg = "", profilesArg = "regime,standalone,default"] = process.argv.slice(2);
const out: { file: string; profile: string; error: string | null; run?: string | null; sha256?: string }[] = [];
for (const file of filesArg.split(",").filter(Boolean)) {
  const raw = readFileSync(`test262/test/${file}`, "utf-8");
  for (const profile of profilesArg.split(",")) {
    const src = profile === "standalone-dyn" ? raw.replace(/^(var f = new foo\(\);\n)/m, `$1${DYN}`) : raw;
    const source = assembleOriginalHarness(src, parseMeta(src) as never).primary.source;
    if (profile === "regime") process.env.JS2WASM_NATIVE_REGIME_JS = "1";
    else delete process.env.JS2WASM_NATIVE_REGIME_JS;
    const opts: Record<string, unknown> =
      profile === "regime"
        ? { semanticProviders: "native-first" }
        : profile.startsWith("standalone")
          ? { target: "standalone" }
          : {};
    const r = await compile(source, {
      skipSemanticDiagnostics: true,
      inferModuleStrictArguments: false,
      ...opts,
    } as never);
    if (!r.success) {
      out.push({ file, profile, error: `compile error: ${r.errors?.[0]?.message}` });
      continue;
    }
    const sha256 = createHash("sha256").update(r.binary).digest("hex");
    let error: string | null = null;
    try {
      new WebAssembly.Module(r.binary);
    } catch (e) {
      error = (e as Error).message;
    }
    let run: string | null | undefined;
    if (error === null && (profile === "regime" || profile === "standalone-dyn")) {
      try {
        if (profile === "regime") {
          const imports = buildCompiledImports(r as never) as WebAssembly.Imports & {
            setInstance?: (i: WebAssembly.Instance) => void;
          };
          // The harness's dead `$262.evalScript` links the runtime-eval
          // provider module; this repro never reaches it, so stub any module
          // the JS runtime does not supply with throwing functions.
          const mod = new WebAssembly.Module(r.binary);
          const table = imports as Record<string, Record<string, unknown>>;
          for (const imp of WebAssembly.Module.imports(mod)) {
            if (table[imp.module] !== undefined || imp.kind !== "function") continue;
            const stub: Record<string, unknown> = {};
            for (const i of WebAssembly.Module.imports(mod)) {
              if (i.module === imp.module)
                stub[i.name] = () => {
                  throw new Error(`#6689 probe: unexpected call to ${i.module}.${i.name}`);
                };
            }
            table[imp.module] = stub;
          }
          const instance = await WebAssembly.instantiate(mod, imports);
          imports.setInstance?.(instance);
          (instance.exports.test as (() => unknown) | undefined)?.();
        } else {
          new WebAssembly.Instance(new WebAssembly.Module(r.binary), {});
        }
        run = null;
      } catch (e) {
        run = (e as Error).message;
      }
    }
    out.push({ file, profile, error, ...(run === undefined ? {} : { run }), sha256 });
  }
}
process.stdout.write(JSON.stringify(out));
