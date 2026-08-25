import { describe, expect, it } from "vitest";
import { getWebHostConstructors } from "../src/runtime/web-host-constructors.js";
import { compileValid, hostImportNames, instantiate } from "./real-world-helpers.js";

/**
 * Real-world browser / Web-platform APIs.
 *
 * These globals (`fetch`, `URL`, `TextEncoder`, `crypto`, timers, the DOM…)
 * are not part of the ECMAScript spec, so test262 never touches them. Real
 * apps use them constantly. The compiler lowers each to a host-import at the
 * Wasm boundary; these tests pin down that the lowering produces a valid
 * module and requests the expected `env.*` import.
 */
describe("real-world: Web APIs", () => {
  it("lowers fetch() to a host import and awaits a Response", async () => {
    const result = await compileValid(`
      export async function fetchLength(url: string): Promise<number> {
        const res = await fetch(url);
        const text = await res.text();
        return text.length;
      }
    `);
    const hosts = hostImportNames(result);
    expect(hosts).toContain("fetch");
    expect(hosts).toContain("Response_text");
  });

  it("lowers timers to host imports", async () => {
    const result = await compileValid(`
      export function schedule(): void {
        setTimeout(() => {
          console.log("tick");
        }, 100);
      }
    `);
    expect(hostImportNames(result)).toContain("__timer_set_timeout");
  });

  it("compiles TextEncoder().encode()", async () => {
    await compileValid(`
      export function byteLength(s: string): number {
        return new TextEncoder().encode(s).length;
      }
    `);
  });

  it("binds bare TextEncoder/TextDecoder globals to the host constructors", async () => {
    const source = `
      export function byteLength(s: string): number {
        return new TextEncoder().encode(s).length;
      }
      export function roundTrip(): string {
        return new TextDecoder().decode(new TextEncoder().encode("Aé"));
      }
    `;
    const result = await compileValid(source);
    expect(hostImportNames(result)).toEqual(
      expect.arrayContaining(["TextEncoder_new", "TextEncoder_encode", "TextDecoder_new", "TextDecoder_decode"]),
    );
    const exports = await instantiate(source);
    expect(exports.byteLength("Aé")).toBe(3);
    expect(exports.roundTrip()).toBe("Aé");
  });

  it("compiles URL parsing", async () => {
    await compileValid(`
      export function hostname(u: string): string {
        return new URL(u).hostname;
      }
    `);
  });

  it("runs crypto.randomUUID() through the host boundary", async () => {
    const result = await compileValid(`
      declare const crypto: { randomUUID(): string };
      export function id(): string {
        return crypto.randomUUID();
      }
    `);
    expect(hostImportNames(result)).toContain("__crypto_random_uuid");

    const exports = await instantiate(
      `
        declare const crypto: { randomUUID(): string };
        export function id(): string {
          return crypto.randomUUID();
        }
      `,
      { crypto },
    );
    const uuid = exports.id() as string;
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("runs Web base64 globals and compiles assorted Web globals", async () => {
    const source = `
      export function clone(o: any): any {
        return structuredClone(o);
      }
      export function micro(): void {
        queueMicrotask(() => {});
      }
      export function base64(s: string): string {
        return btoa(s);
      }
      export function unbase64(s: string): string {
        return atob(s);
      }
      export function abortable(): any {
        const c = new AbortController();
        c.abort();
        return c.signal;
      }
    `;
    const result = await compileValid(source);
    expect(hostImportNames(result)).toEqual(expect.arrayContaining(["atob", "btoa"]));
    const webHost = getWebHostConstructors();
    expect(webHost).toMatchObject({ atob: expect.any(Function), btoa: expect.any(Function) });
    const exports = await instantiate(source, webHost);
    expect(exports.base64("foo")).toBe("Zm9v");
    expect(exports.unbase64("Zm9v")).toBe("foo");
  });

  it("compiles a Headers map", async () => {
    await compileValid(`
      export function header(name: string, value: string): string | null {
        const h = new Headers();
        h.set(name, value);
        return h.get(name);
      }
    `);
  });

  it("runs DOM manipulation against a host document", async () => {
    const makeEl = (): Record<string, any> => {
      const el: Record<string, any> = {
        style: {},
        textContent: "",
        children: [] as any[],
        append(child: any) {
          el.children.push(child);
          return child;
        },
      };
      return el;
    };
    const body = makeEl();
    const document = { createElement: () => makeEl(), body };

    const source = `
        declare const document: any;
        export function render(label: string): number {
          const box = document.createElement("div");
          box.textContent = label;
          box.style.color = "red";
          document.body.append(box);
          return 1;
        }
      `;
    const result = await compileValid(source);
    expect(hostImportNames(result)).toContain("global_document");
    const exports = await instantiate(source, { document });

    expect(exports.render("Hello")).toBe(1);
    expect(body.children).toHaveLength(1);
    expect(body.children[0].textContent).toBe("Hello");
    expect(body.children[0].style.color).toBe("red");
  });
});
