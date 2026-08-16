import { JSDOM } from "jsdom";
import { afterAll, describe, expect, it } from "vitest";

const dom = new JSDOM("<!doctype html><body></body>", {
  pretendToBeVisual: true,
  url: "https://js2wasm.test/",
});

const nodeGlobal = globalThis as typeof globalThis & Record<string, unknown>;
const previousGlobals = new Map<string, unknown>();
for (const name of [
  "HTMLElement",
  "customElements",
  "document",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IntersectionObserver",
]) {
  previousGlobals.set(name, nodeGlobal[name]);
}

nodeGlobal.HTMLElement = dom.window.HTMLElement;
nodeGlobal.customElements = dom.window.customElements;
nodeGlobal.document = dom.window.document;
nodeGlobal.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
nodeGlobal.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
nodeGlobal.IntersectionObserver = class {
  constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}

  observe() {
    this.callback([{ isIntersecting: true }]);
  }

  disconnect() {}
};

const chartsReady = import("../website/components/t262-charts.js?donut-zero-count-test");

afterAll(() => {
  dom.window.close();
  for (const [name, value] of previousGlobals) {
    if (value === undefined) {
      delete nodeGlobal[name];
    } else {
      nodeGlobal[name] = value;
    }
  }
});

describe("t262-donut annotations", () => {
  it("omits zero-valued orbit labels and legend entries", async () => {
    await chartsReady;

    const donut = dom.window.document.createElement("t262-donut");
    donut.setAttribute("pass", "95");
    donut.setAttribute("fail", "5");
    donut.setAttribute("ce", "0");
    donut.setAttribute("skip", "0");
    donut.setAttribute("total", "100");
    dom.window.document.body.appendChild(donut);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const labels = [...(donut.shadowRoot?.querySelectorAll(".orbit-label") ?? [])].map((el) => el.textContent);
    const legendItems = [...(donut.shadowRoot?.querySelectorAll(".legend-item") ?? [])].map((el) => el.textContent);

    expect(labels).toEqual(["Passed", "Failed"]);
    expect(legendItems).toHaveLength(2);
    expect(donut.shadowRoot?.textContent).not.toContain("Skipped");
    expect(donut.shadowRoot?.textContent).not.toContain("Compile Errors");

    donut.remove();
  });

  it("keeps colliding annotations on one orbit while separating them", async () => {
    await chartsReady;

    const donut = dom.window.document.createElement("t262-donut");
    donut.setAttribute("pass", "97");
    donut.setAttribute("fail", "1");
    donut.setAttribute("ce", "1");
    donut.setAttribute("skip", "1");
    donut.setAttribute("total", "100");
    dom.window.document.body.appendChild(donut);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const offsets = [...(donut.shadowRoot?.querySelectorAll(".orbit-stat") ?? [])].map((el) => {
      const transform = el.getAttribute("style") ?? "";
      const match = transform.match(/translate\(calc\(-50% \+ ([\d.-]+)px\), calc\(-50% \+ ([\d.-]+)px\)\)/);
      expect(match).not.toBeNull();
      return { x: Number(match?.[1]), y: Number(match?.[2]) };
    });

    expect(offsets).toHaveLength(4);
    for (const { x, y } of offsets) {
      expect(Math.hypot(x, y)).toBeCloseTo(170, 5);
    }

    const distances: number[] = [];
    for (let i = 0; i < offsets.length; i++) {
      for (let j = i + 1; j < offsets.length; j++) {
        distances.push(Math.hypot(offsets[i].x - offsets[j].x, offsets[i].y - offsets[j].y));
      }
    }
    expect(Math.min(...distances)).toBeGreaterThanOrEqual(112 - 0.001);

    donut.remove();
  });
});
