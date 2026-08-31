#!/usr/bin/env node
//
// mathjax-daemon.mjs
//
// A long-running MathJax daemon for the latex-preview.nvim plugin. Reads
// newline-delimited JSON requests from stdin and writes newline-delimited
// JSON responses to stdout. Loads MathJax once at startup (~1.3s) so
// per-request cost drops to ~10-50ms — enough for inline live preview
// as the user types.
//
// Protocol (one JSON object per line, both directions):
//
//   request:   {"id": <any>, "preamble": "<tex>", "equation": "<tex>",
//               "display": false, "color": "000000"}
//   response:  {"id": <echoed>, "ok": true,  "svg": "<svg>...</svg>"}
//          or  {"id": <echoed>, "ok": false, "err": "..."}
//
// A request may also ask the daemon to rasterize, skipping the spawn of an
// external rsvg-convert per render:
//
//   request:   {..., "png": {"path": "/tmp/x.png", "density": 300,
//                            "cell_width": 10, "cell_height": 21}}
//   response:  {"id": <echoed>, "ok": true, "png": "/tmp/x.png",
//               "width": 170, "height": 84}
//
// This needs @resvg/resvg-js. The ready line advertises whether it resolved
// ({"ready": true, "resvg": true}) so the plugin knows whether to ask.
// rsvg-convert startup costs ~18.5ms per render against ~0.8ms of actual
// rasterization; in-process resvg removes that overhead and the intermediate
// SVG file with it.
//
// Errors during preamble parsing are swallowed line-by-line (Overleaf
// pattern) so that \RequirePackage / \DeclareOption / \makeatletter inside
// a .sty file don't kill the render. Errors on the actual equation
// propagate so the plugin can surface them.
//
// One-shot mode (for ad-hoc use and tests):
//   mathjax-daemon.mjs --in FILE --out FILE.svg [--display] [--color HEX]
//
// Requires:  npm i -g @mathjax/src@4   (or local install — auto-detected)
// Optional:  npm i @resvg/resvg-js     (in the plugin dir; enables "png")
//

import { argv, exit, stderr, stdin, stdout } from "node:process";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";

function parseArgs(a) {
  const o = { display: false, color: "000000", daemon: false, listPaths: false };
  for (let i = 2; i < a.length; i++) {
    const k = a[i];
    if (k === "--in") o.input = a[++i];
    else if (k === "--out") o.output = a[++i];
    else if (k === "--display") o.display = true;
    else if (k === "--color") o.color = a[++i];
    else if (k === "--ex") o.ex = parseFloat(a[++i]);
    else if (k === "--daemon") o.daemon = true;
    else if (k === "--list-paths") o.listPaths = true;
    else if (k === "--resvg-status") o.resvgStatus = true;
  }
  return o;
}

