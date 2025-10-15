// netlify/functions/fetchRumors.js
import { JSDOM } from "jsdom";

/**
 * Scrapes preview.hoopshype.com tag pages (HTML) and returns the 5 most recent rumors
 * for a player or team, even if they were posted days/weeks ago.
 *
 * Example tag:
 *   http://preview.hoopshype.com/rumors/tag/jalen_brunson/
 *
 * Query:
 *   q=Jalen%20Brunson     -> slug jalen_brunson
 *   debug=1               -> include debug info
 */

const PREVIEW_ORIGIN = "http://preview.hoopshype.com"; // HTTP works with Basic Auth

function b64(s) { return Buffer.from(s).toString("base64"); }
function getAuthHeader() {
  // Set PREVIEW_BASIC_AUTH = "preview:hhpreview" in Netlify
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

// Parse "Month DD, YYYY" from heading text → "YYYY-MM-DD"
function toISOFromHeading(h) {
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/i.exec(h || "");
  if (!m) return "";
  const months = {
    january:1,february:2,march:3,april:4,may:5,june:6,
    july:7,august:8,september:9,october:10,november:11,december:12
  };
  const mm = months[m[1].toLowerCase()];
  const dd = String(parseInt(m[2],10)).padStart(2,"0");
  const yy = m[3];
  return mm ? `${yy}-${String(mm).padStart(2,"0")}-${dd}` : "";
}

async function fetchText(url) {
  const res = await fetch(url, REQ);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/**
 * Parse a tag page:
 * - Any H2/H3 with "Month DD, YYYY" starts a date section (no need for “Updates”).
 * - Each following <p> becomes a rumor item until the next date heading.
 * - Last <a> in the <p> is used as source+url.
 */
function parseTagPage(html, dbg) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const container =
    doc.querySelector("main") ||
    doc.querySelector("#content") ||
    doc.querySelector(".content") ||
    doc.body;

  const out = [];
  let currentDateISO = "";

  const blocks = [...container.querySelectorAll("h1, h2, h3, p, div, article, section, ul, ol")];

  for (const el of blocks) {
    const tag = el.tagName.toLowerCase();

    // Date heading (any H2/H3 that contains a valid date string)
    if (tag === "h2" || tag === "h3") {
      const iso = toISOFromHeading(el.textContent || "");
      if (iso) { currentDateISO = iso; continue; }
    }

    // Rumor item paragraph under a known date
    if (tag === "p" && currentDateISO) {
      const text = clean(el.textContent || "");
      if (!text || text.length < 15) continue;

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

      if (out.length >= 60) break; // safety cap per page
    }
  }

  dbg.parsedItemsOnPage = (dbg.parsedItemsOnPage || 0) + out.length;
  return out;
}

async function collectFromTag(slug, dbg) {
  const collected = [];
  const seen = new Set();

  // Look back up to 10 pages to find recent items (weeks/month).
  for (let page = 1; page <= 10; page++) {
    const url = PREVIEW_ORIGIN + `/rumors/tag/${encodeURIComponent(slug)}/` + (page > 1 ? `page/${page}/` : "");
    let html = "";
    try {
      html = await fetchText(url);
    } catch (e) {
      dbg[`page${page}Error`] = String(e.message || e);
      break; // stop if page missing
    }

    const items = parseTagPage(html, dbg);

    for (const it of items) {
      const key = `${it.date}::${it.title.slice(0,80)}::${it.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(it);
    }

    // If we already have way more than we need, stop crawling
    if (collected.length >= 120) break;
  }

  // Ensure newest first by date
  collected.sort((a,b) => (b.date||"") > (a.date||"") ? 1 : -1);

  // Return the 5 newest with a link
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
