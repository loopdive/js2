// #4362 follow-up — the "test262 source:" block inside an expanded feature row
// must stay compact.
//
// Rows map to as many as 35 test262 paths (the Operators row), and the block
// printed every one in full. Since those paths share a long directory
// (`language/expressions/` repeated 35 times), the list became the tallest
// element in an expanded row while carrying very little distinguishing text.
//
// Two mechanisms keep it small, and both are pinned here because both are easy
// to regress into "just print the paths":
//   1. the shared directory is factored into the label and stripped from each
//      link (full path stays in href + title, so nothing is lost),
//   2. only the first 6 links render; the rest sit behind a `+N` button.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const INDEX_HTML = resolve(import.meta.dirname, "..", "website", "index.html");

const MANY_PATHS = [
  "language/expressions/addition",
  "language/expressions/subtraction",
  "language/expressions/multiplication",
  "language/expressions/division",
  "language/expressions/modulus",
  "language/expressions/bitwise-and",
  "language/expressions/bitwise-or",
  "language/expressions/bitwise-xor",
  "language/expressions/left-shift",
  "language/expressions/right-shift",
];
const OPERATORS_ROW = "Operators (arithmetic, comparison, logical, bitwise)";

const catalog = {
  features: [
    { name: OPERATORS_ROW, testCategories: MANY_PATHS, passCount: 936, totalCount: 1083 },
    // Single-path row: nothing to factor, nothing to hide.
    { name: "JSON", testCategories: ["built-ins/JSON"], passCount: 120, totalCount: 165 },
  ],
};

let dom: JSDOM;

beforeAll(async () => {
  const html = readFileSync(INDEX_HTML, "utf8");
  dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://js2wasm.test/",
    virtualConsole: new VirtualConsole(),
    beforeParse(w: any) {
      w.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
      });
      w.scrollTo = () => {};
      w.IntersectionObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      w.fetch = async (u: unknown) => {
        const s = String(u);
        return s.includes("feature-examples.json") && !s.includes("standalone")
          ? { ok: true, status: 200, json: async () => catalog }
          : { ok: false, status: 404, json: async () => ({}) };
      };
    },
  });
  await new Promise((r) => setTimeout(r, 1500));
}, 60_000);
afterAll(() => dom?.window?.close());

function box(name: string) {
  const row = [...dom.window.document.querySelectorAll(".feat-row")].find(
    (r) => (r as HTMLElement).dataset.featName === name,
  );
  const el = row?.querySelector(".feat-test262-paths");
  return {
    row,
    el,
    label: el?.querySelector(".feat-test262-paths-label")?.textContent,
    links: [...(el?.querySelectorAll("a") ?? [])] as HTMLAnchorElement[],
    more: el?.querySelector(".feat-test262-paths-more") as HTMLButtonElement | null,
  };
}

describe("#4362 compact test262 source list", () => {
  it("factors the shared directory into the label", () => {
    expect(box(OPERATORS_ROW).label).toBe("test262 language/expressions/");
  });

  it("renders at most 6 links, with the rest behind +N", () => {
    const b = box(OPERATORS_ROW);
    expect(b.links).toHaveLength(MANY_PATHS.length);
    expect(b.links.filter((a) => !a.hidden)).toHaveLength(6);
    expect(b.more?.textContent).toBe("+4");
  });

  it("strips the prefix from link text but keeps the full path addressable", () => {
    const b = box(OPERATORS_ROW);
    expect(b.links[0].textContent).toBe("addition");
    // Nothing is lost: href and tooltip still carry the full path.
    expect(b.links[0].title).toBe("language/expressions/addition");
    expect(b.links[0].getAttribute("href")).toBe(
      "https://github.com/tc39/test262/tree/main/test/language/expressions/addition",
    );
  });

  it("+N expands without collapsing the row it sits in", () => {
    const b = box(OPERATORS_ROW);
    const detailsOpenBefore = b.row?.querySelector("details")?.hasAttribute("open");
    b.more!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    expect(b.links.filter((a) => !a.hidden)).toHaveLength(MANY_PATHS.length);
    // The row toggles <details> on click, so the button must stop propagation
    // — otherwise expanding the list collapses the row that contains it.
    expect(b.row?.querySelector("details")?.hasAttribute("open")).toBe(detailsOpenBefore);
  });

  it("leaves a single-path row alone (no prefix, no +N)", () => {
    const b = box("JSON");
    expect(b.label).toBe("test262");
    expect(b.links[0].textContent).toBe("built-ins/JSON");
    expect(b.more).toBeNull();
  });
});