// ---------------------------------------------------------------------------
// Canonical @mathjax/src candidate path list. The Lua side (health.lua)
// invokes this script with --list-paths to read this list rather than
// duplicating it — keep the resolution logic in exactly one place.
// ---------------------------------------------------------------------------
async function buildCandidatePaths({ includeNpm = true } = {}) {
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const seen = new Set();
  const candidates = [];
  const add = (p) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    candidates.push(p);
  };

  add(process.env.LATEX_PREVIEW_MATHJAX_PATH);
  add(process.env.SNACKS_MATHJAX_PATH);
  add(path.join(here, "node_modules", "@mathjax", "src"));
  add(path.join(here, "..", "node_modules", "@mathjax", "src"));
  add(path.join(process.cwd(), "node_modules", "@mathjax", "src"));
  for (const p of [
    "/usr/lib/node_modules/@mathjax/src",
    "/usr/local/lib/node_modules/@mathjax/src",
    "/opt/homebrew/lib/node_modules/@mathjax/src",
    "/opt/local/lib/node_modules/@mathjax/src",
    path.join(process.env.HOME || "", ".npm-global/lib/node_modules/@mathjax/src"),
    path.join(process.env.HOME || "",
      ".nvm/versions/node/" + process.version + "/lib/node_modules/@mathjax/src"),
  ]) add(p);
  if (includeNpm) {
    try {
      const npmRoot = execFileSync("npm", ["root", "-g"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      add(path.join(npmRoot, "@mathjax", "src"));
    } catch (_) {
      // npm is optional; explicit env/local/hardcoded paths may still work.
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// MathJax bootstrap. Resolved once at startup and kept in module scope so
// the daemon loop can reuse the loaded modules across thousands of requests.
// ---------------------------------------------------------------------------
const TEX_PACKAGES = [
  "base",
  "action",
  "ams",
  "amscd",
  "bbm",
  "bboldx",
  "bbox",
  "begingroup",
  "boldsymbol",
  "braket",
  "bussproofs",
  "cancel",
  "cases",
  "centernot",
  "color",
  "colortbl",
  "configmacros",
  "dsfont",
  "empheq",
  "enclose",
  "extpfeil",
  "gensymb",
  "html",
  "mathtools",
  "mhchem",
  "newcommand",
  "setoptions",
  "tagformat",
  "texhtml",
  "textcomp",
  "textmacros",
  "unicode",
  "units",
  "upgreek",
  "verb",
];

const TEX_PACKAGE_EXCLUDES = new Set([
  // Strict rendering needs actual errors rather than red merror output.
  "noerrors",
  "noundefined",
  // These rely on MathJax's component loader. We import packages directly.
  "autoload",
  "require",
  // Keep the LaTeX-compatible color package as the default.
  "colorv2",
  // This redefines common macros like \sin and \div, so don't enable it globally.
  "physics",
]);

function readPackageInfo(fsSync, path, dir) {
  try {
    return JSON.parse(fsSync.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch (_) {
    return null;
  }
}

function isMathJax4Source(info) {
  return info && info.name === "@mathjax/src" && /^4\./.test(String(info.version || ""));
}

async function loadTexPackages(mjPath, u, fsSync, path) {
  const packages = [];
  const add = (name) => {
    if (!name || TEX_PACKAGE_EXCLUDES.has(name) || packages.includes(name)) return;
    packages.push(name);
  };
  for (const name of TEX_PACKAGES) add(name);

  const texDir = path.join(mjPath, "mjs", "input", "tex");
  try {
    for (const entry of fsSync.readdirSync(texDir, { withFileTypes: true })) {
      if (entry.isDirectory()) add(entry.name);
    }
  } catch (_) {
    // The imports below will report a concrete failure if the package layout is invalid.
  }

  for (const name of packages) {
    const dir = path.join(texDir, name);
    const files = fsSync.existsSync(dir)
      ? fsSync.readdirSync(dir).filter((file) => /Configuration\.js$/.test(file)).sort()
      : [];
    for (const file of files) {
      await import(u(path.join("input", "tex", name, file)));
    }
  }
  return packages;
}

async function bootMathJax() {
  const path = await import("node:path");
  const fsSync = await import("node:fs");
  const { pathToFileURL } = await import("node:url");

  // First pass: try cheap candidates only. `npm root -g` adds 100+ms of
  // process spawn even when the answer is going to be a path we already
  // checked — defer it until the obvious locations have all missed.
  const findIn = (cands) => {
    for (const c of cands) {
      if (!c || !fsSync.existsSync(path.join(c, "package.json"))) continue;
      const info = readPackageInfo(fsSync, path, c);
      if (isMathJax4Source(info)) return { path: c, info };
    }
    return null;
  };
  let candidates = await buildCandidatePaths({ includeNpm: false });
  let found = findIn(candidates);
  if (!found) {
    candidates = await buildCandidatePaths({ includeNpm: true });
    found = findIn(candidates);
  }
  if (!found) {
    stderr.write(
      "latex-preview/mathjax-daemon: @mathjax/src@4 not found. Install with:\n" +
      "  npm install -g @mathjax/src@4\n" +
      "Or set LATEX_PREVIEW_MATHJAX_PATH to its install dir.\n" +
      "Checked:\n" +
      candidates.map((p) => "  " + p).join("\n") +
      "\n"
    );
    exit(1);
  }

  const mjPath = found.path;
  const u = (sub) => pathToFileURL(path.join(mjPath, "mjs", sub)).href;
  await import(u("util/asyncLoad/esm.js"));
  const { mathjax }             = await import(u("mathjax.js"));
  const { TeX }                 = await import(u("input/tex.js"));
  const { SVG }                 = await import(u("output/svg.js"));
  const { liteAdaptor }         = await import(u("adaptors/liteAdaptor.js"));
  const { RegisterHTMLHandler } = await import(u("handlers/html.js"));
  const packages = await loadTexPackages(mjPath, u, fsSync, path);

  // RegisterHTMLHandler installs a global handler against an adaptor. We
  // create a single "boot adaptor" here just to register; per-request work
  // creates fresh adaptors so macros from request N don't leak into N+1.
  const bootAdaptor = liteAdaptor();
  RegisterHTMLHandler(bootAdaptor);

  return { mathjax, TeX, SVG, liteAdaptor, packages };
}

let MJ = null; // populated by bootMathJax()

// ---------------------------------------------------------------------------
// Rasterizer bootstrap. Optional: when @resvg/resvg-js is missing the daemon
// still answers with SVG and the plugin falls back to spawning rsvg-convert.
// ---------------------------------------------------------------------------
let RESVG = null; // the Resvg class, or null when unavailable

async function bootResvg() {
  // A bare specifier resolves for a local install, because Node walks up from
  // this file to <plugin>/node_modules. A global install is not on that path,
  // so fall back to the same explicit locations we check for MathJax.
  try {
    return (await import("@resvg/resvg-js")).Resvg;
  } catch (_) {
    // fall through to the explicit paths
  }
  const path = await import("node:path");
  const fsSync = await import("node:fs");
  const { pathToFileURL } = await import("node:url");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));

  const candidates = [
    process.env.LATEX_PREVIEW_RESVG_PATH,
    path.join(here, "node_modules", "@resvg", "resvg-js"),
    path.join(here, "..", "node_modules", "@resvg", "resvg-js"),
    path.join(process.cwd(), "node_modules", "@resvg", "resvg-js"),
    "/usr/lib/node_modules/@resvg/resvg-js",
    "/usr/local/lib/node_modules/@resvg/resvg-js",
    "/opt/homebrew/lib/node_modules/@resvg/resvg-js",
    "/opt/local/lib/node_modules/@resvg/resvg-js",
    path.join(process.env.HOME || "", ".npm-global/lib/node_modules/@resvg/resvg-js"),
    path.join(process.env.HOME || "",
      ".nvm/versions/node/" + process.version + "/lib/node_modules/@resvg/resvg-js"),
  ];
  for (const c of candidates) {
    if (!c || !fsSync.existsSync(path.join(c, "package.json"))) continue;
    try {
      const mod = await import(pathToFileURL(path.join(c, "index.js")).href);
      if (mod && mod.Resvg) return mod.Resvg;
    } catch (_) {
      // try the next candidate
    }
  }
  return null;
}

/// Rasterize a MathJax SVG, padding the output up to whole terminal cells.
///
/// The padding is expressed as an outer SVG rather than applied to the bitmap
/// afterwards, so it costs nothing: one render produces the final image. The
/// geometry deliberately mirrors what render.lua asked rsvg-convert for via
/// --page-width/--page-height/--left/--top, and was verified to produce
/// byte-identical dimensions and a visually identical result.
function rasterize(svgStr, { density, cellWidth, cellHeight }) {
  const zoom = (Number(density) > 0 ? Number(density) : 96) / 96;
  const m = svgStr.match(/width="([\d.]+)px"\s+height="([\d.]+)px"/);

  let source = svgStr;
  let fitTo = { mode: "zoom", value: zoom };
  if (m) {
    // rsvg-convert's output is exactly ceil(intrinsic * zoom); match it so the
    // two backends stay interchangeable.
    const outW = Math.max(1, Math.ceil(Number(m[1]) * zoom));
    const outH = Math.max(1, Math.ceil(Number(m[2]) * zoom));
    const cw = Number(cellWidth) > 0 ? Number(cellWidth) : 0;
    const chh = Number(cellHeight) > 0 ? Number(cellHeight) : 0;
    const pageW = cw ? Math.max(1, Math.ceil(outW / cw) * cw) : outW;
    const pageH = chh ? Math.max(1, Math.ceil(outH / chh) * chh) : outH;
    // Floor division matches ImageMagick's `-gravity center -extent`, which is
    // what the original two-pass path produced.
    const left = Math.floor((pageW - outW) / 2);
    const top = Math.floor((pageH - outH) / 2);
    // An <?xml?> prolog is only legal at the very start of a document.
    const inner = svgStr.replace(/^<\?xml[^>]*\?>\s*/, "");
    source =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${pageW}" height="${pageH}" ` +
      `viewBox="0 0 ${pageW} ${pageH}">` +
      `<g transform="translate(${left},${top}) scale(${zoom})">${inner}</g></svg>`;
    fitTo = { mode: "original" };
  }

  // loadSystemFonts defaults to true and makes every instance scan the system
  // font database — seconds per render on macOS. MathJax's SVG output is pure
  // <path> data with no <text>, so there is no font to look up.
  const r = new RESVG(source, { fitTo, font: { loadSystemFonts: false } });
  const img = r.render();
  return { png: img.asPng(), width: img.width, height: img.height };
}

function splitPreambleBlocks(preamble) {
  const blocks = [];
  let block = [];
  let depth = 0;
  let started = false;

  const update = (line) => {
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "\\") {
        i++;
      } else if (c === "{") {
        depth++;
        started = true;
      } else if (c === "}") {
        depth--;
      }
    }
  };

  const flush = () => {
    const text = block.join("\n").trim();
    if (text) blocks.push(text);
    block = [];
    depth = 0;
    started = false;
  };

  for (const raw of preamble.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("%")) {
      if (block.length) flush();
      continue;
    }
    block.push(raw);
    update(line.replace(/(?<!\\)%.*/, ""));
    if (started && depth <= 0) flush();
    else if (!started && /^\\(?:let|newcounter)\b/.test(line)) flush();
  }
  if (block.length) flush();
  return blocks;
}

function normalizeEquation(equation, display, displayMathStyle) {
  if (!equation) return equation;
  let math = equation.replace(/\\label\s*\{[^{}]*\}/g, "").trim();
  const style = display && displayMathStyle === "text" ? "\\textstyle " : "";
  if (!display || !math.includes("\n")) return style + math;
  if (/\\begin\s*\{(?:aligned|alignedat|align\*?|alignat\*?|split|gathered|gather\*?|multline\*?|equation\*?|eqnarray\*?|flalign\*?|matrix|pmatrix|bmatrix|cases)\}/.test(math)) {
    return style + math;
  }
  const lines = math
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\\(?:notag|nonumber)\b/.test(line));
  return style + (lines.join(" ") || math.replace(/\s+/g, " "));
}

