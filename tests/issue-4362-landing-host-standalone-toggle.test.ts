// #4362 — the landing page's "JS host" toggle must actually re-measure the
// feature list, not just grey out the rows tagged `feat-host`.
//
// Before this issue the three numeric layers behaved as follows:
//   • the headline conformance donut swapped datasets (correct),
//   • the per-edition pass bars re-rendered from a MEMOISED host-only fetch,
//   • the per-feature rows were hydrated ONCE from `feature-examples.json`.
// So a reader in standalone mode saw js-host numbers presented as standalone
// ones. For `eval()` that understated the row by more than 2x (158/357 host vs
// 332/357 standalone), which is the exact opposite of the direction anyone
// would assume a "no JS host" toggle moves things.
//
// These tests drive the REAL website/index.html in jsdom with stubbed
// catalogs, because the failure mode was entirely in the wiring: every
// individual piece (fetch, badge derivation, toggle listener) worked, and the
// bug was that the toggle never reached the row-level apply.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const INDEX_HTML = resolve(ROOT, "website", "index.html");
const VIEW_STATE_JS = resolve(ROOT, "website", "components", "t262-view-state.js");

const EVAL_ROW = '.feat-row[data-t262-paths="language/eval-code,built-ins/eval"]';

const hostCatalog = {
  features: [{ name: "eval()", testCategories: ["language/eval-code"], passCount: 158, totalCount: 357 }],
};
const standaloneCatalog = {
  features: [{ name: "eval()", testCategories: ["language/eval-code"], passCount: 332, totalCount: 357 }],
};

/** Boot index.html with a fetch stub that serves the two feature catalogs. */
async function bootPage(options: { withStandalone: boolean; withHost?: boolean; stallHost?: boolean }) {
  const html = readFileSync(INDEX_HTML, "utf8");
  const virtualConsole = new VirtualConsole(); // swallow canvas/chart noise
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://js2wasm.test/",
    virtualConsole,
    beforeParse(w: any) {
      // jsdom lacks these; the page's chart/theme code throws without them and
      // would abort the script before the feature hydration ever runs.
      w.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
      });
      w.scrollTo = () => {};
      // jsdom does not load external <script src>; the page's inline script
      // reads window.t262ViewState at its first line, so install it here.
      w.eval(readFileSync(VIEW_STATE_JS, "utf8"));
      w.IntersectionObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      w.__hostFeatureRequests = 0;
      w.fetch = async (url: unknown) => {
        const s = String(url);
        if (s.includes("feature-examples.json")) {
          w.__hostFeatureRequests++;
          if (options.stallHost) return new Promise(() => {});
        }
        // Order matters: the standalone filename CONTAINS the host one.
        const body = s.includes("feature-examples-standalone.json")
          ? options.withStandalone
            ? standaloneCatalog
            : null
          : s.includes("feature-examples.json")
            ? options.withHost === false
              ? null
              : hostCatalog
            : null;
        if (!body) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => body };
      };
    },
  });
  // Let the page's async hydration settle.
  await new Promise((r) => setTimeout(r, 1500));
  return dom;
}

/** Read the measurement elements and selected-lane availability message. */
function readRow(dom: JSDOM) {
  const row = dom.window.document.querySelector(EVAL_ROW);
  return {
    found: row != null,
    chip: row?.querySelector(".feat-row-counts")?.textContent?.trim(),
    pct: row?.querySelector(".feat-badge-pct")?.textContent?.trim(),
    link: row?.querySelector(".feat-report-link a")?.textContent?.trim(),
    spread: row?.querySelector(".feat-edition-spread")?.textContent?.trim(),
    glyph: row?.querySelector(".feat-badge")?.getAttribute("data-glyph"),
    unavailable: dom.window.document.getElementById("feature-data-unavailable")?.textContent?.trim(),
  };
}

async function setStrictMode(dom: JSDOM, checked: boolean) {
  const toggle = dom.window.document.getElementById("strict-only-toggle") as HTMLInputElement;
  toggle.checked = checked;
  toggle.dispatchEvent(new dom.window.Event("change"));
  await new Promise((r) => setTimeout(r, 600));
}

