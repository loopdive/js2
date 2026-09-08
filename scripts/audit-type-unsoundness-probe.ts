// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** A single fresh-process sample for audit-type-unsoundness.mjs. */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { compile } from "../src/index.js";

const [specPath, id, lane] = process.argv.slice(2);
const spec = (JSON.parse(readFileSync(specPath, "utf8")) as { id: string; category: string; source: string }[]).find(
  (value) => value.id === id,
);
if (!spec) throw new Error(`Missing probe ${id}`);
const output: string[] = [];
const log = (...args: unknown[]): void => {
  output.push(args.map(String).join(" "));
};
let result: Record<string, unknown> = { id, category: spec.category, lane };
try {
  if (lane === "node") {
    const source = ts.transpileModule(spec.source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    vm.runInNewContext(source, { console: { log } }, { timeout: 2000 });
  } else {
    const r = await compile(spec.source, {
      fileName: "probe.ts",
      ...(lane === "standalone" ? ({ target: "standalone", hostBridge: "always" } as const) : {}),
    });
    if (!r.success) {
      result = { ...result, status: "compile_error", errors: r.errors };
    } else {
      const original = console.log;
      console.log = log;
      try {
        const imports = r.importObject ?? {};
        const { instance } = await WebAssembly.instantiate(r.binary, imports);
        (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
        if (lane === "standalone") {
          const ex = instance.exports as Record<string, Function>;
          if (typeof ex.__stdout_prepare !== "function" || typeof ex.__stdout_char !== "function")
            throw new Error("Missing standalone output observation exports");
          const length = ex.__stdout_prepare();
          let raw = "";
          for (let i = 0; i < length; i++) raw += String.fromCharCode(ex.__stdout_char(i));
          result.rawStdout = raw;
          if (raw.length) output.push(...raw.replace(/\n$/, "").split("\n"));
        }
      } finally {
        console.log = original;
      }
    }
  }
  if (!result.status) result = { ...result, status: "ran", output };
} catch (error) {
  const e = error as Error;
  result = { ...result, status: "runtime_error", name: e.name, message: e.message, output };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
