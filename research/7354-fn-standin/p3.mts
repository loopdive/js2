import { compile } from "../src/test262/test262-prepared-entry.js";
const options = () => ({ wholeProgram: Object.freeze({ kind: "prepared-program-required", version: 1 }), backend: "wasmgc", target: "standalone", sourceMap: false, optimize: false, emitWat: false, fileName: "test.js", allowJs: true }) as any;
for (const src of [
  "var g = { global: globalThis }; var f = function(){ return 1; }; function h(){ return f(); } h();",
  "var f = function(){ return 1; }; function h(){ return f(); } h();",
  "var f = function(){ return 1; }; f.k = 2;",
  "var f = function(){}; function g(){ return f.k(1, 2); } g();",
]) {
  const r: any = await compile(src, options());
  console.log(r.success, r.errors?.map((e: any) => e.message.slice(0, 160)));
}
