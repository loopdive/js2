// (#1795) node:http (+ https) — GET round-trip (axios unblocker, Tier 0).
// `import { get } from "node:http"` routes through NODE_BUILTIN_FN_TYPED_STUBS
// (`__nodefn__http__get` → require("http").get); the node_builtin_fn runtime
// adapter wraps wasm-closure args as JS callables (identity-cached bridge), and
// the response externref's `.on(...)` listeners ride the #1794 EventEmitter
// closure-callback contract (any-receiver deferred-listener classification).
// Includes the #3329 fix: sibling STORED callbacks capturing the same mutable
// local now alias ONE ref cell (localMap rebind for deferred callbacks) — the
// "data" accumulator is finally visible to the "end" listener.
import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function instantiate(src: string) {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const imports = buildImports(r.imports ?? [], undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary!, imports as unknown as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance.exports as Record<string, Function>;
}

function listen(body: string): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(body);
  });
  return new Promise((resolve) =>
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    }),
  );
}

const drain = (ms = 500) => new Promise((res) => setTimeout(res, ms));

describe("#1795 node:http GET round-trip (Tier 0)", () => {
  it("acceptance shape: get(url, res => res.on(data/end)) delivers the body through cb", async () => {
    const { server, url } = await listen("hello-1795");
    try {
      const ex = await instantiate(`
import { get } from "node:http";
let out: string = "";
export function getOut(): string { return out; }
function fetchText(url: string, cb: (s: string) => void): void {
  get(url, (res: any) => {
    let body = "";
    res.on("data", (chunk: any) => { body += chunk.toString(); });
    res.on("end", () => cb(body));
  });
}
export function test(url: string): void {
  fetchText(url, (s: string) => { out = s; });
}
`);
      ex.test!(url);
      await drain();
      expect(ex.getOut!()).toBe("hello-1795");
    } finally {
      server.close();
    }
  });

  it("multi-chunk accumulation across data events (#3329 shared cell)", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.write("part1-");
      setTimeout(() => {
        res.write("part2-");
        setTimeout(() => res.end("part3"), 20);
      }, 20);
    });
    const url: string = await new Promise((resolve) =>
      server.listen(0, () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/`)),
    );
    try {
      const ex = await instantiate(`
import { get } from "node:http";
let out: string = "";
export function getOut(): string { return out; }
export function test(url: string): void {
  get(url, (res: any) => {
    let body = "";
    res.on("data", (chunk: any) => { body += chunk.toString(); });
    res.on("end", () => { out = body; });
  });
}
`);
      ex.test!(url);
      await drain(700);
      expect(ex.getOut!()).toBe("part1-part2-part3");
    } finally {
      server.close();
    }
  });

  it("node:https `get` binds the same way (resolution only — TLS is the host's)", async () => {
    // No localhost TLS server in the unit lane; assert the import compiles and
    // the call reaches the host binding (an invalid-URL error, not a silent
    // no-op or a struct-arg type error).
    const ex = await instantiate(`
import { get } from "node:https";
let err: string = "";
export function getErr(): string { return err; }
export function test(): void {
  try {
    get("not-a-valid-url", (res: any) => {});
  } catch (e: any) {
    err = "threw";
  }
}
`);
    ex.test!();
    expect(ex.getErr!()).toBe("threw"); // require("https").get rejected the URL — binding is live
  });
});
