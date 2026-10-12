import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const source = readFileSync(resolve(import.meta.dirname, "../website/components/t262-view-state.js"), "utf8");
function page(query = "", hash = "") {
  let url = new URL(`https://website.test/project/${query}${hash}`);
  const requests = [];
  let reloads = 0;
  const location = {
    get href() {
      return url.href;
    },
    get origin() {
      return url.origin;
    },
    get search() {
      return url.search;
    },
    get pathname() {
      return url.pathname;
    },
    get hash() {
      return url.hash;
    },
    reload() {
      reloads++;
    },
  };
  const window = {
    location,
    document: { baseURI: "https://website.test/project/" },
    history: {
      state: { preserved: true },
      replaceState(_state, _unused, next) {
        url = new URL(next, url);
      },
    },
    fetch: async (href) => {
      requests.push(href);
      return { ok: true, json: async () => ({ compilerPath: "ir", compilerPathVerified: false }) };
    },
  };
  vm.runInNewContext(source, { window, URL, URLSearchParams });
  return { state: window.t262ViewState, window, requests, href: () => url.href, reloads: () => reloads };
}
function label() {
  const handlers = new Map();
  const input = { checked: false, addEventListener: (event, handler) => handlers.set(event, handler) };
  return { hidden: true, style: { display: "none" }, querySelector: () => input, input, handlers };
}

describe("URL-gated website IR data selection", () => {
  it("uses parameter presence for visibility, including bare and combined ?ir", () => {
    for (const query of ["?ir", "?ir&mode=host", "?ir=0", "?ir=1"]) {
      const view = page(query);
      const toggle = label();
      view.state.bindIrToggle(toggle);
      assert.equal(toggle.hidden, false);
      assert.equal(toggle.input.checked, query === "?ir=1");
    }
    const view = page("?mode=host&edition=ES2015");
    const toggle = label();
    view.state.bindIrToggle(toggle);
    assert.equal(toggle.hidden, true);
    assert.equal(toggle.style.display, "none");
    assert.equal(toggle.handlers.size, 0);
    view.state.write({ ir: true });
    assert.equal(new URL(view.href()).searchParams.has("ir"), false);
  });

  it("keeps lane, edition, unrelated query and hash when toggling and reloading", () => {
    const view = page("?ir&mode=host&edition=ES2015&keep=yes", "#language");
    const toggle = label();
    view.state.bindIrToggle(toggle);
    toggle.input.checked = true;
    toggle.handlers.get("change")();
    const selected = new URL(view.href());
    assert.equal(selected.searchParams.get("ir"), "1");
    assert.equal(selected.searchParams.get("mode"), "host");
    assert.equal(selected.searchParams.get("edition"), "ES2015");
    assert.equal(selected.searchParams.get("keep"), "yes");
    assert.equal(selected.hash, "#language");
    assert.equal(view.reloads(), 1);
    view.state.write({ ir: false });
    assert.equal(new URL(view.href()).searchParams.has("ir"), true);
    assert.equal(view.state.read().ir, false);
  });

  it("round-trips IR and destination query/hash between the two surfaces", () => {
    const view = page("?ir=1");
    const link = view.state.linkTo("./benchmarks/report.html?keep=yes#errors", { mode: "host", edition: "ES2020" });
    const next = new URL(link, view.href());
    assert.equal(next.searchParams.get("ir"), "1");
    assert.equal(next.searchParams.get("mode"), "host");
    assert.equal(next.searchParams.get("edition"), "ES2020");
    assert.equal(next.searchParams.get("keep"), "yes");
    assert.equal(next.hash, "#errors");
  });

  it("leaves historical URLs and unlabelled payloads unchanged when IR is off", () => {
    const view = page("?ir");
    const historical = [{ edition: "ES2015" }];
    assert.equal(
      view.state.dataUrl("./benchmarks/results/test262-report.json"),
      "./benchmarks/results/test262-report.json",
    );
    assert.equal(view.state.readData(historical, "editions"), historical);
    assert.equal(
      view.state.linkTo("./benchmarks/report.html", { mode: "standalone", edition: "overall" }),
      "./benchmarks/report.html?ir=",
    );
  });

  it("routes reports, editions and history only to isolated IR artifacts", () => {
    const view = page("?ir=1");
    assert.equal(
      view.state.dataUrl("./benchmarks/results/test262-report.json"),
      "https://website.test/project/benchmarks/results/test262-ir-report.json",
    );
    assert.equal(
      view.state.dataUrl("./benchmarks/results/test262-standalone-report.json"),
      "https://website.test/project/benchmarks/results/test262-standalone-ir-report.json",
    );
    assert.equal(
      view.state.dataUrl("./benchmarks/results/test262-editions.json"),
      "https://website.test/project/benchmarks/results/ir/test262-editions.json",
    );
    assert.equal(
      view.state.dataUrl("./benchmarks/results/runs/index.json"),
      "https://website.test/project/benchmarks/results/ir/runs/index.json",
    );
    assert.throws(() => view.state.dataUrl("https://raw.githubusercontent.com/legacy/report.json"));
  });

  it("refuses unlabelled, request-only, unknown-execution and incomplete IR envelopes", () => {
    const view = page("?ir=1");
    for (const payload of [
      { summary: {} },
      { compilerPath: "ir" },
      { compilerPath: "ir", compilerPathVerified: false, executionCompilerPath: "ir" },
      { compilerPath: "ir", compilerPathVerified: true, executionCompilerPath: "unknown" },
    ]) {
      assert.throws(() => view.state.readData(payload));
    }
    const metadata = { compilerPath: "ir", compilerPathVerified: true, executionCompilerPath: "ir" };
    assert.throws(() => view.state.readData(metadata, "editions"));
    // Format-only control: no scores or genuine compiler execution are represented by this empty envelope.
    const envelope = { ...metadata, editions: [] };
    assert.equal(view.state.readData(envelope, "editions"), envelope.editions);
  });

  it("rejects request-only fetch data without reading historical report URLs", async () => {
    const view = page("?ir=1");
    await assert.rejects(view.state.fetchData("./benchmarks/results/test262-report.json"));
    assert.deepEqual(view.requests, ["https://website.test/project/benchmarks/results/test262-ir-report.json"]);
  });

  it("reads a separate unavailable status without creating measured data", async () => {
    const view = page("?ir=1");
    view.window.fetch = async (href) => {
      view.requests.push(href);
      return {
        ok: true,
        json: async () => ({
          schema: "test262-compiler-path-status-v1",
          compilerPath: "ir",
          compilerPathVerified: false,
          executionCompilerPath: "unknown",
          state: "unavailable",
          reason: "IR-only compiler API unavailable",
        }),
      };
    };
    assert.equal(await view.state.irStatus("./benchmarks/results", "standalone"), "IR-only compiler API unavailable");
    assert.deepEqual(view.requests, ["./benchmarks/results/test262-standalone-ir-status.json"]);
  });
});

