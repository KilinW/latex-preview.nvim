// Regression spec for the cached MathJax pipeline.
//
// renderOne used to build adaptor + TeX + SVG + document per request, which
// cost ~28ms against ~1.8ms of actual typesetting. The pipeline is now cached
// per preamble. That is only safe if reuse is invisible in the output, so this
// spec pins the properties that could break:
//
//   1. Repeated renders through one cached pipeline are byte-identical to the
//      first. This is what fontCache: "local" would have broken — the second
//      render would omit glyph <defs> it believed were already emitted, and
//      the SVG's <use> references would dangle.
//   2. Editing the preamble takes effect immediately (a new pipeline), and
//      redefining a macro changes the output.
//   3. Preambles do not leak into each other.
//   4. Rendering with no preamble after one with macros leaves the macros
//      undefined, rather than silently inheriting them.
//
// Run locally:
//   node tests/daemon_pipeline_spec.mjs

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "mathjax-daemon.mjs");

let failures = 0;
const ok = (name) => console.log("ok   " + name);
const fail = (name, detail) => {
  failures++;
  console.log("FAIL " + name + (detail ? "\n       " + detail : ""));
};
const check = (cond, name, detail) => (cond ? ok(name) : fail(name, detail));

const p = spawn("node", [SCRIPT, "--daemon"], { stdio: ["pipe", "pipe", "ignore"] });
const rl = createInterface({ input: p.stdout, terminal: false });
const waiters = new Map();
let readyResolve;
const ready = new Promise((r) => (readyResolve = r));
rl.on("line", (l) => {
  let m;
  try { m = JSON.parse(l); } catch { return; }
  if (m.ready) return readyResolve();
  const w = waiters.get(m.id);
  if (w) { waiters.delete(m.id); w(m); }
});
let id = 0;
const send = (req) => new Promise((res) => {
  const myId = id++;
  waiters.set(myId, res);
  p.stdin.write(JSON.stringify({ ...req, id: myId }) + "\n");
});

const base = { display: true, color: "000000", font_size: 12, display_math_style: "display" };
const render = (preamble, equation) => send({ ...base, preamble, equation });

await ready;

// 1. Reuse must be invisible.
{
  const EQ = "\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2} + \\sum_{n=1}^{\\infty}\\frac{1}{n^2}";
  const first = await render("", EQ);
  let identical = true;
  let differed = null;
  for (let i = 0; i < 10; i++) {
    const r = await render("", EQ);
    if (r.svg !== first.svg) { identical = false; differed = i; break; }
  }
  check(first.ok && identical, "repeated renders through a cached pipeline are identical",
    differed !== null ? `render #${differed} differed from the first` : undefined);

  // A dangling <use> is the specific corruption fontCache: "local" would cause.
  const ids = new Set([...first.svg.matchAll(/<path[^>]*\sid="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...first.svg.matchAll(/xlink:href="#([^"]+)"|(?<!xlink:)href="#([^"]+)"/g)]
    .map((m) => m[1] || m[2]).filter(Boolean);
  const dangling = refs.filter((r) => !ids.has(r));
  check(dangling.length === 0, "no <use> references a glyph the SVG does not define",
    dangling.length ? `dangling: ${dangling.slice(0, 3).join(", ")}` : undefined);
}

// 2. Editing the preamble invalidates.
{
  const a = await render("\\newcommand{\\foo}{\\alpha}", "\\foo");
  const b = await render("\\newcommand{\\foo}{\\beta}", "\\foo");
  check(a.ok && b.ok && a.svg !== b.svg,
    "redefining a macro in the preamble changes the output");

  // And the first definition still renders the same when we go back to it,
  // i.e. the two pipelines coexist rather than clobbering one another.
  const a2 = await render("\\newcommand{\\foo}{\\alpha}", "\\foo");
  check(a2.ok && a2.svg === a.svg, "switching back to an earlier preamble reproduces its output");
}

// 3. No cross-preamble leakage.
{
  const withMacro = await render("\\newcommand{\\onlyhere}{\\gamma}", "\\onlyhere");
  check(withMacro.ok, "a macro defined in the preamble is usable");
  const without = await render("", "\\onlyhere");
  check(!without.ok, "the same macro is undefined under a different preamble",
    without.ok ? "it rendered instead of erroring, so state leaked" : undefined);
}

// 4. An equation is not allowed to poison later renders with the same preamble.
{
  const PRE = "\\newcommand{\\base}{x}";
  await render(PRE, "\\newcommand{\\sneaky}{y} \\base");
  const after = await render(PRE, "\\sneaky");
  check(!after.ok, "a \\newcommand inside an equation does not persist to the next render",
    after.ok ? "the definition survived into a later request" : undefined);
}

p.stdin.write(JSON.stringify({ quit: true }) + "\n");
console.log(failures === 0 ? "\nall pipeline cache cases passed" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
