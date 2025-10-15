// netlify/functions/fetchRumors.js
import { JSDOM } from "jsdom";

/**
 * Scrapes preview.hoopshype.com tag pages (HTML) and returns the 5 most recent rumors.
 * Works even if date headers aren't <h2>/<h3>; any element with "Month DD, YYYY" sets the date.
 *
 * Query:  q=Jalen%20Brunson   (slug -> jalen_brunson)
 *         debug=1             (include debug info)
 */

const PREVIEW_ORIGIN = "http://preview.hoopshype.com"; // HTTP works with Basic Auth

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

// Parse "Month DD, YYYY" from any text → "YYYY-MM-DD"
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

/**
 * Parse one tag page:
 * - Walk *all* elements in content area; any element whose text matches a date sets currentDateISO.
 * - Treat <p> and <li> as rumor items (if we have a current date).
 * - Use the last <a> inside the item block as source + url.
 */
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

    // Set date when any element contains a Month DD, YYYY string
    const iso = extractISODate(text);
    if (iso) { currentDateISO = iso; continue; }

    // Candidate rumor blocks
    const isItemBlock = (tag === "p" || tag === "li");
    if (!isItemBlock || !currentDateISO) continue;

    if (!text || text.length < 15) continue; // skip very short items

    const anchors = [...el.querySelectorAll("a")];
    const lastA = anchors[anchors.length - 1];
    const url = lastA?.getAttribute("href") || "";
    const source = clean(lastA?.textContent || "") || "HoopsHype";

    out.push({
      title: text,
      url,
      date: currentDateISO,
      source,
      snippet: text
    });

    if (out.length >= 80) break; // safety
  }

  dbg.parsedItemsOnPage = (dbg.parsedItemsOnPage || 0) + out.length;
  return out;
}

async function collectFromTag(slug, dbg) {
  const collected = [];
  const seen = new Set();

  // Look back up to 10 pages
  for (let page = 1; page <= 10; page++) {
    const url = PREVIEW_ORIGIN + `/rumors/tag/${encodeURIComponent(slug)}/` + (page > 1 ? `page/${page}/` : "");
    let html = "";
    try {
      html = await fetchText(url);
    } catch (e) {
      dbg[`page${page}Error`] = String(e.message || e);
      break; // no more pages
    }

    const items = parseTagPage(html, dbg);

    for (const it of items) {
      const key = `${it.date}::${it.title.slice(0,80)}::${it.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(it);
    }

    if (collected.length >= 150) break;
  }

  // Sort strictly by date (newest first)
  collected.sort((a,b) => (b.date||"") > (a.date||"") ? 1 : -1);

  const top5 = collected.filter(x => x.url).slice(0,5);
  dbg.totalCollected = collected.length;
  dbg.returning = top5.length;
  return top5;
}

export const handler = async (event) => {
  const q = (event.queryStringParameters?.q || "").trim();
  const debug = event.queryStringParameters?.debug === "1";
  if (!q) return json(400, { error: "Missing q" });

  const slug = slugify(q);
  const dbg = { slug };

  try {
    const items = await collectFromTag(slug, dbg);
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

