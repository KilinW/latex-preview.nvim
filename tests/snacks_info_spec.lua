-- Spec for the snacks.image metadata sidecar.
--
-- snacks shells out to `magick identify` for every image it is handed, to learn
-- its dimensions. Profiled in a live editing session that was 116 spawns
-- averaging 160.9ms — far more than the render it was describing. snacks skips
-- any conversion step whose output file already exists, so latex-preview writes
-- that file itself.
--
-- The whole thing rests on reproducing snacks' cache naming, so this asserts
-- against real snacks rather than against our own idea of it:
--
--   1. the path we write is the path snacks looks for
--   2. snacks spawns no subprocess when it is present
--   3. the dimensions snacks ends up with are the image's real ones
--   4. it stays out of the way when snacks is not usable
--
-- Run locally:
--   nvim --headless -u NONE -l tests/snacks_info_spec.lua

local uv = vim.uv or vim.loop

local failures = 0
local function check(cond, name, detail)
  if cond then
    print("ok   " .. name)
  else
    failures = failures + 1
    print("FAIL " .. name .. (detail and ("\n       " .. detail) or ""))
  end
end

local snacks_dir = vim.fn.expand("~/.local/share/nvim/lazy/snacks.nvim")
if vim.fn.isdirectory(snacks_dir) == 0 then
  print("skip: snacks.nvim not installed at " .. snacks_dir)
  vim.cmd("qa")
  return
end
vim.opt.rtp:append(snacks_dir)
vim.opt.rtp:append(vim.fn.getcwd())
package.path = "./lua/?.lua;./lua/?/init.lua;" .. package.path

require("snacks").setup({ image = { enabled = true } })
local conv = require("snacks.image.convert")
local cache = require("snacks").image.config.cache

