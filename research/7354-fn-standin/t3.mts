import { readFileSync, writeFileSync } from "node:fs";
import { compile } from "../src/test262/test262-prepared-entry.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { rewriteFunctionValues } from "../scripts/ir-census/fn-standin.mjs";
const options = () =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required", version: 1 }),
    allowJs: true, fileName: "test.js", sourceMap: false, emitWat: false, skipSemanticDiagnostics: true,
    target: "standalone", inferModuleStrictArguments: false, scriptGoal: true, deferTopLevelInit: true,
    hostBridge: "always", trackIrOutcomes: true,
  }) as any;
const parts = process.argv.slice(2);
const body = parts.filter((p) => !p.endsWith(".js")).join("\n");
const src = parts.filter((p) => p.endsWith(".js")).map((f) => readFileSync(f, "utf8")).join("\n") + "\n" + body + "\n";
const out = rewriteFunctionValues(src, 1);
writeFileSync(".tmp/t3-src.js", out);
const t = Date.now();
const r: any = await compile(out, options());
let ran = "";
if (r.success) {
  try { (instantiatePreparedArtifact(r).instance.exports.__module_init as any)?.(); ran = "returned"; } catch (e: any) { ran = "threw " + String(e?.message ?? e).slice(0, 200); }
}
console.log(r.success, Date.now() - t, "ms", ran);
for (const e of (r.errors ?? []).slice(0, 4)) console.log("  ", e.line, e.message.slice(0, 300));