// The JS-host lane was retired on 2026-10-12 and its toggle removed
// (#6979 S7-e). The #4362 wiring bug cannot recur in its original form, but
// the invariant it established still holds: the feature list shows the
// STANDALONE catalog's numbers, not the frozen host catalog's.
describe("#4362 / #6979 S7-e landing feature list reads the standalone lane", () => {
  let dom: JSDOM;
  beforeAll(async () => {
    dom = await bootPage({ withStandalone: true });
  }, 60_000);
  afterAll(() => dom?.window?.close());

  it("has no JS-host toggle", () => {
    expect(dom.window.document.getElementById("host-support-toggle")).toBeNull();
  });

  it("hydrates the standalone catalog", () => {
    const row = readRow(dom);
    expect(row.found).toBe(true);
    // The whole point of #4362: the standalone number, not the host one.
    expect(row.chip).toBe("332 / 357");
    expect(row.pct).toBe("93%");
  });

  it("updates the 'View test results' link too, not just the badge", () => {
    expect(readRow(dom).link).toBe("View test results (332/357) →");
  });
});

describe("#4362 standalone catalog without the retired host catalog", () => {
  let dom: JSDOM;
  beforeAll(async () => {
    dom = await bootPage({ withStandalone: true, withHost: false });
  }, 60_000);
  afterAll(() => dom?.window?.close());

  it("hydrates standalone counts without depending on host data", () => {
    expect((dom.window as any).__hasStandaloneFeatureData).toBe(true);
    expect((dom.window as any).__hostFeatureRequests).toBe(0);
    expect(readRow(dom)).toMatchObject({
      chip: "332 / 357",
      pct: "93%",
      link: "View test results (332/357) →",
      unavailable: undefined,
    });
  });

  it("hydrates standalone counts without requesting a host transport that would never settle", async () => {
    const stalledHost = await bootPage({ withStandalone: true, stallHost: true });
    try {
      expect((stalledHost.window as any).__hostFeatureRequests).toBe(0);
      expect(readRow(stalledHost)).toMatchObject({
        chip: "332 / 357",
        pct: "93%",
        link: "View test results (332/357) →",
        unavailable: undefined,
      });
    } finally {
      stalledHost.window.close();
    }
  });

  it("keeps standalone counts when strict mode reapplies the catalog", async () => {
    await setStrictMode(dom, true);
    expect(readRow(dom)).toMatchObject({
      chip: "332 / 357",
      pct: "93%",
      link: "View test results (332/357) →",
    });
    await setStrictMode(dom, false);
    expect(readRow(dom).chip).toBe("332 / 357");
  });
});

describe("#4362 standalone catalog absent with a valid retired host catalog", () => {
  let dom: JSDOM;
  beforeAll(async () => {
    dom = await bootPage({ withStandalone: false });
  }, 60_000);
  afterAll(() => dom?.window?.close());

  it("marks standalone measurements unavailable without borrowing host counts", () => {
    expect((dom.window as any).__hasStandaloneFeatureData).toBe(false);
    expect(readRow(dom)).toMatchObject({
      chip: undefined,
      pct: undefined,
      link: undefined,
      spread: undefined,
      glyph: "–",
      unavailable: "Standalone feature measurements are unavailable.",
    });
  });

  it("clears stale measurements on strict-mode reapplication", async () => {
    const row = dom.window.document.querySelector(EVAL_ROW)!;
    row.querySelector(".feat-name")!.insertAdjacentHTML("beforeend", '<span class="feat-row-counts">158 / 357</span>');
    row.querySelector(".feat-badge")!.insertAdjacentHTML("beforeend", '<span class="feat-badge-pct">44%</span>');
    row.insertAdjacentHTML("beforeend", '<div class="feat-edition-spread">ES2015 158/357</div>');
    row
      .querySelector("details")!
      .insertAdjacentHTML("beforeend", '<div class="feat-report-link"><a>View test results (158/357) →</a></div>');
    await setStrictMode(dom, true);
    expect(readRow(dom)).toMatchObject({
      chip: undefined,
      pct: undefined,
      link: undefined,
      spread: undefined,
      glyph: "–",
    });
    await setStrictMode(dom, false);
    expect(readRow(dom)).toMatchObject({
      chip: undefined,
      pct: undefined,
      link: undefined,
      spread: undefined,
      glyph: "–",
      unavailable: "Standalone feature measurements are unavailable.",
    });
  });
});
