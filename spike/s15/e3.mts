import { prepared } from "./bridge.mts";
for (const src of [
  'var __d; function lib_getParseInt() { return __d; }\nvar f = lib_getParseInt(); if (f("7") !== 7) throw 1;',
  'var __d; function lib_obj() { return __d; }\nvar o = lib_obj(); if (o.a !== 1) throw 1;',
  'var __d; function lib_obj() { return __d; }\nvar o = lib_obj(); o.b = 2;',
  'var __d; function lib_obj() { return __d; }\nvar o = lib_obj(); if (typeof o !== "object") throw 1;',
]) { try { await prepared(src); console.log("compiled:", src.split("\n")[1]); } catch (e: any) { console.log("refused:", src.split("\n")[1], "->", e.message.slice(0, 160)); } }
