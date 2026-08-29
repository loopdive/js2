// The landing page keeps the legacy ES3/Core feature section in the static
// catalog, while the current edition artifacts publish its old-test residue as
// `Unclassified (legacy)`. The alias stays visible in the section header — but
// the header must NOT present that bucket's ratio as a rate.
//
// Editions are read from test frontmatter, and ES1–ES3 predate every marker
// Test262 has (`es5id` is the oldest, and it names the ES5.1 section defining a
// feature, not the edition that introduced it). So `Unclassified (legacy)` is
// "frontmatter carries no edition marker", i.e. metadata residue — not "the ES3
// tests". Rendering 273/273 as "100%" stated an ES3 conformance figure the data
// cannot support, directly above rows measured at 83%, 87% and 66%.
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
  it("shows the legacy population without stating a rate, in either lane", async () => {
    const dom = await bootPage();
    try {
      // Standalone lane: the bucket is 271/273, which would have rendered 99%.
      expect(readLegacyPassbar(dom)).toEqual({ count: "273 unmarked files", pct: "unclassified" });

      const toggle = dom.window.document.getElementById("host-support-toggle") as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new dom.window.Event("change"));
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Host lane: 273/273. A rate here is the specific claim to avoid — it is
      // the "100%" that reads as "ES3 is done".
      expect(readLegacyPassbar(dom)).toEqual({ count: "273 unmarked files", pct: "unclassified" });
    } finally {
      dom.window.close();
    }
  }, 30_000);

  it("marks the bar as not-an-edition and explains why, but leaves real editions alone", async () => {
    const dom = await bootPage();
    try {
      const sectionFor = (label: string) =>
        [...dom.window.document.querySelectorAll(".feat-section")].find(
          (candidate) => candidate.querySelector(".feat-edition-label")?.textContent?.trim() === label,
        );

      const legacyBar = sectionFor("ES3 / Core")?.querySelector(".feat-edition-passbar");
      expect(legacyBar?.hasAttribute("data-not-an-edition")).toBe(true);
      expect(legacyBar?.getAttribute("title")).toContain("no edition marker");
      expect(legacyBar?.getAttribute("title")).toContain("NOT an ES3 conformance rate");
      // The track is not filled to a ratio that would be read as conformance.
      expect((legacyBar?.querySelector(".feat-edition-passbar-fill") as HTMLElement)?.style.width).toBe("0%");

      // ES5 is a real edition bucket and keeps its measured rate.
      const es5Bar = sectionFor("ES5")?.querySelector(".feat-edition-passbar");
      expect(es5Bar?.hasAttribute("data-not-an-edition")).toBe(false);
      expect(es5Bar?.querySelector(".feat-edition-passbar-text")?.textContent?.trim()).toBe("94%");
      expect(es5Bar?.querySelector(".feat-edition-passbar-count")?.textContent?.trim()).toBe("8,454 / 9,029");
    } finally {
      dom.window.close();
    }
  }, 30_000);
});
