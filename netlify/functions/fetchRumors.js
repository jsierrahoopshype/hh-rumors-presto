// netlify/functions/fetchRumors.js
import { JSDOM } from "jsdom";

/**
 * Scrapes preview.hoopshype.com tag pages (HTML) and returns 5 items:
 * - Accepts q="Jalen Brunson, New York Knicks" (comma-separated subjects)
 * - For each subject, slug -> jalen_brunson, new_york_knicks
 * - Crawls up to 10 pages per tag
 * - Preserves paragraph HTML (so in-snippet links stay clickable)
 * - Uses last <a> as the source (name + href)
 * - Merges, de-dupes, sorts by date desc, SKIPS the most recent, returns next five
 */

const PREVIEW_ORIGIN = "http://preview.hoopshype.com"; // Basic Auth works reliably over http

function b64(s) { return Buffer.from(s).toString("base64"); }
function getAuthHeader() {
  const pair = process.env.PREVIEW_BASIC_AUTH || "preview:hhpreview";
  return "Basic " + b64(pair);
}

const REQ = {
  headers: {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
    authorization: getAuthHeader(),
  },
  redirect: "follow",
};

function clean(s) { return (s || "").replace(/\s+/g, " ").trim(); }
function slugify(q){
  return clean(q)
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/&/g," and ")
    .replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");
}

// Parse "Month DD, YYYY" anywhere in text → "YYYY-MM-DD"
const MONTHS = {january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
function extractISODate(txt){
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/.exec(txt || "");
  if (!m) return "";
  const mm = MONTHS[m[1].toLowerCase()];
  if (!mm) return "";
  const dd = String(parseInt(m[2],10)).padStart(2,"0");
  const yy = m[3];
  return `${yy}-${String(mm).padStart(2,"0")}-${dd}`;
}

async function fetchText(url) {
  const res = await fetch(url, REQ);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Extract sanitized innerHTML from a paragraph while preserving <a> tags
function paragraphHTML(p) {
  // keep only <a> tags; strip others
  const clone = p.cloneNode(true);
  // Remove all attributes except href on <a>
  for (const el of clone.querySelectorAll("*")) {
    if (el.tagName.toLowerCase() === "a") {
      const href = el.getAttribute("href");
      el.getAttributeNames().forEach(n => { if (n !== "href") el.removeAttribute(n); });
      if (href) el.setAttribute("target","_blank");
      el.removeAttribute("rel");
    } else {
      // unwrap non-anchors (replace element with its text content)
      const txt = el.textContent || "";
      el.replaceWith(clone.ownerDocument.createTextNode(txt));
    }
  }
  return clone.innerHTML.replace(/\s+/g," ").trim();
}

function parseTagPage(html, dbg) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const container =
    doc.querySelector("main") ||
    doc.querySelector("#content") ||
    doc.querySelector(".content") ||
    doc.querySelector(".container") ||
    doc.body;

  const out = [];
  let currentDateISO = "";

  const nodes = [...container.querySelectorAll("*")];
  dbg.scannedNodes = (dbg.scannedNodes || 0) + nodes.length;

  for (const el of nodes) {
    const tag = el.tagName?.toLowerCase() || "";
    const text = clean(el.textContent || "");

    // Any element containing a "Month DD, YYYY" sets the date
    const iso = extractISODate(text);
    if (iso) { currentDateISO = iso; continue; }

    // Rumor blocks: <p> and <li>, only if we have a date set
    const isItemBlock = (tag === "p" || tag === "li");
    if (!isItemBlock || !currentDateISO) continue;
    if (!text || text.length < 15) continue;

    const anchors = [...el.querySelectorAll("a")];
    const lastA = anchors[anchors.length - 1];
    const url = lastA?.getAttribute("href") || "";
    const sourceName = clean(lastA?.textContent || "") || "HoopsHype";

    const htmlSnippet = paragraphHTML(el);

    out.push({
      title: text,                  // plain text version (for keys)
      snippet_html: htmlSnippet,    // keeps hyperlinks inside the paragraph
      url,                          // source/link at the end of the paragraph
      sourceName,
      date: currentDateISO
    });

    if (out.length >= 80) break; // safety cap per page
  }

  dbg.parsedItemsOnPage = (dbg.parsedItemsOnPage || 0) + out.length;
  return out;
}

async function collectFromOneTag(slug, dbg) {
  const items = [];
  const seen = new Set();

  for (let page = 1; page <= 10; page++) {
    const url = PREVIEW_ORIGIN + `/rumors/tag/${encodeURIComponent(slug)}/` + (page > 1 ? `page/${page}/` : "");
    let html = "";
    try {
      html = await fetchText(url);
    } catch (e) {
      dbg[`page${page}Error_${slug}`] = String(e.message || e);
      break; // no more pages
    }

    const parsed = parseTagPage(html, dbg);
    for (const it of parsed) {
      const key = `${it.date}::${it.title.slice(0,120)}::${it.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(it);
    }

    if (items.length >= 150) break;
  }
  return items;
}

function fmtMonthAbbrev(dateStr){
  // "YYYY-MM-DD" -> "Oct. 15, 2025" (with dot)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  if (!m) return "";
  const y = m[1], mon = parseInt(m[2],10), d = parseInt(m[3],10);
  const names = ["Jan.","Feb.","Mar.","Apr.","May","Jun.","Jul.","Aug.","Sep.","Oct.","Nov.","Dec."];
  return `${names[mon-1]} ${d}, ${y}`;
}

export const handler = async (event) => {
  const qRaw = (event.queryStringParameters?.q || "").trim();
  const debug = event.queryStringParameters?.debug === "1";
  if (!qRaw) return json(400, { error: "Missing q" });

  // Allow multiple subjects separated by commas; keep original for heading
  const subjects = qRaw.split(",").map(s => clean(s)).filter(Boolean);
  const slugs = subjects.map(slugify);
  const dbg = { subjects, slugs };

  try {
    // Collect from all tags, merge
    let merged = [];
    for (const slug of slugs) {
      const part = await collectFromOneTag(slug, dbg);
      merged = merged.concat(part);
    }

    // Sort newest first, de-dupe across tags by (date+title+url)
    merged.sort((a,b) => (b.date||"") > (a.date||"") ? 1 : -1);
    const dedup = [];
    const seen = new Set();
    for (const it of merged) {
      const key = `${it.date}::${it.title.slice(0,120)}::${it.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push(it);
    }

    // Skip the most recent, return next 5
    const window = dedup.slice(1, 6);

    // Map to final payload (including pretty date + source link)
    const items = window.map(it => ({
      date: it.date,
      date_pretty: fmtMonthAbbrev(it.date),
      snippet_html: it.snippet_html,         // paragraph with inline links preserved
      sourceName: it.sourceName,
      sourceUrl: it.url
    }));

    return json(200, debug ? { subject: qRaw, items, debug: { ...dbg, totalMerged: merged.length, totalAfterDedup: dedup.length, returning: items.length } } : { subject: qRaw, items });
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
