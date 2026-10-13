import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { instantiatePlaygroundModule } from "../website/playground/runtime-wiring.js";

// Follow the raw import used by the editor so this test cannot silently keep
// exercising an old example after the playground's default changes.
const playgroundUrl = new URL("../website/playground/main.ts", import.meta.url);
const playgroundSource = readFileSync(playgroundUrl, "utf8");
const defaultImport = playgroundSource.match(/import DEFAULT_SOURCE from "([^"?]+)\?raw";/);
if (!defaultImport) throw new Error("Playground DEFAULT_SOURCE raw import was not found");
const exampleUrl = new URL(defaultImport[1]!, playgroundUrl);
const source = readFileSync(exampleUrl, "utf8");

function domString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("DOM boundary received a non-string value");
  return value;
}

class TestElement {
  readonly children: TestElement[] = [];
  readonly style = { cssText: "", background: "" };
  private text = "";
  private readonly listeners = new Map<string, (() => void)[]>();

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.text;
  }

  set textContent(value: unknown) {
    this.text = domString(value);
  }

  set innerHTML(value: unknown) {
    if (domString(value) !== "") throw new Error("Only clearing innerHTML is supported by this DOM fixture");
    this.children.length = 0;
    this.text = "";
  }

  appendChild(child: unknown): TestElement {
    if (!(child instanceof TestElement)) throw new TypeError("appendChild received a non-element");
    this.children.push(child);
    return child;
  }

  addEventListener(type: unknown, callback: unknown): void {
    const event = domString(type);
    if (typeof callback !== "function") throw new TypeError("addEventListener received a non-function");
    const callbacks = this.listeners.get(event) ?? [];
    callbacks.push(callback as () => void);
    this.listeners.set(event, callbacks);
  }

  dispatch(type: string): void {
    const callbacks = this.listeners.get(type);
    if (!callbacks?.length) throw new Error(`No ${type} listener registered on ${this.tagName}`);
    for (const callback of callbacks) callback();
  }

  listensFor(type: string): boolean {
    return Boolean(this.listeners.get(type)?.length);
  }
}

function price(year: number, month: number, day: number): number {
  return ((((year * 373 + month * 631 + day * 997) & 0x7fffffff) % 18) + 2) * 50;
}

describe("playground default example", () => {
  it("compiles, renders the calendar, and runs its date-selection and navigation callbacks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-15T12:00:00Z"));
    try {
      const result = await compile(source, { fileName: exampleUrl.pathname });
      expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
      expect(result.binary.length).toBeGreaterThan(0);

      const body = new TestElement("body");
      body.appendChild(new TestElement("stale"));
      const document = {
        body,
        createElement: (tag: unknown) => new TestElement(domString(tag)),
      };
      const imports = buildImports(result.imports, { document }, result.stringPool);
      const logs: string[] = [];
      imports.env.console_log_string = (value: unknown) => logs.push(domString(value));
      // Use the same instantiation and instance-association path as Run in the
      // playground; real runtime callback bridges dispatch back into Wasm.
      const { instance } = await instantiatePlaygroundModule(result.binary as BufferSource, imports);
      expect(typeof instance.exports.main).toBe("function");
      (instance.exports.main as () => void)();

      expect(body.children).toHaveLength(1);
      expect(body.style.cssText).toContain("background:#111");
      const wrap = body.children[0]!;
      expect(wrap.children).toHaveLength(7);
      const [header, weekdays, grid, lowerWeekdays, nav, footer, totalFooter] = wrap.children;
      expect(header!.children.map((child) => child.textContent)).toEqual(["Dec", "2026"]);
      const dayNames = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
      expect(weekdays!.children.map((child) => child.textContent)).toEqual(dayNames);
      expect(lowerWeekdays!.children.map((child) => child.textContent)).toEqual(dayNames);
      expect(grid!.children).toHaveLength(35);
      expect(grid!.children.filter((cell) => cell.listensFor("click"))).toHaveLength(31);
      const dayCell = (day: number): TestElement => {
        const cell = grid!.children.find(
          (candidate) => candidate.listensFor("click") && candidate.children[0]?.textContent === String(day),
        );
        if (!cell) throw new Error(`Calendar day ${day} was not rendered`);
        return cell;
      };
      expect(dayCell(15).style.cssText).toContain("background:#7c3aed");
      expect(dayCell(10).children[1]!.textContent).toBe(`${price(2026, 11, 10)} €`);
      dayCell(10).dispatch("mouseenter");
      expect(dayCell(10).style.background).toBe("#222");
      dayCell(10).dispatch("mouseleave");
      expect(dayCell(10).style.background).toBe("transparent");

      const nights = footer!.children[1]!;
      const total = totalFooter!.children[0]!;
      dayCell(10).dispatch("click");
      expect(nights.textContent).toBe("0 nights");
      expect(dayCell(10).style.cssText).toContain("background:#fff");
      dayCell(13).dispatch("click");
      expect(nights.textContent).toBe("3 nights");
      expect(total.textContent).toBe(`${price(2026, 11, 10) + price(2026, 11, 11) + price(2026, 11, 12)} €`);
      expect(dayCell(11).style.cssText).toContain("background:#333");
      totalFooter!.children[1]!.dispatch("click");
      expect(logs).toEqual(["saved 10-13"]);

      footer!.children[0]!.dispatch("click");
      expect(nights.textContent).toBe("0 nights");
      expect(total.textContent).toBe("");
      expect(dayCell(10).style.cssText).toContain("background:transparent");

      dayCell(20).dispatch("click");
      dayCell(18).dispatch("click");
      expect(nights.textContent).toBe("2 nights");
      expect(total.textContent).toBe(`${price(2026, 11, 18) + price(2026, 11, 19)} €`);
      nav!.children[1]!.dispatch("click");
      expect(header!.children.map((child) => child.textContent)).toEqual(["Jan", "2027"]);
      expect(nights.textContent).toBe("0 nights");
      expect(total.textContent).toBe("");
      expect(grid!.children.filter((cell) => cell.listensFor("click"))).toHaveLength(31);
      expect(dayCell(1).children[1]!.textContent).toBe(`${price(2027, 0, 1)} €`);
      nav!.children[0]!.dispatch("click");
      expect(header!.children.map((child) => child.textContent)).toEqual(["Dec", "2026"]);
      expect(dayCell(15).style.cssText).toContain("background:#7c3aed");
    } finally {
      vi.useRealTimers();
    }
  });
});
