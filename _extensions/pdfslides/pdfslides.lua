-- pdfslides: embed a PDF slide deck with a PDF.js-based player.
--
--   {{< pdfslides lecture3.pdf >}}
--   {{< pdfslides /slides/lecture3.pdf start=4 title="Lecture 3" download=false >}}
--
-- Defaults can be set in document/project metadata:
--
--   pdfslides:
--     download: false

local VERSION = "1.1.0"
-- Options that may also come from `pdfslides:` metadata (not `id`: it must be unique).
local OPTIONS = { "start", "title", "aspect", "download", "hash", "max-width" }

local counter = 0
local used_ids = {}
local dependency_added = false
local embed_warned = false

local function str(v)
  if v == nil then return nil end
  local s = pandoc.utils.stringify(v)
  if s == "" then return nil end
  return s
end

local function truthy(v, default)
  if v == nil then return default end
  v = v:lower()
  return not (v == "false" or v == "no" or v == "0" or v == "off")
end

local function escape_attr(s)
  return (s:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;")
    :gsub('"', "&quot;"):gsub("'", "&#39;"))
end

-- Percent-encode characters that break URLs (spaces, #, ?, quotes, non-ASCII)
-- while leaving existing %XX escapes and path separators alone.
local function encode_path(s)
  return (s:gsub("[^%w%-%._~/%%!$&()*+,;=:@]", function(c)
    return string.format("%%%02X", string.byte(c))
  end))
end

local function is_url(s)
  return s:match("^%a[%w+.-]*:") ~= nil or s:sub(1, 2) == "//"
end

-- Turn the authored path into the URL used by the deployed page.
-- Site-absolute paths ("/slides/x.pdf") are made relative to the page using the
-- project offset so they also work when the site is served from a sub-path.
-- Outside a project the document's directory acts as the root.
local function resolve_src(src)
  if is_url(src) then return src end
  local path, suffix = src:match("^([^?#]*)(.*)$") -- keep ?query / #fragment as-is
  if path:sub(1, 1) == "/" then
    local offset = quarto.project and quarto.project.offset
    if offset and offset ~= "" then
      path = offset .. path
    else
      path = path:gsub("^/+", "")
    end
  end
  return encode_path(path) .. suffix
end

local function valid_css_length(s)
  return s:match("^%d*%.?%d+%a*%%?$") ~= nil
end

local function unique_id(explicit)
  if explicit then
    if used_ids[explicit] then
      quarto.log.warning("pdfslides: duplicate id '" .. explicit .. "'; slide links will be ambiguous")
    end
    used_ids[explicit] = true
    return explicit
  end
  local id
  repeat
    counter = counter + 1
    id = "pdfslides-" .. counter
  until not used_ids[id]
  used_ids[id] = true
  return id
end

local function parse_aspect(s)
  if not s then return nil end
  local w, h = s:match("^%s*([%d.]+)%s*[/:x]%s*([%d.]+)%s*$")
  if w then
    w, h = tonumber(w), tonumber(h)
    if w and h and w > 0 and h > 0 then return w .. " / " .. h end
  end
  local r = tonumber(s)
  if r and r > 0 then return tostring(r) end
  quarto.log.warning("pdfslides: ignoring invalid aspect '" .. s .. "'")
  return nil
end

local function json_string(s)
  return '"' .. s:gsub('[%c"\\]', function(c)
    if c == '"' then return '\\"' end
    if c == "\\" then return "\\\\" end
    return string.format("\\u%04x", string.byte(c))
  end) .. '"'
end

-- sections="Intro: 1; Part 2: Methods: 8" -> JSON [{"title":..,"page":..}], sorted.
-- The page number follows the last colon, so titles may contain colons.
local function parse_sections(s)
  local out = {}
  for part in (s .. ";"):gmatch("([^;]*);") do
    part = part:match("^%s*(.-)%s*$")
    if part ~= "" then
      local title, page = part:match("^(.-)%s*:%s*(%d+)$")
      if title and title ~= "" and tonumber(page) >= 1 then
        table.insert(out, { title = title, page = tonumber(page) })
      else
        quarto.log.warning("pdfslides: ignoring section '" .. part .. "' (expected 'Title: page')")
      end
    end
  end
  table.sort(out, function(a, b) return a.page < b.page end)
  if #out == 0 then return nil end
  local items = {}
  for _, it in ipairs(out) do
    table.insert(items, '{"title":' .. json_string(it.title) .. ',"page":' .. it.page .. "}")
  end
  return "[" .. table.concat(items, ",") .. "]"
end

local function list_files(dir, prefix, out)
  for _, name in ipairs(pandoc.system.list_directory(dir)) do
    local full = pandoc.path.join({ dir, name })
    local rel = prefix .. name
    -- list_directory on a regular file errors; use that to tell files from dirs.
    local ok = pcall(pandoc.system.list_directory, full)
    if ok then
      list_files(full, rel .. "/", out)
    else
      table.insert(out, rel)
    end
  end
  return out
end

local function add_dependency()
  if dependency_added then return end
  dependency_added = true
  local here = pandoc.path.directory(PANDOC_SCRIPT_FILE)
  local resources = {}
  for _, rel in ipairs(list_files(pandoc.path.join({ here, "pdfjs" }), "pdfjs/", {})) do
    table.insert(resources, { name = rel, path = rel })
  end
  quarto.doc.add_html_dependency({
    name = "pdfslides",
    version = VERSION,
    scripts = { { path = "pdfslides.js", afterBody = true } },
    stylesheets = { "pdfslides.css" },
    resources = resources,
  })
end

local function warn_if_embedded(meta)
  if embed_warned then return end
  local embed = meta and (meta["embed-resources"] or meta["self-contained"])
  if embed and str(embed) ~= "false" then
    embed_warned = true
    quarto.log.warning("pdfslides: embed-resources is not supported; the player " ..
      "loads PDF.js and the PDF at runtime, so only a link will work offline.")
  end
end

local function options(kwargs, meta)
  local defaults = meta and meta["pdfslides"]
  local opts = {}
  for _, key in ipairs(OPTIONS) do
    local v = str(kwargs[key])
    if v == nil and type(defaults) == "table" then v = str(defaults[key]) end
    opts[key] = v
  end
  return opts
end

return {
  ["pdfslides"] = function(args, kwargs, meta)
    local src = str(args[1]) or str(kwargs["file"])
    if not src then
      quarto.log.error("pdfslides: missing PDF path, e.g. {{< pdfslides lecture.pdf >}}")
      return pandoc.Strong(pandoc.Str("pdfslides: missing PDF path"))
    end
    local opts = options(kwargs, meta)
    local url = resolve_src(src)
    local label = opts.title or "Slides (PDF)"

    if not quarto.doc.is_format("html") then
      return pandoc.Link(label, url)
    end

    add_dependency()
    warn_if_embedded(meta)

    local id = unique_id(str(kwargs["id"]))
    local start = tonumber(opts.start or "1")
    if not start or start < 1 then start = 1 end
    local style = {}
    local aspect = parse_aspect(opts.aspect)
    if aspect then table.insert(style, "--pdfslides-aspect: " .. aspect) end
    local max_width = opts["max-width"]
    if max_width and valid_css_length(max_width) then
      table.insert(style, "max-width: " .. max_width)
    elseif max_width then
      quarto.log.warning("pdfslides: ignoring invalid max-width '" .. max_width .. "'")
    end

    local attrs = {
      'class="pdfslides"',
      'id="' .. escape_attr(id) .. '"',
      'data-src="' .. escape_attr(url) .. '"',
      'data-start="' .. math.floor(start) .. '"',
      'data-download="' .. tostring(truthy(opts.download, true)) .. '"',
      'data-hash="' .. tostring(truthy(opts.hash, true)) .. '"',
      'role="region"',
      'aria-label="' .. escape_attr(opts.title or "Slides") .. '"',
    }
    if opts.title then table.insert(attrs, 'data-title="' .. escape_attr(opts.title) .. '"') end
    local sections = str(kwargs["sections"])
    sections = sections and parse_sections(sections)
    if sections then table.insert(attrs, 'data-sections="' .. escape_attr(sections) .. '"') end
    if #style > 0 then table.insert(attrs, 'style="' .. escape_attr(table.concat(style, "; ")) .. '"') end

    -- The fallback link is shown when JavaScript is off, and its href lets
    -- Quarto's resource discovery copy the PDF into the output directory.
    local html = "<div " .. table.concat(attrs, " ") .. ">" ..
      '<a class="pdfslides-fallback" href="' .. escape_attr(url) .. '">' ..
      escape_attr(label) .. "</a></div>"
    return pandoc.RawBlock("html", html)
  end,

  -- {{< slidelink 12 >}}                         -> "slide 12", jumps the first deck
  -- {{< slidelink 3 deck=week2 text="the proof" >}} -> a specific deck on this page
  -- {{< slidelink 5 page=lecture3.qmd >}}        -> a deck on another page
  ["slidelink"] = function(args, kwargs)
    local n = tonumber(str(args[1]) or "")
    if not n or n < 1 then
      quarto.log.warning("pdfslides: slidelink needs a slide number, e.g. {{< slidelink 12 >}}")
      return pandoc.Strong(pandoc.Str("slidelink: missing slide number"))
    end
    n = math.floor(n)
    local deck = str(kwargs["deck"])
    local page = str(kwargs["page"])
    local text = str(kwargs["text"]) or ("slide " .. n)
    if not quarto.doc.is_format("html") then
      return pandoc.Str(text)
    end
    local fragment = "#" .. (deck and (encode_path(deck) .. "/") or "/") .. n
    if not page then
      return pandoc.Link(text, fragment, "", pandoc.Attr("", { "pdfslides-slidelink" }))
    end
    -- Map source pages to their HTML output ourselves and emit raw HTML: Quarto's
    -- link resolution mangles "#/3" fragments (turns "/" into "\" on Windows).
    local href = resolve_src(page):gsub("%.qmd$", ".html"):gsub("%.ipynb$", ".html")
      :gsub("%.[Rr]md$", ".html"):gsub("%.md$", ".html")
    return pandoc.RawInline("html", '<a href="' .. escape_attr(href .. fragment) ..
      '" class="pdfslides-slidelink">' .. escape_attr(text) .. "</a>")
  end
}
