/**
 * Shared ?mode= / ?edition= / ?ir URL state for the two conformance surfaces
 * (website/index.html and website/public/benchmarks/report.html).
 *
 * Both pages share the JS-host/standalone lane, ES edition scope and compiler
 * path. The IR view is the default (#7537); `?ir=0` (or `?ir=`) selects the
 * legacy view. Links carry these choices:
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

  /**
   * Reads the URL knobs. Missing/invalid mode and edition come back as null,
   * never a guess. The JS-host lane was retired without an IR measurement, so
   * `mode=host` is always the legacy view.
   */
  const read = () => {
    const search = params();
    const rawMode = (search.get(MODE_PARAM) || "").trim().toLowerCase();
    const rawEdition = (search.get(EDITION_PARAM) || "").trim();
    const mode = VALID_MODES.has(rawMode) ? rawMode : null;
    return {
      mode,
      edition: rawEdition || null,
      ir: mode !== "host" && (!search.has(IR_PARAM) || search.get(IR_PARAM) === "1"),
    };
  };

  // Defaults (standalone, overall, IR) are dropped so a shared URL only names what differs.
  const applyKnobs = (search, { mode, edition, ir }) => {
    if (mode === "host") search.set(MODE_PARAM, "host");
    else if (mode === "standalone") search.delete(MODE_PARAM);

    if (typeof edition === "string" && edition && edition !== "overall") search.set(EDITION_PARAM, edition);
    else if (edition === "overall" || edition === null) search.delete(EDITION_PARAM);

    if (ir === true) search.delete(IR_PARAM);
    else if (ir === false) search.set(IR_PARAM, "0");
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
   * surfaces open on, so `?mode=host` is the explicit opt-in. The IR view is
   * the default too, so only the legacy view writes `ir=0`.
   */
  const write = (knobs = {}) => {
    const search = params();
    applyKnobs(search, knobs);
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
   * and compiler path the reader is looking at. Defaults are dropped, same as write().
   */
  const linkTo = (href, { mode, edition, ir } = {}) => {
    const hashIndex = href.indexOf("#");
    const hash = hashIndex < 0 ? "" : href.slice(hashIndex);
    const withoutHash = hashIndex < 0 ? href : href.slice(0, hashIndex);
    const queryIndex = withoutHash.indexOf("?");
    const pathname = queryIndex < 0 ? withoutHash : withoutHash.slice(0, queryIndex);
    const search = new URLSearchParams(queryIndex < 0 ? "" : withoutHash.slice(queryIndex + 1));
    applyKnobs(search, { mode, edition, ir: ir ?? read().ir });
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

  const measuredIrData = (data, target) => {
    if (data?.compilerPath !== "ir" || data.requestedCompilerPath !== "ir" || data.measurementState !== "measured")
      return false;
    if (target && data.mode?.target !== target) return false;
    const counts = [
      "attemptedCases",
      "completedCases",
      "skippedCases",
      "compileErrorCases",
      "compileTimeoutCases",
      "verifiedExecutionCases",
      "unverifiedExecutionCases",
    ];
    if (!counts.every((key) => Number.isSafeInteger(data[key]) && data[key] >= 0)) return false;
    const nonSkipped = data.completedCases - data.skippedCases;
    if (
      data.attemptedCases <= 0 ||
      nonSkipped <= 0 ||
      data.verifiedExecutionCases + data.unverifiedExecutionCases !== nonSkipped ||
      data.compileErrorCases + data.compileTimeoutCases > data.unverifiedExecutionCases
    )
      return false;
    if (data.compilerPathVerified === true)
      return (
        data.executionCompilerPath === "ir" && data.verifiedExecutionCases > 0 && data.unverifiedExecutionCases === 0
      );
    return data.compilerPathVerified === false && ["unknown", "mixed"].includes(data.executionCompilerPath);
  };

  const readData = (data, field, target) => {
    if (!read().ir) return data;
    if (!measuredIrData(data, target))
      throw new Error("IR data is unmeasured, unavailable or belongs to another runtime");
    if (!field) return data;
    if (!Object.prototype.hasOwnProperty.call(data, field)) throw new Error("IR data envelope is incomplete");
    return data[field];
  };

  const fetchData = async (href, field) => {
    const response = await global.fetch(dataUrl(href));
    if (!response.ok) throw new Error("Conformance data unavailable");
    const pathname = new URL(href, global.location.href).pathname;
    // The category and per-file edition maps classify test files by frontmatter,
    // so one measured lane's copy serves both; every other artifact is one lane's.
    const target = /test262-(category|file)-editions\.json$/.test(pathname)
      ? undefined
      : pathname.includes("standalone")
        ? "standalone"
        : "gc";
    return readData(await response.json(), field, target);
  };

  const bindIrToggle = (label) => {
    if (!label) return;
    label.hidden = false;
    label.style.display = "";
    const input = label.querySelector("input");
    if (!input) return;
    input.checked = read().ir;
    input.addEventListener("change", () => {
      write({ ir: input.checked });
      // A fresh document keeps historical in-flight hydration out of the IR view.
      global.location.reload();
    });
  };

  const irMeasurementLabel = (data, mode) => {
    const target = mode === "standalone" ? "standalone" : "gc";
    if (!measuredIrData(data, target)) return "IR requested · " + mode + " · unmeasured";
    return (
      "IR requested · " +
      mode +
      " · measured " +
      data.completedCases +
      " cases / " +
      data.attemptedCases +
      " compiler attempts · verified IR executions " +
      data.verifiedExecutionCases +
      " · unverified cases " +
      data.unverifiedExecutionCases +
      " · source " +
      (data.baseline_sha || "unknown") +
      " · " +
      (data.timestamp || "date unknown")
    );
  };

  const historicalHostLabel = (data) =>
    "Historical JS Host · retired 2026-10-12 · frozen results · source " +
    (data?.baseline_sha || "unknown") +
    " · " +
    (data?.baseline_generated_at || data?.timestamp || "date unknown");

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

  // The view this document was rendered for. A later write({ mode: "host" })
  // changes read() but not what the page already loaded.
  const documentIr = read().ir;

  /**
   * read() runs before the status file can arrive, so the IR view is chosen
   * first and an unavailable IR measurement is resolved here: an IR document
   * reloads as the legacy view (a fresh document, as for the toggle), and a
   * legacy document shows the reason above its numbers.
   */
  const applyIrStatus = async (base, mode, node) => {
    const reason = await irStatus(base, mode);
    if (!reason) return;
    if (documentIr) {
      // Navigate to the legacy URL itself: a reload after write() would loop
      // forever if replaceState is unavailable and the URL kept the IR view.
      const { pathname, search, hash } = global.location;
      global.location.replace(linkTo(`${pathname}${search}${hash}`, { ir: false }));
      return;
    }
    node.textContent = reason;
    node.hidden = false;
  };

  global.t262ViewState = {
    read,
    write,
    linkTo,
    dataUrl,
    measuredIrData,
    readData,
    fetchData,
    bindIrToggle,
    irMeasurementLabel,
    historicalHostLabel,
    irStatus,
    applyIrStatus,
  };
})(typeof window !== "undefined" ? window : globalThis);
