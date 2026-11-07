// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 A2a — one support function per global-scope provider entry. Indirect
// eval, a sloppy script-level direct eval and `Function(...)` each call
// `__runtime_eval_global_call<entry>`, whose body publishes the script
// bindings, calls the provider entry and pulls the bindings back. The call
// sites only evaluate their sources (so the push observes every side effect of
// the arguments, §19.2.1.1) and emit one `call`.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SOURCE = `
var a = "1";
var x = (0, eval)(a);
var y = (0, eval)(a + a);
var z = eval(a + "2");
var f = Function("p", a);
`;

/** Each defined function's name and the names of the functions its body calls. */
function callGraph(wat: string): Map<string, string[]> {
  const names: string[] = [];
  const calls = new Map<string, number[]>();
  let current: string | undefined;
  for (const line of wat.split("\n")) {
    const imported = /^\s*\(import "[^"]*" "[^"]*" \(func \$(\S+)/.exec(line);
    const defined = /^\s*\(func \$(\S+)/.exec(line);
    if (imported) names.push(imported[1]!);
    else if (defined) {
      current = defined[1]!;
      names.push(current);
      calls.set(current, []);
    }
    const call = /^\s*call (\d+)\s*$/.exec(line);
    if (call && current) calls.get(current)!.push(Number(call[1]));
  }
  return new Map([...calls].map(([name, callees]) => [name, callees.map((index) => names[index]!)]));
}

const callersOf = (graph: Map<string, string[]>, callee: string) =>
  [...graph].filter(([, callees]) => callees.includes(callee)).map(([name]) => name);

describe("#7106 A2a — global-scope eval through one support function per entry", () => {
  it("routes every site through the entry's support function, which alone pushes and calls the provider", async () => {
    const result = await compile(SOURCE, { target: "standalone", fileName: "test.js", emitWat: true });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const graph = callGraph(result.wat);
    const indirect = "__runtime_eval_global_call__runtime_indirect_eval";
    const fnctor = "__runtime_eval_global_call__runtime_new_function";

    expect(callersOf(graph, "__runtime_indirect_eval_import")).toEqual([indirect]);
    expect(callersOf(graph, "__runtime_new_function_import")).toEqual([fnctor]);
    // the push happens inside the support function, after the site evaluated its sources
    const pushers = callersOf(graph, "__runtime_eval_push_globals");
    expect(pushers).toEqual(expect.arrayContaining([indirect, fnctor]));
    const sites = [...new Set([...callersOf(graph, indirect), ...callersOf(graph, fnctor)])];
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) expect(pushers, site).not.toContain(site);
    // two indirect sites and the script-level direct eval share one support function
    const indirectCalls = [...graph.values()].flat().filter((callee) => callee === indirect);
    expect(indirectCalls).toHaveLength(3);
  });
});
