// The landing page keeps the legacy ES3/Core feature section in the static
// catalog, while the current edition artifacts publish its old-test residue
// as `Unclassified (legacy)`. Keep the alias visible in the section header.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const INDEX_HTML = resolve(ROOT, "website", "index.html");

const hostEditions = [
  { edition: "Unclassified (legacy)", pass: 273, fail: 0, ce: 0, skip: 0, total: 273, pct: 100 },
  { edition: "ES5", pass: 7649, fail: 1361, ce: 19, skip: 0, total: 9029, pct: 85 },
];
const standaloneEditions = [
  { edition: "Unclassified (legacy)", pass: 271, fail: 2, ce: 0, skip: 0, total: 273, pct: 99 },
  { edition: "ES5", pass: 8454, fail: 535, ce: 40, skip: 0, total: 9029, pct: 94 },
];

async function bootPage() {
  const html = readFileSync(INDEX_HTML, "utf8");
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://js2wasm.test/",
    virtualConsole,
    beforeParse(window: any) {
      window.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
      });
      window.scrollTo = () => {};
      window.IntersectionObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      window.fetch = async (url: unknown) => {
        const path = String(url);
        if (path.includes("test262-standalone-editions.json")) {
          return { ok: true, status: 200, json: async () => standaloneEditions };
        }
        if (path.includes("test262-editions.json")) {
          return { ok: true, status: 200, json: async () => hostEditions };
        }
        if (path.includes("es-edition-features.json")) {
          return { ok: true, status: 200, json: async () => ({ features: [] }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return dom;
}

function readLegacyPassbar(dom: JSDOM) {
  const section = [...dom.window.document.querySelectorAll(".feat-section")].find(
    (candidate) => candidate.querySelector(".feat-edition-label")?.textContent?.trim() === "ES3 / Core",
  );
  return {
    count: section?.querySelector(".feat-edition-passbar-count")?.textContent?.trim(),
    pct: section?.querySelector(".feat-edition-passbar-text")?.textContent?.trim(),
  };
}

describe("landing ES3/Core edition passbar", () => {
  it("uses the legacy bucket for the static ES3/Core section", async () => {
    const dom = await bootPage();
    try {
      expect(readLegacyPassbar(dom)).toEqual({ count: "271 / 273", pct: "99%" });

      const toggle = dom.window.document.getElementById("host-support-toggle") as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new dom.window.Event("change"));
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(readLegacyPassbar(dom)).toEqual({ count: "273 / 273", pct: "100%" });
    } finally {
      dom.window.close();
    }
  }, 30_000);
});