-- Count every subprocess, whoever starts it.
local spawned = {}
local orig_spawn = uv.spawn
uv.spawn = function(cmd, o, cb)
  spawned[#spawned + 1] = vim.fn.fnamemodify(tostring(cmd), ":t")
  return orig_spawn(cmd, o, cb)
end

-- A real PNG to describe. 3x2 solid pixels is enough; only the header matters.
local png = vim.fn.tempname() .. ".png"
do
  local magick = vim.fn.executable("magick") == 1 and "magick"
    or (vim.fn.executable("convert") == 1 and "convert" or nil)
  if not magick then
    print("skip: needs ImageMagick to produce a fixture and a baseline")
    vim.cmd("qa")
    return
  end
  vim.fn.system({ magick, "-size", "37x21", "xc:red", png })
end

-- Stub the daemon before render.lua captures it, so the cache-path assertions
-- below do not need a real MathJax install.
local daemon_calls = 0
package.loaded["latex-preview.daemon"] = {
  has_resvg = function() return false end,
  render = function(_, cb)
    daemon_calls = daemon_calls + 1
    vim.schedule(function() cb(nil, "<svg></svg>") end)
  end,
}

local render = require("latex-preview.render")

local function run_convert(label)
  spawned = {}
  local done, result = false, nil
  local c = conv.convert({ src = png, on_done = function(cv) result = cv; done = true end })
  c:run()
  vim.wait(10000, function() return done end, 20)
  return spawned, result
end

-- Baseline: without the sidecar, snacks must shell out. If this ever stops
-- being true the optimisation is pointless and the rest of the spec is
-- meaningless, so assert it rather than assume it.
vim.fn.delete(cache, "rf")
local before = run_convert()
check(#before > 0, "baseline: snacks spawns a process when no sidecar exists",
  "spawned nothing, so there is nothing to save")

-- With the sidecar in place.
vim.fn.delete(cache, "rf")
render._write_snacks_info(png)

local src, page = conv.get_page(png)
src = conv.norm(src)
local base = vim.fn.fnamemodify(src, ":t:r"):gsub("[^%w%.]+", "-")
local expected = cache .. "/" .. vim.fn.sha256(src .. page):sub(1, 8) .. "-" .. base .. ".png.info"
check(uv.fs_stat(expected) ~= nil, "the sidecar lands where snacks looks for it", expected)

local after, converted = run_convert()
check(#after == 0, "snacks spawns nothing when the sidecar exists",
  #after > 0 and ("still spawned: " .. table.concat(after, ", ")) or nil)

local info = converted and converted.meta and converted.meta.info
check(info ~= nil, "snacks still ends up with image metadata")
if info then
  check(info.size.width == 37 and info.size.height == 21,
    "the metadata snacks reads back is the image's real size",
    ("got %sx%s, expected 37x21"):format(info.size.width, info.size.height))
end

-- Must be inert rather than throwing when snacks is unavailable.
local saved = package.loaded["snacks"]
package.loaded["snacks"] = nil
local ok = pcall(render._write_snacks_info, png)
package.loaded["snacks"] = saved
check(ok, "writing the sidecar is a no-op when snacks cannot be loaded")

-- Reusing a cached PNG returns without going through finish(), so it needs its
-- own sidecar write. This was missed the first time round: the sidecar landed
-- for fresh renders only, and reuse is the common case while editing, so
-- `magick` kept being spawned and the optimisation looked like it did nothing.
do
  -- A stand-in rasterizer that copies the fixture to wherever it is told to
  -- write. The real one would be handed "<svg></svg>" by the daemon stub and
  -- fail, and a fake emitting junk would not survive png_size().
  local fake_bin = vim.fn.tempname()
  vim.fn.mkdir(fake_bin, "p")
  local fd = assert(io.open(fake_bin .. "/magick", "w"))
  fd:write("#!/bin/sh\nout=\"\"\nfor arg do out=\"$arg\"; done\ncp '" .. png .. "' \"$out\"\n")
  fd:close()
  uv.fs_chmod(fake_bin .. "/magick", 493)
  local saved_path = vim.env.PATH
  vim.env.PATH = fake_bin .. ":" .. (saved_path or "")

  local config = require("latex-preview.config")
  config.setup({
    cache = false,
    render = { fg = "#000000", pad_to_cells = false, density = 300, svg_to_png = "magick" },
    snacks = { max_cache_files = 0, max_cache_bytes = 0, cache_grace_ms = 0 },
  })
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_set_current_buf(buf)

  local function render_once(eq)
    local done, path = false, nil
    render.render({ preamble = "", equation = eq, buf = buf, live = true, live_id = eq },
      function(_, p) path = p; done = true end)
    vim.wait(10000, function() return done end, 20)
    return path
  end

  local function info_for(p)
    local s, pg = conv.get_page(p)
    s = conv.norm(s)
    local b = vim.fn.fnamemodify(s, ":t:r"):gsub("[^%w%.]+", "-")
    return cache .. "/" .. vim.fn.sha256(s .. pg):sub(1, 8) .. "-" .. b .. ".png.info"
  end

  local first = render_once("x + y")
  check(first ~= nil and uv.fs_stat(info_for(first)) ~= nil,
    "a fresh render writes the sidecar")

  -- Delete only the sidecar. The PNG stays, so the next call is a cache hit and
  -- must notice the metadata is gone: snacks trims its cache independently.
  if first then os.remove(info_for(first)) end
  local calls_before = daemon_calls
  local second = render_once("x + y")
  check(second == first and daemon_calls == calls_before,
    "the second render really was a cache hit",
    ("path %s, daemon calls %d -> %d"):format(tostring(second == first), calls_before, daemon_calls))
  check(second ~= nil and uv.fs_stat(info_for(second)) ~= nil,
    "a cache hit rewrites the sidecar when it has gone missing")

  vim.env.PATH = saved_path
end

vim.fn.delete(png)
print(failures == 0 and "\nall snacks sidecar cases passed" or ("\n" .. failures .. " failure(s)"))
vim.cmd(failures == 0 and "qa" or "cq")
