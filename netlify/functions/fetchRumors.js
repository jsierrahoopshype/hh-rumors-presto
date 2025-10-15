import { JSDOM } from "jsdom";

/**
 * Uses WordPress REST API on preview.hoopshype.com to get the 5 most recent
 * Rumors posts for a given player/team tag.
 *
 * Input:  q=Jalen%20Brunson   (we slugify to jalen_brunson)
 * Output: { subject, items:[{title,url,date,source,snippet},…] }
 * Debug:  add &debug=1 to see IDs and counts
 */

const PREVIEW_API_HTTP = "http://preview.hoopshype.com/wp-json/wp/v2";
const PREVIEW_API_HTTPS = "https://preview.hoopshype.com/wp-json/wp/v2";

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

function clean(s) { return (s || "").replace(/\s+/g, " ").trim(); }
function toISO(d) { const x = new Date(d); return isNaN(x) ? "" : x.toISOString().slice(0,10); }
function slugifyTag(q) {
  return clean(q)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function fetchJSON(url) {
  // Try HTTP first (preview often prefers it behind auth), then HTTPS
  for (const base of [PREVIEW_API_HTTP, PREVIEW_API_HTTPS]) {
    const u = url.replace("__BASE__", base);
    try {
      const res = await fetch(u, { headers: BASE_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch {
      // try next base
    }
  }
  throw new Error("All preview API fetch attempts failed");
}

async function getCategoryId(slug) {
  const data = await fetchJSON(`__BASE__/categories?slug=${encodeURIComponent(slug)}&per_page=1`);
  return Array.isArray(data) && data.length ? data[0].id : null;
}

async function getTagIdBySlugOrSearch(slug, nameFallback) {
  // Try exact slug first
  let data = await fetchJSON(`__BASE__/tags?slug=${encodeURIComponent(slug)}&per_page=1`);
  if (Array.isArray(data) && data.length) return data[0].id;

  // Fallback: search by name (space-separated), take best match
  data = await fetchJSON(`__BASE__/tags?search=${encodeURIComponent(nameFallback)}&per_page=5`);
  if (Array.isArray(data) && data.length) {
    // prefer slug that matches with underscores or hyphens
    const prefer = data.find(t => t.slug === slug || t.slug === slug.replace(/_/g, "-"));
    return (prefer || data[0]).id;
  }
  return null;
}

function extractFirstParagraphFromHTML(html) {
  try {
    const dom = new JSDOM(html);
    const p = dom.window.document.querySelector("p");
    return clean(p ? p.textContent : "");
  } catch {
    return "";
  }
}

function extractSourceFromHTML(htmlOrText) {
  const via = /via\s+([A-Z][A-Za-z0-9 .'-]+)/i.exec(htmlOrText);
  if (via) return via[1].trim();
  const dash = /[-–]\s*([A-Z][A-Za-z0-9 .'-]+)\s*$/i.exec(htmlOrText.replace(/<[^>]*>/g, "").trim());
  if (dash) return dash[1].trim();
  return "HoopsHype";
}

async function getRumorPostsByTagSlug(slug, nameForSearch, dbg) {
  // 1) Get Rumors category id
  const rumorsCatId = await getCategoryId("rumors");
  if (!rumorsCatId) return [];

  // 2) Get tag id
  const tagId = await getTagIdBySlugOrSearch(slug, nameForSearch);
  if (!tagId) return [];

  dbg.rumorsCategoryId = rumorsCatId;
  dbg.tagId = tagId;

  // 3) Fetch posts filtered by category + tag
  //    Order by date desc; pull more than 5 in case some lack content
  const posts = await fetchJSON(
    `__BASE__/posts?per_page=12&order=desc&orderby=date&categories=${rumorsCatId}&tags=${tagId}`
  );
  dbg.postsFetched = Array.isArray(posts) ? posts.length : 0;

  if (!Array.isArray(posts)) return [];

  // 4) Normalize to our shape
  const items = [];
  for (const p of posts) {
    const title = clean(p.title?.rendered || p.title || "");
    const url = p.link || "";
    const date = toISO(p.date || p.modified);
    const snippet = extractFirstParagraphFromHTML(p.content?.rendered || "");
    const source = extractSourceFromHTML(p.content?.rendered || title);

    if (!url || !date) continue;

    items.push({ title: title || "HoopsHype Rumor", url, date, source, snippet: snippet || title });
    if (items.length >= 5) break;
  }

  return items;
}

export const handler = async (event) => {
  const q = (event.queryStringParameters?.q || "").trim();
  const debug = event.queryStringParameters?.debug === "1";
  if (!q) return json(400, { error: "Missing q" });

  const dbg = { slug: slugifyTag(q) };

  try {
    const items = await getRumorPostsByTagSlug(dbg.slug, q, dbg);
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
