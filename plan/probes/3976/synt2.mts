/**
 * #3976 depth probe. Arm S could not even simulate the fix because
 * `o[n] !== undefined` was FALSE for a class method — suggesting the method is
 * not reachable as a property VALUE, not merely missing a descriptor. If so the
 * gap is deeper than the own-property surface and the fix scope changes.
 * Controls first; a reading without them is not a result.
 */
import fs from "node:fs";
import path from "node:path";
import { runTest262File } from "../tests/test262-runner.js";

const DIR = path.join(process.cwd(), ".tmp", "probe262b");
fs.mkdirSync(DIR, { recursive: true });

const CASES: [string, string][] = [
  ["control-trivial", `assert.sameValue(1 + 1, 2, "control");`],
  // CONTROL: the method is CALLABLE — this is what the corpus tests rely on.
  ["control-method-call", `class C { m() { return 42; } }
     assert.sameValue(new C().m(), 42, "instance call");`],
  ["control-static-call", `class C { static s() { return 7; } }
     assert.sameValue(C.s(), 7, "static call");`],
  // The real question: is the method reachable as a VALUE?
  ["value-proto-method", `class C { m() { return 42; } }
     assert.sameValue(typeof C.prototype.m, "function", "typeof C.prototype.m");`],
  ["value-instance-method", `class C { m() { return 42; } }
     var c = new C();
     assert.sameValue(typeof c.m, "function", "typeof c.m");`],
  ["value-static-method", `class C { static s() { return 7; } }
     assert.sameValue(typeof C.s, "function", "typeof C.s");`],
  // Identity — §15.7 requires the prototype method and the instance read to be
  // the SAME function object.
  ["identity-proto-vs-instance", `class C { m() { return 42; } }
     var c = new C();
     assert.sameValue(c.m, C.prototype.m, "c.m === C.prototype.m");`],
  // Does the value survive a function boundary (propertyHelper's shape)?
  ["value-proto-method-dynamic", `class C { m() { return 42; } }
     function read(o, n) { return o[n]; }
     assert.sameValue(typeof read(C.prototype, "m"), "function", "typeof o[n]");`],
];

for (const [name, body] of CASES) {
  const file = path.join(DIR, `${name}.js`);
  fs.writeFileSync(file, `/*---\ndescription: ${name}\nflags: [noStrict]\n---*/\n${body}\n`);
  const out: string[] = [];
  for (const lane of ["host", "standalone"] as const) {
    const r = await runTest262File(file, "probe", 60000, lane === "standalone" ? "standalone" : undefined);
    out.push(`${lane}=${r.status}`);
  }
  console.log(`${name.padEnd(28)} ${out.join("  ")}`);
}