it("keeps historical measurement detail out of IR without removing source links", () => {
  const html = readFileSync(resolve(import.meta.dirname, "../website/index.html"), "utf8");
  const start = html.indexOf("// Measurement details have no IR dataset contract yet.");
  const end = html.indexOf('if (!details.querySelector(".feat-test262-paths"))', start);
  assert.ok(start >= 0 && end > start, "actual landing measurement-link branch is present");
  const branch = html.slice(start, end);
  const node = (tag = "div") => ({
    tag,
    className: "",
    children: [],
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
    },
    querySelector(selector) {
      return (
        this.children.find((child) =>
          selector.startsWith(".") ? child.className === selector.slice(1) : child.tag === selector,
        ) ?? null
      );
    },
    remove() {
      this.parent.children = this.parent.children.filter((child) => child !== this);
    },
  });
  const details = node();
  const sources = node();
  sources.className = "feat-test262-paths";
  details.appendChild(sources);
  const existing = node();
  existing.className = "feat-report-link";
  details.appendChild(existing);
  const context = {
    details,
    paths: ["language/functions"],
    pass: 2,
    total: 3,
    document: { createElement: node },
    IR_SELECTED: true,
  };
  vm.runInNewContext(branch, context);
  assert.equal(details.querySelector(".feat-report-link"), null);
  assert.equal(details.querySelector(".feat-test262-paths"), sources);
  vm.runInNewContext(branch, context);
  assert.equal(details.children.length, 1);
  context.IR_SELECTED = false;
  vm.runInNewContext(branch, context);
  const link = details.querySelector(".feat-report-link").querySelector("a");
  assert.equal(link.href, "./benchmarks/feature-report.html?feature=language%2Ffunctions");
  assert.equal(link.textContent, "View test results (2/3) →");
  assert.equal(details.querySelector(".feat-test262-paths"), sources);
});
