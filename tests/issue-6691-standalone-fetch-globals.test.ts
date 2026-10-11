// #6691 — hono's Web/Fetch platform globals leaked `env::` host imports into a
// standalone binary: `new URL(...)` + `url.pathname` (env.URL_new /
// URL_get_pathname / URL_set_pathname), `new Request(...)` / `request.method`
// (env.Request_new / Request_get_method), `new Response(...)`
// (env.Response_new), `new Headers()` (env.Headers_new) and the service-worker
// `addEventListener("fetch", …)` (env.addEventListener). A standalone module may
// import nothing, so a module that merely CONTAINED such code (hono's `mount`,
// `fire`, `Context#newResponse` — none reached by `new Hono(); app.get(...)`)
// could not be instantiated host-free. The honest lowering is an engine
// without the globals (#6664 precedent): `typeof X` is "undefined" and a
// reference throws ReferenceError.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";

async function compileProjectFiles(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "issue-6691-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const result = await compileProject(join(dir, "main.js"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
  return { module, imports };
}

async function run(module: WebAssembly.Module) {
  const instance = await WebAssembly.instantiate(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports as Record<string, (...args: unknown[]) => unknown>;
}

// 0 = no throw, 1 = ReferenceError, 2 = TypeError, 3 = anything else
const CLASSIFY = `function classify(e) { return e instanceof ReferenceError ? 1 : e instanceof TypeError ? 2 : 3; }`;

const FETCH_JS = `
export function mount(request, prefixLength) {
  const url = new URL(request.url);
  url.pathname = url.pathname.slice(prefixLength) || "/";
  return new Request(url, request);
}
export function methodOf(input) { const request = new Request(input); return request.method; }
export function respond(body) { return new Response(body, { headers: new Headers() }); }
export function headersOf(arg) { return arg instanceof Headers ? arg : new Headers(arg); }
export function fire(dispatch) {
  addEventListener("fetch", (event) => { event.respondWith(dispatch(event.request)); });
}
`;

// The shapes hono-base.js / context.js use, trimmed to the lowering-relevant part.
const HONO_SHAPED = `
var createResponseInstance = (body, init) => new Response(body, init);
export class App {
  routes = [];
  mount(path) {
    const prefix = path.length;
    return (request) => {
      const url = new URL(request.url);
      url.pathname = url.pathname.slice(prefix) || "/";
      return new Request(url, request);
    };
  }
  get(path, handler) { this.routes.push({ path, handler }); return this; }
  headers() { return new Headers(); }
  respond(text) { return createResponseInstance(text, { status: 200 }); }
  handleError(err) { if (err instanceof Error) return 1; throw err; }
  fetch = (request, ...rest) => request.method;
  request = (input, init) => {
    if (input instanceof Request) return this.fetch(input);
    return this.fetch(new Request("http://localhost" + input, init));
  };
  fire = () => {
    addEventListener("fetch", (event) => {
      event.respondWith(this.fetch(event.request, event.request.method));
    });
  };
}
`;

describe("#6691 — Web/Fetch globals stay host-free under --target standalone", () => {
  it("a module that contains URL/Request/Response/Headers/addEventListener code imports nothing", async () => {
    const { module, imports } = await compileProjectFiles({
      "fetch.js": FETCH_JS,
      "main.js": `
import { mount, methodOf, respond, headersOf, fire } from "./fetch.js";
${CLASSIFY}
export function pure(x) { return x + 1; }
export function typeofs() {
  return (typeof URL === "undefined" ? 1 : 0) + (typeof Request === "undefined" ? 10 : 0) +
    (typeof Response === "undefined" ? 100 : 0) + (typeof Headers === "undefined" ? 1000 : 0) +
    (typeof addEventListener === "undefined" ? 10000 : 0);
}
export function callMount() { try { mount({ url: "http://a/b/c" }, 2); return 0; } catch (e) { return classify(e); } }
export function callMethod() { try { methodOf("http://a/"); return 0; } catch (e) { return classify(e); } }
export function callRespond() { try { respond("x"); return 0; } catch (e) { return classify(e); } }
export function callHeaders() { try { headersOf({}); return 0; } catch (e) { return classify(e); } }
export function callFire() { try { fire(function () {}); return 0; } catch (e) { return classify(e); } }
`,
    });
    expect(imports).toEqual([]);
    const exports = await run(module);
    expect(exports.pure(41)).toBe(42);
    expect(exports.typeofs()).toBe(11111);
    expect(exports.callMount()).toBe(1);
    expect(exports.callMethod()).toBe(1);
    expect(exports.callRespond()).toBe(1);
    expect(exports.callHeaders()).toBe(1);
    expect(exports.callFire()).toBe(1);
  });

  it("a hono-shaped app compiles with zero imports; the route op runs", async () => {
    const { module, imports } = await compileProjectFiles({
      "app.js": HONO_SHAPED,
      "main.js": `
import { App } from "./app.js";
export function test(n) {
  const app = new App();
  app.get("/users/:id", () => "ok");
  return app.routes.length + n;
}
`,
    });
    expect(imports).toEqual([]);
    expect((await run(module)).test(7)).toBe(8);
  });

  it("typeof folds to undefined and every reached reference throws ReferenceError", async () => {
    const { module, imports } = await compileProjectFiles({
      "app.js": HONO_SHAPED,
      "main.js": `
import { App } from "./app.js";
${CLASSIFY}
function attempt(f) { try { f(); return 0; } catch (e) { return classify(e); } }
export function typeofs() {
  return (typeof URL === "undefined" ? 1 : 0) + (typeof Request === "undefined" ? 10 : 0) +
    (typeof Response === "undefined" ? 100 : 0) + (typeof Headers === "undefined" ? 1000 : 0) +
    (typeof addEventListener === "undefined" ? 10000 : 0) + (typeof URLSearchParams === "undefined" ? 100000 : 0);
}
export function reached() {
  const app = new App();
  return attempt(() => app.mount("/api")({ url: "http://h/api/x" })) +
    attempt(() => app.headers()) * 10 +
    attempt(() => app.respond("t")) * 100 +
    attempt(() => app.request("/x")) * 1000 +
    attempt(() => app.fire()) * 10000;
}
`,
    });
    expect(imports).toEqual([]);
    const exports = await run(module);
    expect(exports.typeofs()).toBe(111111);
    expect(exports.reached()).toBe(11111);
  });

  it("user bindings of the same names keep their own semantics (anti-vacuity control)", async () => {
    const { module, imports } = await compileProjectFiles({
      "shim.js": `
export class Headers { constructor() { this.n = 3; } }
export class URL { constructor(s) { this.pathname = s; } }
export function addEventListener(type, fn) { return type.length + fn(); }
`,
      "main.js": `
import { Headers, URL, addEventListener } from "./shim.js";
export function test() {
  return new Headers().n + new URL("/ab").pathname.length * 10 + addEventListener("fetch", function () { return 100; }) * 100;
}
`,
    });
    expect(imports).toEqual([]);
    expect((await run(module)).test()).toBe(3 + 30 + 105 * 100);
  });
});
