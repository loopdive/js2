import { compile } from "../src/test262/test262-prepared-entry.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
const options = () =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required", version: 1 }),
    backend: "wasmgc", target: "standalone", sourceMap: false, optimize: false, emitWat: false,
    fileName: "test.js", allowJs: true,
  }) as any;
const progs: Record<string, string> = {
  // the repros of the brief, declaration form
  selfRead: "function f(){ return f._x; } f._x = 1; f();",
  selfWrite: "function f(){ f._y = 2; } f();",
  selfCall: "function f(n){ if (n) return f(n - 1); return 0; } if (f(3) !== 0) throw 1;",
  selfCallTernary: "function f(n){ return n ? f(n-1) : 0 } if (f(3) !== 0) throw 1;",
  topSet: "function assert(){} assert.throws = function(){};",
  readAfter: "function assert(){} assert._toString = function(v){ return v; }; function g(){ return assert._toString(1); } g();",
  readBefore: "function g(){ return assert._toString(1); } function assert(){} assert._toString = function(v){ return v; }; g();",
  verifyPropertyAlias: "function vp(o){ return o; } var alias = vp; function h(opts){ var v = opts || vp; return v(1); } h();",
  // the same shapes through Fa's function-expression value (what (a) would hand to (b))
  exprTopSet: "var f = function(){}; f.k = 1;",
  exprTopGet: "var f = function(){}; if (f.k !== undefined) throw 1;",
  exprSelfGet: "var f = function(){ return f.k; }; f();",
  exprMemberCall: "var f = function(){}; function g(){ return f.k(1); } g();",
  exprConcatCall: "var h = function(v){ return v; }; function g(x){ return 'a' + h(x); } g(1);",
  closureDirectCall: "function a(m){ if (!m) throw 1; } var o = function (x) { a(x); }; o(true);",
};
const only = process.argv[2];
for (const [name, src] of Object.entries(progs)) {
  if (only && name !== only) continue;
  const t = Date.now();
  const r: any = await compile(src, options());
  let ran = "";
  if (r.success) {
    try { (instantiatePreparedArtifact(r).instance.exports.__module_init as any)?.(); ran = "returned"; } catch (e: any) { ran = "threw " + String(e?.message ?? e).slice(0, 120); }
  }
  console.log("##", name, r.success, `${Date.now() - t}ms`, ran);
  for (const e of (r.errors ?? []).slice(0, 4)) console.log("   ", `${e.line ?? ""}:${e.column ?? ""}`, e.message.slice(0, 220));
}
