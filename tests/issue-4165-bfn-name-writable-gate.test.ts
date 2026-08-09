// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4165 regression — a plain write to a LIVE builtin `name`/`length` own
 * property must be a sloppy no-op (§17: writable:false), never a bag store.
 *
 * `__closure_prop_set` used to store unconditionally into the #3468 side-table
 * bag. The stale shadow stayed masked while the #2896 metadata was live (reads
 * answer from metadata first) and surfaced the moment `delete fn.name` cleared
 * the metadata: hasOwnProperty/gOPD then answered from the bag, so
 * `verifyProperty`'s own non-writable probe write broke its later configurable
 * check — the 7-test test262 `built-ins/Object/<fn>/name.js` + `length.js` family.
 *
 * The counterpart must keep working: AFTER a delete, assignment creates an
 * ordinary own property (metadata is gone, the bag is the right home), and
 * ordinary expandos on user functions are untouched by the gate.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(body: string): Promise<number> {
  const src = `
var __r: number = 0;
${body}
export function test(): number { return __r; }
`;
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, target: "standalone" });
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  const ex = instance.exports as Record<string, () => number>;
  if (typeof ex.__module_init === "function") ex.__module_init();
  return ex.test();
}

describe("#4165 — builtin fn name/length writable gate", () => {
  it("write to live builtin .name no-ops; delete then reports absent (the regressed cycle)", async () => {
    const mask = await run(`
      var f: any = Object.defineProperty;
      f.name = "clobber";
      __r += (f.name === "defineProperty" ? 1 : 0) * 1;   // write no-oped
      __r += (f.hasOwnProperty("name") ? 1 : 0) * 2;      // still an own prop
      __r += ((delete f.name) ? 1 : 0) * 4;               // configurable -> delete succeeds
      __r += (!f.hasOwnProperty("name") ? 1 : 0) * 8;     // gone — no stale bag shadow
    `);
    expect(mask).toBe(15);
  });

  it("gOPD on a live builtin .name reports the §17 attributes", async () => {
    const mask = await run(`
      var d: any = Object.getOwnPropertyDescriptor(Object.create, "name");
      __r += (d !== undefined && d !== null ? 1 : 0) * 1;
      __r += (d && d.value === "create" ? 1 : 0) * 2;
      __r += (d && d.writable === false ? 1 : 0) * 4;
      __r += (d && d.configurable === true ? 1 : 0) * 8;
    `);
    expect(mask).toBe(15);
  });

  it("after delete, assignment creates an ordinary own property (gate must not block it)", async () => {
    const mask = await run(`
      var f: any = Object.isExtensible;
      __r += ((delete f.name) ? 1 : 0) * 1;
      f.name = "mine";
      __r += (f.name === "mine" ? 1 : 0) * 2;             // post-delete write lands
      __r += (f.hasOwnProperty("name") ? 1 : 0) * 4;      // and is an own prop
    `);
    expect(mask).toBe(7);
  });

  it("ordinary expandos on a user function are untouched by the gate", async () => {
    const mask = await run(`
      function mine(): number { return 1; }
      var f: any = mine;
      f.tag = 42;
      __r += (f.tag === 42 ? 1 : 0) * 1;
      __r += (f.hasOwnProperty("tag") ? 1 : 0) * 2;
      __r += ((delete f.tag) ? 1 : 0) * 4;
      __r += (!f.hasOwnProperty("tag") ? 1 : 0) * 8;
    `);
    expect(mask).toBe(15);
  });
});
