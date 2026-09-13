import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

const script = readFileSync(new URL("../website/components/npm-compat-chart.js", import.meta.url), "utf8");
const windows: JSDOM[] = [];
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
});

function mount(requirements: (number | string | null)[] = [3, 5, 2015, 2020, 2026, "ESNext", null, 9999]) {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", pretendToBeVisual: true });
  windows.push(dom);
  dom.window.eval(script);
  const element = dom.window.document.createElement("npm-compat-chart") as HTMLElement & {
    _render: (data: unknown, history: unknown) => void;
  };
  dom.window.document.body.append(element);
  element._render(
    {
      packages: requirements.map((required, index) => ({
        name: `package-${index}`,
        version: "1.0.0",
        entryFile: "index.js",
        compile: { success: index % 2 === 0 },
        validation: { validates: index % 3 === 0 },
        esEdition:
          required == null
            ? undefined
            : { required, requiredLabel: typeof required === "number" ? `ES${required}` : required, scannedFiles: 1 },
      })),
      esEditions: { editions: [{ label: "ES3", count: 1, packages: ["package-0"] }] },
    },
    {},
  );
  const root = element.shadowRoot!;
  const slider = root.querySelector<HTMLInputElement>("#es-edition")!;
  const unknown = root.querySelector<HTMLInputElement>("#es-unknown")!;
  const set = (value: number) => {
    slider.value = String(value);
    slider.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const names = () =>
    [...root.querySelectorAll<HTMLElement>(".card")]
      .filter((card) => !card.hidden)
      .map((card) => card.querySelector(".name")!.textContent);
  return { root, slider, unknown, set, names, dom };
}

describe("npm compatibility edition slider", () => {
  it("starts with all packages, including explicit unknown requirements", () => {
    const page = mount();
    expect(page.names()).toHaveLength(8);
    expect(page.slider.getAttribute("aria-valuetext")).toBe("All editions");
    expect(page.root.querySelectorAll(".badge.edition")).toHaveLength(8);
    expect(page.root.textContent).toContain("ES edition unknown");
    expect(page.root.querySelector(".edition-strip-title")!.textContent).toContain("all packages");
  });

  it("filters cumulatively and keeps ESNext separate from published editions", () => {
    const page = mount();
    page.unknown.checked = false;
    page.set(1); // ES5
    expect(page.names()).toEqual(["package-0", "package-1"]);
    expect([...page.root.querySelectorAll(".metric .value")].map((node) => node.textContent)).toEqual([
      "2",
      "1/2",
      "1/2",
    ]);
    expect(
      [...page.root.querySelectorAll<HTMLElement>(".package-group")]
        .filter((group) => !group.hidden)
        .map((group) => group.querySelector(".group-count")!.textContent),
    ).toEqual(["1 package", "1 package"]);
    page.set(13); // ES2026
    expect(page.names()).toHaveLength(5);
    page.set(14); // ESNext
    expect(page.names()).toHaveLength(6);
    expect(page.slider.getAttribute("aria-valuetext")).toBe("Through ESNext");
    page.set(15); // All
    expect(page.names()).toHaveLength(6);
  });

  it("changes unknown inclusion without losing focus or performance choices", () => {
    const page = mount();
    page.root.querySelector<HTMLButtonElement>('[data-target-value="host"]')!.click();
    page.root.querySelector<HTMLButtonElement>('[data-precompilation-value="on"]')!.click();
    page.slider.focus();
    page.set(0);
    expect(page.names()).toEqual(["package-0", "package-6", "package-7"]);
    page.unknown.checked = false;
    page.unknown.dispatchEvent(new page.dom.window.Event("change"));
    expect(page.names()).toEqual(["package-0"]);
    expect(page.root.querySelector("#es-edition")).toBe(page.slider);
    expect(page.root.activeElement).toBe(page.slider);
    expect(page.root.querySelector<HTMLElement>(".chart-dashboard")!.dataset).toMatchObject({
      target: "host",
      precompilation: "on",
    });
  });

  it("explains empty filtered results and empty reports", () => {
    const page = mount([2020]);
    page.set(0);
    expect(page.names()).toEqual([]);
    expect(page.root.querySelector<HTMLElement>(".edition-empty")!.hidden).toBe(false);
    expect([...page.root.querySelectorAll(".metric .value")].map((node) => node.textContent)).toEqual([
      "0",
      "0/0",
      "0/0",
    ]);
    expect(mount([]).root.querySelector<HTMLElement>(".edition-empty")!.hidden).toBe(false);
  });
});
