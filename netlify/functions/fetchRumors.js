// netlify/functions/fetchRumors.js
import { JSDOM } from "jsdom";

/**
 * Pull the five most recent HoopsHype Rumors from preview.hoopshype.com tag pages:
 *   http://preview.hoopshype.com/rumors/tag/jalen_brunson
 *   http://preview.hoopshype.com/rumors/tag/phoenix_suns
 *
 * Query:
 *   q=Jalen%20Brunson   (required; we slugify to jalen_brunson)
 *   debug=1             (optional; returns debug info)
 */

// Prefer HTTP on preview (basic auth often blocks HTTPS)
const PREVIEW_HTTP = "http://preview.hoopshype.com";
const PREVIEW_HTTPS = "https://preview.hoopshype.com";

function b64(s) { return Buffer.from(s).toString("base64"); }
function getAuthHeader() {
  const pair = process.env.PREVIEW_BASIC_AUTH || "preview:hhpreview";
  return "Basic " + b64(pair);
}

const BASE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  authorization: getAuthHeader(),
};

function toISO(dstr) {
  const d = new Date(dstr);
  return isNaN(d) ? "" : d.toISOString().slice(0, 10);
}
function clean(s) { return (s || "").replace(/\s+/g, " ").trim(); }
function sourceFrom(text) {
  const via = /via\s+([A-Z][A-Za-z0-9 .'-]+)/i.exec(text);
  if (via) return via[1].trim();
  const dash = /[-–]\s*([A-Z][A-Za-z0-9 .'-]+)\s*$/i.exec(text.trim());
  if (dash) return dash[1].trim();
  return "HoopsHype";
}
// "New York Knicks" -> "new_york_knicks"
function slugifyTag(q) {
  return clean(q)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function fetchText(url, dbg) {
  // try HTTP first if it’s the preview host
  const isPreview = /preview\.hoopshype\.com/i.test(url);
  const tryUrls = isPreview && url.startsWith("https://")
    ? [url.replace("https://", "http://"), url]
    : isPreview && url.startsWith("http://")
      ? [url, url.replace("http://", "https://")]
      : [url];

  let lastErr;
  for (const u of tryUrls) {
    try {
      const res = await fetch(u, { headers: BASE_HEADERS, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      dbg && (dbg.fetchOK = (dbg.fetchOK || 0) + 1);
      return await res.text();
    } catch (e) {
      lastErr = e;
      dbg && (dbg.fetchFail = (dbg.fetchFail || 0) + 1);
    }
  }
  throw lastErr || new Error("Fetch failed");
}

// Read one tag page and extract article URLs
async function readTagPage(slug, pageNo, dbg) {
  // build both http/https; fetchText will try http first
  const base = PREVIEW_HTTP; // starting scheme; fetchText handles https fallback
  const url =
    base +
    `/rumors/tag/${encodeURIComponent(slug)}/` +
    (pageNo > 1 ? `page/${pageNo}/` : "");
  const html = await fetchText(url, dbg);
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Broaden selectors: some themes use entry-title/h2/h3 instead of <article>
  const anchors = [
    ...doc.querySelectorAll("article a, .entry-title a, h2 a, h3 a"),
  ];

  const allHrefs = anchors
    .map((a) => a.getAttribute("href"))
    .filter(Boolean);

  // Keep rumor post permalinks only (not tag pages)
  const links = allHrefs.filter(
    (href) => /\/rumors\//.test(href) && !/\/rumors\/tag\//.test(href)
  );

  dbg[`page${pageNo}AllHrefs`] = allHrefs.length;
  dbg[`page${pageNo}Links`] = links.length;
  return links;
}

// Load one article and normalize fields
async function hydrateArticle(url, dbg) {
  const html = await fetchText(url, dbg);
  const d2 = new JSDOM(html);
  const doc = d2.window.document;

  const timeEl = doc.querySelector("time[datetime]");
  const dateIso = toISO(timeEl?.getAttribute("datetime") || "");

  const title =
    clean(doc.querySelector("h1, h2")?.textContent || "") || "HoopsHype Rumor";

  const p = doc.querySelector("article p") || doc.querySelector(".entry-content p");
  const snippet = clean(p ? p.textContent : title);

  const src = sourceFrom(html) || sourceFrom(title);

  return { title, url, date: dateIso, source: src, snippet };
}

async function getTopFiveFromPreviewTag(q, dbg) {
  const slug = slugifyTag(q);
  dbg.slug = slug;

  const seen = new Set();
  const urls = [];

  // look through first 3 pages of the tag
  for (let page = 1; page <= 3; page++) {
    try {
      const pageLinks = await readTagPage(slug, page, dbg);
      for (const u of pageLinks) {
        if (!seen.has(u)) {
          seen.add(u);
          urls.push(u);
        }
      }
      if (urls.length >= 30) break;
    } catch (e) {
      dbg[`page${page}Error`] = String(e.message || e);
      break; // stop if this tag has fewer pages
    }
  }
  dbg.collectedLinks = urls.length;

  const items = [];
  for (const url of urls) {
    try {
      const art = await hydrateArticle(url, dbg);
      if (!art.date) continue; // skip odd pages without a timestamp
      items.push(art);
      if (items.length >= 5) break;
    } catch (e) {
      // ignore
    }
  }

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
