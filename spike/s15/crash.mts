import { prepared } from "./bridge.mts";
try { await prepared("var __d; function f(a) { return __d; } function g() { f(0); }"); console.log("compiled"); }
catch (e: any) { console.log(e.constructor.name, e.message.slice(0, 160)); }
