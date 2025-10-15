// netlify/functions/fetchRumors.js
import { JSDOM } from "jsdom";

/**
 * Pull the five most recent HoopsHype Rumors from preview.hoopshype.com
 * for a player/team tag like:
 *   https://preview.hoopshype.com/rumors/tag/jalen_brunson
 *   https://preview.hoopshype.com/rumors/tag/phoenix_suns
 *
 * Query params:
 *   q=Jalen%20Brunson   (required)
 *   mode=player|team|any  (not used for preview tags; we just slugify q)
 *   debug=1               (optional; adds debug info)
 */

const PREVIEW_ORIGIN = "https://preview.hoopshype.com";

function b64(s) {
  return Buffer.from(s).toString("base64");
}

function getAuthHeader() {
  // Preferred: set PREVIEW_BASIC_AUTH env var to "preview:hhpreview" in Netlify.
  const pair = process.env.PREVIEW_BASIC_AUTH || "preview:hhpreview";
  return "Basic " + b64(pair);
}

const UA = {
  headers: {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
    authorization: getAuthHeader(),
  },
};

function toISO(dstr) {
  const d = new Date(dstr);
  return isNaN(d) ? "" : d.toISOString().slice(0, 10);
}
function clean(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}
function sourceFrom(text) {
  const via = /via\s+([A-Z][A-Za-z0-9 .'-]+)/i.exec(text);
  if (via) return via[1].trim();
  const dash = /[-–]\s*([A-Z][A-Za-z0-9 .'-]+)\s*$/i.exec(text.trim());
  if (dash) return dash[1].trim();
  return "HoopsHype";
}

// Basic slugifier to match preview tag format: "New York Knicks" -> "new_york_knicks"
function slugifyTag(q) {
  return clean(q)
    // remove diacritics
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function fetchText(url) {
  const res = await fetch(url, UA);
  if (!res.ok) throw new Error(`Fetch ${res.status} ${url}`);
  return res.text();
}

// Read one tag page and extract article URLs in order
async function readTagPage(slug, pageNo, dbg) {
  const url =
    PREVIEW_ORIGIN +
    `/rumors/tag/${encodeURIComponent(slug)}/` +
    (pageNo > 1 ? `page/${pageNo}/` : "");
  const html = await fetchText(url);
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Tag indexes list articles inside <article> cards
  const links = [];
  for (const a of doc.querySelectorAll("article a")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    // Keep only rumor post permalinks (avoid listing tag root again)
    if (/\/rumors\//.test(href) && !/\/rumors\/tag\//.test(href)) {
      links.push(href);
    }
  }
  dbg[`page${pageNo}Links`] = links.length;
  return links;
}

// Load one article and normalize fields
async function hydrateArticle(url) {
  const html = await fetchText(url);
  const d2 = new JSDOM(html);
  const doc = d2.window.document;

  // Require a timestamp so we only keep proper posts
  const timeEl = doc.querySelector("time[datetime]");
  const dateIso = toISO(timeEl?.getAttribute("datetime") || "");

  const title =
    clean(doc.querySelector("h1, h2")?.textContent || "") || "HoopsHype Rumor";

  const p = doc.querySelector("article p");
  const snippet = clean(p ? p.textContent : title);

  const src = sourceFrom(html) || sourceFrom(title);

  return { title, url, date: dateIso, source: src, snippet };
}

async function getTopFiveFromPreviewTag(q, dbg) {
  const slug = slugifyTag(q);
  dbg.slug = slug;

  // Collect from first up-to-three pages of the tag
  const seen = new Set();
  const urls = [];
  for (let page = 1; page <= 3; page++) {
    try {
      const pageLinks = await readTagPage(slug, page, dbg);
      for (const u of pageLinks) {
        if (!seen.has(u)) {
          seen.add(u);
          urls.push(u);
        }
      }
      if (urls.length >= 30) break; // plenty to find 5 items
    } catch {
      // Stop if a page is missing (e.g., tag has only 1 page)
      break;
    }
  }
  dbg.collectedLinks = urls.length;

  const items = [];
  for (const url of urls) {
    try {
      const art = await hydrateArticle(url);
      // Require a date; skip odd pages
      if (!art.date) continue;
      items.push(art);
      if (items.length >= 5) break;
    } catch {
      // skip
    }
  }

  // newest first
  items.sort((a, b) => (b.date || "") > (a.date || "") ? 1 : -1);
  return items.slice(0, 5);
}

export const handler = async (event) => {
  const q = (event.queryStringParameters?.q || "").trim();
  const debug = event.queryStringParameters?.debug === "1";
  if (!q) return json(400, { error: "Missing q" });

  const dbg = {};
  try {
    const items = await getTopFiveFromPreviewTag(q, dbg);
    return json(200, debug ? { subject: q, items, debug: dbg } : { subject: q, items });
  } catch (e) {
    return json(500, { error: e.message || "Unknown error", debug: dbg });
  }
};

function json(code, body) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
