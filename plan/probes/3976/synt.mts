/**
 * #3976 fix-shape probe. `call-builtin-static.ts` resolves class-method
 * descriptors only when arg0/arg1 are compile-time constants. propertyHelper
 * calls `__getOwnPropertyDescriptor(obj, name)` with PARAMETERS, so a syntactic
 * fix cannot reach the corpus — the same trap that made P1's shape-matrix wins
 * fail to convert. This measures whether that distinction is real.
 */
import fs from "node:fs";
import path from "node:path";
import { runTest262File } from "../tests/test262-runner.js";

const DIR = path.join(process.cwd(), ".tmp", "probe262");
fs.mkdirSync(DIR, { recursive: true });

const CASES: [string, string][] = [
  // CONTROL — must pass on both arms, else the harness is lying.
  ["control-trivial", `assert.sameValue(1 + 1, 2, "control");`],
  // A: fully syntactic — arg0 is literally `C.prototype`, arg1 a literal.
  [
    "syntactic-proto-method",
    `class C { m() { return 42; } }
     var d = Object.getOwnPropertyDescriptor(C.prototype, "m");
     assert.notSameValue(d, undefined, "gOPD(C.prototype,'m') should be a descriptor");`,
  ],
  // B: same query behind a FUNCTION BOUNDARY — exactly propertyHelper's shape.
  [
    "dynamic-proto-method",
    `class C { m() { return 42; } }
     function look(o, n) { return Object.getOwnPropertyDescriptor(o, n); }
     var d = look(C.prototype, "m");
     assert.notSameValue(d, undefined, "gOPD(o,n) via params should be a descriptor");`,
  ],
  // C: static, syntactic.
  [
    "syntactic-static-method",
    `class C { static s() { return 1; } }
     var d = Object.getOwnPropertyDescriptor(C, "s");
     assert.notSameValue(d, undefined, "gOPD(C,'s') should be a descriptor");`,
  ],
  // D: hasOwnProperty behind a boundary — the OTHER gate propertyHelper uses.
  [
    "dynamic-hasown-proto-method",
    `class C { m() { return 42; } }
     function has(o, n) { return Object.prototype.hasOwnProperty.call(o, n); }
     assert.sameValue(has(C.prototype, "m"), true, "hasOwnProperty(C.prototype,'m')");`,
  ],
];

for (const [name, body] of CASES) {
  const file = path.join(DIR, `${name}.js`);
  fs.writeFileSync(file, `/*---\ndescription: ${name}\nflags: [noStrict]\n---*/\n${body}\n`);
  for (const lane of ["host", "standalone"] as const) {
    const r = await runTest262File(file, "probe", 60000, lane === "standalone" ? "standalone" : undefined);
    const err = (r as any).error ? ` — ${String((r as any).error).slice(0, 62)}` : "";
    console.log(`${name.padEnd(28)} ${lane.padEnd(11)} ${String(r.status).padEnd(5)}${err}`);
  }
}