// ---------------------------------------------------------------------------
// Render one equation.
//
// Constructing the MathJax pipeline (adaptor + TeX + SVG + document) costs
// ~28ms, against ~1.8ms to actually typeset an equation — measured with the
// phase timings below. Doing it per request made the daemon 15x slower than it
// needed to be for the common case, which is the same buffer being re-rendered
// on every keystroke.
//
// The pipeline is therefore cached, keyed by the preamble. That is the right
// invalidation granularity: the preamble is the only per-request input that
// mutates the pipeline, because converting it registers the buffer's macros
// into the TeX jax. Editing a \newcommand still takes effect immediately, it
// just builds a new pipeline instead of reusing one.
// ---------------------------------------------------------------------------

// Phase timings from the most recent renderOne, in ms. Returned to the caller
// only when a request sets "debug": true, so profiling a live session does not
// need a patched daemon.
export const PHASES = { setup: 0, preamble: 0, equation: 0, serialize: 0 };

const PIPELINES = new Map(); // preamble -> { html, uses }

// Bound both how many buffers' pipelines are held and how long any one is
// reused. MathJax documents accumulate their converted math items, so a
// pipeline reused forever is a slow leak; rebuilding costs 28ms once per
// MAX_USES renders, which is noise spread across that many keystrokes.
const MAX_PIPELINES = 8;
const MAX_USES = 500;

