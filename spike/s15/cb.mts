import { prepared } from "./bridge.mts";
for (const src of [
  'var __d; function lib_call1(f, a) { return __d; }\nvar f = function (v) { return v; };\nif (lib_call1(f, 1) !== 1) throw 1;',
  'var __d; function lib_call1(f, a) { return __d; }\nfunction g(v) { return v; }\nif (lib_call1(g, 1) !== 1) throw 1;',
  'var print = function (v) { return v; }; if (print(1) !== 1) throw 1;',
]) { try { await prepared(src); console.log("compiled:", src.replace(/\n/g, " ").slice(0, 90)); } catch (e: any) { console.log("refused:", src.replace(/\n/g, " ").slice(0, 90), "->", e.message.slice(16, 200)); } }
