import { readFileSync } from "node:fs";
import { compile } from "../src/test262/test262-prepared-entry.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
const options = () => ({ wholeProgram: Object.freeze({ kind: "prepared-program-required", version: 1 }), backend: "wasmgc", target: "standalone", sourceMap: false, optimize: false, emitWat: false, fileName: "test.js", allowJs: true, deferTopLevelInit: true, scriptGoal: true, skipSemanticDiagnostics: true }) as any;
const progs: Record<string,string> = {
 newF: "function F(a){ this.a = a; } var o = new F(1); if (o.a !== 1) throw 1;",
 newT: "function T(m){ this.message = m || ''; } function g(){ throw new T('x'); } try { g(); } catch (e) {}",
 sta: readFileSync("test262/harness/sta.js","utf8"),
 fnExprVarCallOther: "var h; h = function (v) { return v; }; function g(x){ return h(x); } if (g(1) !== 1) throw 1;",
 voidWrap: "function a(m){ if (!m) throw 1; } var a$fv = function (m) { return a(m); }; function g(){ a$fv(true); } g();",
};
for (const [n, src] of Object.entries(progs)) {
  if (process.argv[2] && process.argv[2] !== n) continue;
  const t = Date.now();
  const r: any = await compile(src, options());
  let ran = "";
  if (r.success) { try { (instantiatePreparedArtifact(r).instance.exports.__module_init as any)?.(); ran = "returned"; } catch (e: any) { ran = "threw " + (e?.message ?? e); } }
  console.log("##", n, r.success, Date.now() - t, "ms", ran, r.errors?.map((e: any) => `${e.line}: ${e.message}`).slice(0, 3));
}