async function buildPipeline(preamble, opts) {
  const { mathjax, TeX, SVG, liteAdaptor, packages } = MJ;
  const adaptor = liteAdaptor();
  const tex = new TeX({
    packages,
    macros: {
      // LaTeX's bm package defines \bm. MathJax has \boldsymbol, so provide
      // the common alias explicitly for notes that use \usepackage{bm}.
      bm: ["\\boldsymbol{#1}", 1],
    },
    formatError: (jax, err) => { throw err; },
  });
  const svg = new SVG({
    // "none" rather than "local": with a cached document, "local" would let
    // the second render assume glyph <defs> emitted by the first are still
    // present in its output and omit them, producing an SVG whose <use>
    // references dangle. Inlining the paths keeps every render self-contained,
    // which is required anyway since each one is rasterized on its own.
    fontCache: "none",
    linebreaks: { inline: false },
  });
  const html = mathjax.document("", { InputJax: tex, OutputJax: svg });

  // Register macros from the preamble. MathJax's `html.convert` takes raw math
  // content (no \(...\) or \[...\] delimiters) and processes it in math mode;
  // the `newcommand` package handles bare \newcommand / \def / \let /
  // \DeclareMathOperator definitions in math mode with no wrapping needed. We
  // pass everything as one string first, then on error fall back to per-line
  // parsing so a single bad line doesn't lose all the good ones.
  if (preamble && preamble.trim()) {
    try {
      await html.convertPromise(preamble, opts);
    } catch {
      for (const block of splitPreambleBlocks(preamble)) {
        try { await html.convertPromise(block, opts); } catch { /* swallow */ }
      }
    }
  }
  return { html, adaptor, uses: 0 };
}

