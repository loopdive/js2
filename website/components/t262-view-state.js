/**
 * Shared ?mode= / ?edition= / gated ?ir URL state for the two conformance surfaces
 * (website/index.html and website/public/benchmarks/report.html).
 *
 * Both pages share the JS-host/standalone lane and ES edition scope. The IR
 * toggle is available only when the URL contains ?ir; ?ir=1 selects it.
 * Links carry these choices:
 *
 *   /?mode=standalone&edition=ES2015
 *   /benchmarks/report.html?mode=standalone&edition=ES2020
 *
 * Loaded as a plain (non-module) script so page inline scripts can call it
 * synchronously; it attaches `window.t262ViewState`.
 *
 * The edition value is whatever scope string the <t262-edition-timeline>
 * itself uses ("overall", "overall+proposal", "ES2015", "ES3 / Core", …), so a
 * URL round-trips exactly. Callers MUST validate an incoming edition against
 * the timeline's own scope map before applying it — an unknown scope would
 * otherwise leave the slider showing a selection nothing else honours.
 */
(function attachT262ViewState(global) {
  const MODE_PARAM = "mode";
  const EDITION_PARAM = "edition";
  const IR_PARAM = "ir";
  const VALID_MODES = new Set(["host", "standalone"]);

  const params = () => {
    try {
      return new URLSearchParams(global.location?.search || "");
    } catch {
      return new URLSearchParams("");
    }
  };

  /** Reads the URL knobs. Missing/invalid values come back as null, never a guess. */
  const read = () => {
    const search = params();
    const rawMode = (search.get(MODE_PARAM) || "").trim().toLowerCase();
    const rawEdition = (search.get(EDITION_PARAM) || "").trim();
    return {
      mode: VALID_MODES.has(rawMode) ? rawMode : null,
      edition: rawEdition || null,
      irAvailable: search.has(IR_PARAM),
      ir: search.has(IR_PARAM) && search.get(IR_PARAM) === "1",
    };
  };

  /**
   * Writes the knobs back with replaceState — the page's own toggles are not
   * navigation, so they must not stack history entries the Back button then
   * has to unwind one edition at a time.
   *
   * `mode: "standalone"` and `edition: "overall"` are the DEFAULTS on both
   * pages and are dropped from the URL rather than written out, so the common
   * case stays a clean link and a shared URL only ever names what differs. The
   * mode default follows the pages: standalone (pure Wasm) is the lane both
   * surfaces open on, so `?mode=host` is the explicit opt-in.
   */
  const write = ({ mode, edition, ir } = {}) => {
    const search = params();
    if (mode === "host") search.set(MODE_PARAM, "host");
    else if (mode === "standalone") search.delete(MODE_PARAM);

    if (typeof edition === "string" && edition && edition !== "overall") search.set(EDITION_PARAM, edition);
    else if (edition === "overall" || edition === null) search.delete(EDITION_PARAM);

    if (search.has(IR_PARAM) && typeof ir === "boolean") search.set(IR_PARAM, ir ? "1" : "");

    const query = search.toString();
    const next = `${global.location.pathname}${query ? `?${query}` : ""}${global.location.hash || ""}`;
    try {
      global.history.replaceState(global.history.state, "", next);
    } catch {
      // Non-browser / sandboxed context (file:// in some engines) — the knobs
      // still work, they just don't survive a reload.
    }
  };

  /**
   * Builds a link to the OTHER conformance surface carrying this view — both
   * pages read the same params, so following the link keeps the lane, edition
   * and gated IR selection the reader is looking at. Defaults are dropped, same as write().
   */
  const linkTo = (href, { mode, edition, ir } = {}) => {
    const hashIndex = href.indexOf("#");
    const hash = hashIndex < 0 ? "" : href.slice(hashIndex);
    const withoutHash = hashIndex < 0 ? href : href.slice(0, hashIndex);
    const queryIndex = withoutHash.indexOf("?");
    const pathname = queryIndex < 0 ? withoutHash : withoutHash.slice(0, queryIndex);
    const search = new URLSearchParams(queryIndex < 0 ? "" : withoutHash.slice(queryIndex + 1));
    if (mode === "host") search.set(MODE_PARAM, "host");
    else if (mode === "standalone") search.delete(MODE_PARAM);
    if (typeof edition === "string" && edition && edition !== "overall") search.set(EDITION_PARAM, edition);
    else if (edition === "overall" || edition === null) search.delete(EDITION_PARAM);
    const view = read();
    if (view.irAvailable) search.set(IR_PARAM, (ir ?? view.ir) ? "1" : "");
    const query = search.toString();
    return `${pathname}${query ? `?${query}` : ""}${hash}`;
  };

  // IR artifacts never share the historical URLs or their remote fallbacks.
  const dataUrl = (href) => {
    if (!read().ir) return href;
    const url = new URL(href, global.document?.baseURI || global.location.href);
    if (url.origin !== global.location.origin) throw new Error("IR data has no historical remote fallback");
    const basename = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    if (basename === "test262-report.json" || basename === "test262-standalone-report.json") {
      url.pathname = url.pathname.replace(/-report\.json$/, "-ir-report.json");
    } else if (!url.pathname.includes("/results/ir/")) {
      if (!url.pathname.includes("/results/")) throw new Error("IR data requires a separate results artifact");
      url.pathname = url.pathname.replace("/results/", "/results/ir/");
    }
    return url.href;
  };

  const measuredIrData = (data) =>
    data?.compilerPath === "ir" && data.compilerPathVerified === true && data.executionCompilerPath === "ir";

  const readData = (data, field) => {
    if (!read().ir) return data;
    if (!measuredIrData(data)) throw new Error("IR data is unmeasured or unavailable");
    if (!field) return data;
    if (!Object.prototype.hasOwnProperty.call(data, field)) throw new Error("IR data envelope is incomplete");
    return data[field];
  };

  const fetchData = async (href, field) => {
    const response = await global.fetch(dataUrl(href));
    if (!response.ok) throw new Error("Conformance data unavailable");
    return readData(await response.json(), field);
  };

  const bindIrToggle = (label) => {
    if (!label) return;
    const view = read();
    label.hidden = !view.irAvailable;
    label.style.display = view.irAvailable ? "" : "none";
    const input = label.querySelector("input");
    if (!input || !view.irAvailable) return;
    input.checked = view.ir;
    input.addEventListener("change", () => {
      write({ ir: input.checked });
      // A fresh document keeps historical in-flight hydration out of the IR view.
      global.location.reload();
    });
  };

  const irStatus = async (base, mode) => {
    const filename = mode === "host" ? "test262-ir-status.json" : "test262-standalone-ir-status.json";
    try {
      const response = await global.fetch(`${base.replace(/\/$/, "")}/${filename}`);
      if (!response.ok) return null;
      const status = await response.json();
      return status?.schema === "test262-compiler-path-status-v1" &&
        status.compilerPath === "ir" &&
        status.state === "unavailable" &&
        typeof status.reason === "string"
        ? status.reason
        : null;
    } catch {
      return null;
    }
  };

  global.t262ViewState = { read, write, linkTo, dataUrl, measuredIrData, readData, fetchData, bindIrToggle, irStatus };
})(typeof window !== "undefined" ? window : globalThis);
