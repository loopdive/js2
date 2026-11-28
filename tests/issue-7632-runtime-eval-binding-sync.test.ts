// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7632 — the runtime-eval push/pull helpers are filled from the program's eval-visible bindings. An emitter reached
// during declaration collection (here: the `Function` companion seed, flushed by the `any`-typed export's dynamic
// boundary bridge) used to fill them before `registerReassignedFunctionGlobals` had made `d` a live `$__mod_d`
// binding. The push then published `d`'s static closure (a `ref`-result trampoline that Prepared IR later refused
// to reuse), and the pull wrote nothing back. The helpers are now filled once the bindings are settled.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SOURCE = `function d(v: string): string { return v; }
export function c(): number { const fn: any = new Function(d("a")); return 1; }
export function f(): number { const F: any = Function; return 1; }
export function s(): any { return 1; }`;

/** The text of one `(func $name …)` form in the emitted WAT. */
function watFunction(wat: string, name: string): string {
  const start = wat.indexOf(`(func $${name} `);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < wat.length; i++) {
    if (wat[i] === "(") depth++;
    else if (wat[i] === ")" && --depth === 0) return wat.slice(start, i + 1);
  }
  return "";
}

/** The index of `(global $name …)` in the global index space: imported globals first, then defined ones. */
function watGlobalIndex(wat: string, name: string): number {
  const globals = wat
    .split("\n")
    .filter((line) => /^\s*\(global \$/.test(line) || /^\s*\(import "[^"]*" "[^"]*" \(global /.test(line));
  return globals.findIndex((line) => line.includes(`(global $${name} `));
}

const LANES = [
  ["gc", {}],
  ["gc, IR off", { experimentalIR: false }],
  ["standalone", { target: "standalone" }],
  ["standalone, IR off", { target: "standalone", experimentalIR: false }],
] as const;

describe("#7632 runtime-eval binding sync", () => {
  // Red on main with the IR on ("could not allocate its exact singleton support"); the IR-off rows are controls.
  it.each(LANES)("compiles a declaration-time Function seed with an eval-visible helper (%s)", async (_, options) => {
    const result = await compile(SOURCE, { fileName: "u.ts", skipSemanticDiagnostics: true, ...options });
    expect(result.errors.filter((e) => e.severity === "error")).toEqual([]);
    expect(result.success).toBe(true);
  });

  // Red on main in every lane: with the IR off the module compiles, but its pull writes nothing back.
  it.each(LANES)("pushes and pulls the live binding of `d`, not its static closure (%s)", async (_, options) => {
    const result = await compile(SOURCE, {
      fileName: "u.ts",
      skipSemanticDiagnostics: true,
      emitWat: true,
      ...options,
    });
    const wat = result.wat ?? "";
    const live = watGlobalIndex(wat, "__mod_d");
    const staticClosure = watGlobalIndex(wat, "__fn_closure_d");
    expect(live).toBeGreaterThanOrEqual(0);
    expect(staticClosure).toBeGreaterThanOrEqual(0);
    const push = watFunction(wat, "__runtime_eval_push_globals");
    const pull = watFunction(wat, "__runtime_eval_pull_globals");
    expect(pull).toMatch(new RegExp(`global\\.set ${live}\\b`));
    expect(push).toMatch(new RegExp(`global\\.get ${live}\\b`));
    expect(push).not.toMatch(new RegExp(`global\\.get ${staticClosure}\\b`));
  });
});