// An equation that defines macros would mutate the pipeline it renders on, and
// those definitions would then be visible to later equations sharing the same
// preamble — state the old build-per-request code could not carry. Such a
// request gets a throwaway pipeline instead, so it still sees its own
// definitions and nothing else does.
const DEFINES_MACROS =
  /\\(?:re|provide)?newcommand\b|\\(?:g|x|e)?def\b|\\let\b|\\DeclareMathOperator\b|\\newenvironment\b/;

async function getPipeline(preamble, opts, equation) {
  if (equation && DEFINES_MACROS.test(equation)) {
    return { entry: await buildPipeline(preamble, opts), fresh: true };
  }
  const key = preamble || "";
  const hit = PIPELINES.get(key);
  if (hit && hit.uses < MAX_USES) {
    hit.uses++;
    // Refresh LRU position.
    PIPELINES.delete(key);
    PIPELINES.set(key, hit);
    return { entry: hit, fresh: false };
  }
  const entry = await buildPipeline(preamble, opts);
  entry.uses = 1;
  PIPELINES.delete(key);
  PIPELINES.set(key, entry);
  while (PIPELINES.size > MAX_PIPELINES) {
    PIPELINES.delete(PIPELINES.keys().next().value);
  }
  return { entry, fresh: true };
}

async function renderOne({ preamble, equation, display, color, font_size, display_math_style, ex }) {
  if (!MJ) throw new Error("mathjax not booted");
  const mark = () => Number(process.hrtime.bigint()) / 1e6;
  let t = mark();

  const em = Number(font_size) > 0 ? Number(font_size) : 11;
  const opts = { display: false, em, ex: ex || em / 2, containerWidth: 1280 };

  const { entry, fresh } = await getPipeline(preamble, opts, equation);
  const { html, adaptor } = entry;
  // Building the pipeline includes the preamble pass, so on a miss the two are
  // reported together under `setup` and `preamble` reads 0.
  PHASES.setup = fresh ? mark() - t : 0;
  PHASES.preamble = 0;
  t = mark();

  // Render the equation. The caller passes math content WITHOUT delimiters
  // (the plugin strips them upstream), and `display` says whether to render
  // inline or display style. Errors here are caller-visible — the plugin
  // surfaces ok=false as a notification; no automatic fallback.
  const math = normalizeEquation(equation, !!display, display_math_style);
  const out = await html.convertPromise(math, { ...opts, display: !!display });
  PHASES.equation = mark() - t; t = mark();
  // Use MathJax's XML serializer when available: MathJax 4 stamps every node
  // with a `data-latex` attribute holding its raw TeX, so `a < b` yields
  // data-latex="<". The HTML serializer (innerHTML) leaves </>/& unescaped in
  // attribute values — valid HTML but invalid XML — and librsvg's strict XML
  // parser (used by rsvg-convert downstream) rejects the file. serializeXML
  // escapes them (data-latex="&lt;") and declares xmlns:xlink.
  let svgStr = typeof adaptor.serializeXML === "function"
    ? adaptor.serializeXML(out)
    : adaptor.innerHTML(out);
  const m = svgStr.match(/<svg[\s\S]*<\/svg>/);
  if (m) svgStr = m[0];
  const viewBox = svgStr.match(/viewBox="([^"]+)"/);
  if (viewBox) {
    const nums = viewBox[1].trim().split(/\s+/).map(Number);
    if (nums.length === 4 && nums.every(Number.isFinite)) {
      const widthPx = Math.max(1, (nums[2] / 1000) * em);
      const heightPx = Math.max(1, (nums[3] / 1000) * em);
      svgStr = svgStr
        .replace(/\swidth="[^"]*"/, ` width="${widthPx.toFixed(3)}px"`)
        .replace(/\sheight="[^"]*"/, ` height="${heightPx.toFixed(3)}px"`);
    }
  }
  if (color && color !== "currentColor") {
    svgStr = svgStr.replace(/<svg\b/, `<svg fill="#${color}" color="#${color}"`);
    svgStr = svgStr.replace(/currentColor/g, `#${color}`);
  }
  if (!svgStr.startsWith("<?xml")) {
    svgStr = '<?xml version="1.0" encoding="UTF-8"?>\n' + svgStr;
  }
  PHASES.serialize = mark() - t;
  return svgStr;
}

// ---------------------------------------------------------------------------
// Daemon mode. Newline-delimited JSON in / out.
// ---------------------------------------------------------------------------
async function runDaemon() {
  // Pre-warm so the first real request is fast.
  MJ = await bootMathJax();
  RESVG = await bootResvg();
  // Signal readiness to the parent. Snacks waits for this line before
  // dispatching queued requests. `resvg` tells the plugin whether it can ask
  // for PNGs directly instead of spawning a rasterizer per render.
  stdout.write(JSON.stringify({ ready: true, resvg: RESVG !== null }) + "\n");

  const rl = createInterface({ input: stdin, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch (e) {
      stdout.write(JSON.stringify({ ok: false, err: "bad json: " + e.message }) + "\n");
      continue;
    }
    if (req.quit) { exit(0); }
    try {
      const t0 = process.hrtime.bigint();
      const svg = await renderOne(req);
      const t1 = process.hrtime.bigint();
      const phases = req.debug ? { phases: { ...PHASES } } : null;
      if (req.png && req.png.path && RESVG) {
        // Write the PNG here rather than shipping it back over the pipe: the
        // plugin hands snacks a file path anyway, and this keeps the response
        // line small. The SVG is not returned either — nothing downstream
        // reads it once the daemon has rasterized.
        const { png, width, height } = rasterize(svg, {
          density: req.png.density,
          cellWidth: req.png.cell_width,
          cellHeight: req.png.cell_height,
        });
        const t2 = process.hrtime.bigint();
        await fs.writeFile(req.png.path, png);
        const t3 = process.hrtime.bigint();
        // Per-stage cost, so a slow round trip can be attributed instead of
        // guessed at. Rasterizing here shares one thread with the typeset
        // above, which is exactly what makes this path queue up under load.
        stdout.write(JSON.stringify({
          id: req.id, ok: true, png: req.png.path, width, height,
          ms_typeset: Number(t1 - t0) / 1e6,
          ms_raster: Number(t2 - t1) / 1e6,
          ms_write: Number(t3 - t2) / 1e6,
          ...phases,
        }) + "\n");
      } else {
        stdout.write(JSON.stringify({
          id: req.id, ok: true, svg,
          ms_typeset: Number(t1 - t0) / 1e6,
          ...phases,
        }) + "\n");
      }
    } catch (e) {
      stdout.write(JSON.stringify({
        id: req.id,
        ok: false,
        err: (e && e.message) ? e.message : String(e),
      }) + "\n");
    }
  }
}

// ---------------------------------------------------------------------------
// One-shot mode. Useful for tests and as an emergency fallback if the daemon
// pipe is wedged on the plugin side.
// ---------------------------------------------------------------------------
async function runOneShot(opts) {
  if (!opts.input || !opts.output) {
    stderr.write("usage: mathjax-daemon.mjs --in FILE --out FILE.svg [--display] [--color HEX]\n");
    stderr.write("  or:  mathjax-daemon.mjs --daemon  (stdin/stdout JSON protocol)\n");
    exit(2);
  }
  MJ = await bootMathJax();
  const raw = await fs.readFile(opts.input, "utf8");
  const SPLIT = /^%%% SNACKS-MATHJAX-SPLIT %%%\s*$/m;
  // Strip the leading "%% latex-preview: ..." (or "%% snacks-mathjax: ...")
  // metadata header if present. The plugin doesn't use one-shot mode, but
  // we accept either prefix so users who installed manually with old
  // intermediate files still get correct behavior.
  const noMeta = raw.replace(/^%%\s*(latex-preview|snacks-mathjax):[^\n]*\n/, "");
  const m = noMeta.split(SPLIT);
  const preamble = (m[0] || "").trim();
  const equation = (m[1] || m[0] || "").trim();
  const svg = await renderOne({
    preamble, equation,
    display: opts.display, color: opts.color, ex: opts.ex,
  });
  await fs.writeFile(opts.output, svg, "utf8");
}

// ---------------------------------------------------------------------------
// Path-listing mode. Used by health.lua to read the canonical candidate
// list without having to mirror the resolution logic in Lua.
// ---------------------------------------------------------------------------
async function listPaths() {
  const candidates = await buildCandidatePaths({ includeNpm: true });
  for (const c of candidates) stdout.write(c + "\n");
}

// Reports whether the optional in-process rasterizer resolves, so health.lua
// does not have to mirror the resolution logic in Lua. Same reason
// --list-paths exists for @mathjax/src.
async function resvgStatus() {
  stdout.write(((await bootResvg()) ? "ok" : "missing") + "\n");
}

async function main() {
  const opts = parseArgs(argv);
  if (opts.resvgStatus) return resvgStatus();
  if (opts.listPaths) return listPaths();
  if (opts.daemon) return runDaemon();
  return runOneShot(opts);
}

main().catch((e) => {
  stderr.write("mathjax-daemon fatal: " + (e && e.stack ? e.stack : String(e)) + "\n");
  exit(1);
});
