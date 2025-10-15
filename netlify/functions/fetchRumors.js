// netlify/functions/fetchRumors.js
import { JSDOM } from "jsdom";

// -------------------- CONFIG --------------------
const SEARCH_RSS   = (q) => `https://hoopshype.com/?s=${encodeURIComponent(q)}&feed=rss2`;
const SEARCH_HTML  = (q) => `https://hoopshype.com/?s=${encodeURIComponent(q)}`;
const RUMORS_FEED  = "https://hoopshype.com/category/rumors/feed/";
const RUMORS_INDEX = "https://hoopshype.com/rumors/";

const TEAM_ALIASES = {
  lakers:   ["los angeles lakers", "lal", "lakers"],
  clippers: ["los angeles clippers", "lac", "clippers"],
  knicks:   ["new york knicks", "nyk", "knicks"],
  nets:     ["brooklyn nets", "bkn", "nets"],
  heat:     ["miami heat", "mia", "heat"],
  bucks:    ["milwaukee bucks", "mil", "bucks"],
  celtics:  ["boston celtics", "bos", "celtics"],
  sixers:   ["philadelphia 76ers", "phi", "76ers", "sixers"],
  mavs:     ["dallas mavericks", "dal", "mavericks", "mavs"],
  suns:     ["phoenix suns", "phx", "suns"],
  warriors: ["golden state warriors", "gsw", "warriors"],
  thunder:  ["oklahoma city thunder", "okc", "thunder"],
};

const UA = {
  headers: {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
  },
};

// -------------------- UTILS --------------------
function toISO(dstr) {
  const d = new Date(dstr);
  return isNaN(d) ? "" : d.toISOString().slice(0, 10);
}
function clean(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function buildMatcher(subject, mode) {
  const s = subject.toLowerCase().trim();
  if (mode === "team") {
    const key = s.replace(/[^a-z]/g, "");
    const aliases = TEAM_ALIASES[key] || [s];
    return (txt) => {
      const t = txt.toLowerCase();
      return aliases.some((a) => t.includes(a));
    };
  }
  if (mode === "player") {
    const parts = s.split(/\s+/);
    const last = parts[parts.length - 1];
    const re = new RegExp(
      `\\b(${parts.map((p) => escapeRegExp(p)).join("|")}|${escapeRegExp(last)})\\b`,
      "i"
    );
    return (txt) => re.test(txt);
  }
  return (txt) => txt.toLowerCase().includes(s);
}
function sourceFrom(text) {
  const via = /via\s+([A-Z][A-Za-z0-9 .'-]+)/i.exec(text);
  if (via) return via[1].trim();
  const dash = /[-–]\s*([A-Z][A-Za-z0-9 .'-]+)\s*$/i.exec(text.trim());
  if (dash) return dash[1].trim();
  return "HoopsHype";
}
function isRumorsLanding(url) {
  return url
    .replace(/^https?:\/\/(www\.)?/i, "https://")
    .replace(/\/+$/, "") === "https://hoopshype.com/rumors";
}
function hasTimestamp(doc) {
  return !!doc.querySelector("time[datetime]");
}
async function fetchText(url) {
  const res = await fetch(url, UA);
  if (!res.ok) throw new Error(`Fetch ${res.status} ${url}`);
  return res.text();
}

// -------------------- SOURCING --------------------
// A) Site search RSS → hydrate → filter body
async function fromSearchRSS(q, matcher, dbg) {
  try {
    const xml = await fetchText(SEARCH_RSS(q));
    const dom = new JSDOM(xml, { contentType: "text/xml" });
    const items = [...dom.window.document.querySelectorAll("item")].map((it) => ({
      title: it.querySelector("title")?.textContent || "",
      url: it.querySelector("link")?.textContent || "",
      date: toISO(it.querySelector("pubDate")?.textContent || ""),
      desc: it.querySelector("description")?.textContent || "",
    }));

    const candidates = items
      .filter((x) => (x.url || "").includes("/rumors/") && !isRumorsLanding(x.url))
      .sort((a, b) => (b.date || "") > (a.date || "") ? 1 : -1);

    dbg.rssCount = items.length;
    dbg.rssRumorsCount = candidates.length;

    const out = [];
    for (const it of candidates) {
      try {
        const html = await fetchText(it.url);
        const d2 = new JSDOM(html);
        const doc = d2.window.document;
        if (!hasTimestamp(doc)) continue;

        const article = doc.querySelector("article") || doc.body;
        const body = clean(article.textContent || "");
        if (!matcher(body + " " + it.title + " " + it.desc)) continue;

        const p = doc.querySelector("article p");
        const snippet = clean(p ? p.textContent : it.title);
        const meta = toISO(doc.querySelector("time[datetime]")?.getAttribute("datetime") || it.date);
        const src = sourceFrom(html) || sourceFrom(it.title);

        out.push({ title: clean(it.title), url: it.url, date: meta, source: src, snippet });
        if (out.length >= 5) break;
      } catch {
        // skip bad pages
      }
    }
    return out;
  } catch {
    return [];
  }
}

// B) Site search HTML → collect rumor links → hydrate → filter body
async function fromSearchHTML(q, matcher, dbg) {
  try {
    const html = await fetchText(SEARCH_HTML(q));
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const links = [...doc.querySelectorAll("a")]
      .map((a) => a.getAttribute("href"))
      .filter((u) => u && u.includes("/rumors/") && !isRumorsLanding(u));

    dbg.searchLinks = links.length;

    const seen = new Set();
    const out = [];
    for (const url of links) {
      if (!url || seen.has(url)) continue;
      seen.add(url);

      try {
        const page = await fetchText(url);
        const d2 = new JSDOM(page);
        const doc2 = d2.window.document;
        if (!hasTimestamp(doc2)) continue;

        const article = doc2.querySelector("article") || doc2.body;
        const body = clean(article.textContent || "");
        if (!matcher(body)) continue;

        const titleEl = doc2.querySelector("h1, h2");
        const title = clean(titleEl?.textContent || "");
        const p = doc2.querySelector("article p");
        const snippet = clean(p ? p.textContent : title);
        const dateIso = toISO(doc2.querySelector("time[datetime]")?.getAttribute("datetime") || "");
        const src = sourceFrom(page) || sourceFrom(title);

        out.push({ title, url, date: dateIso, source: src, snippet });
        if (out.length >= 5) break;
      } catch {
        // skip
      }
    }
    out.sort((a, b) => (b.date || "") > (a.date || "") ? 1 : -1);
    return out.slice(0, 5);
  } catch {
    return [];
  }
}

// C) Rumors feed → hydrate → filter body
async function fromRumorsFeed(q, matcher, dbg) {
  try {
    const xml = await fetchText(RUMORS_FEED);
    const dom = new JSDOM(xml, { contentType: "text/xml" });
    const items = [...dom.window.document.querySelectorAll("item")].map((it) => ({
      title: it.querySelector("title")?.textContent || "",
      url: it.querySelector("link")?.textContent || "",
      date: toISO(it.querySelector("pubDate")?.textContent || ""),
      desc: it.querySelector("description")?.textContent || "",
    }));
    dbg.rumorsFeedCount = items.length;

    const out = [];
    for (const it of items) {
      if (!it.url || isRumorsLanding(it.url)) continue;

      try {
        const html = await fetchText(it.url);
        const d2 = new JSDOM(html);
        const doc = d2.window.document;
        if (!hasTimestamp(doc)) continue;

        const article = doc.querySelector("article") || doc.body;
        const body = clean(article.textContent || "");
        if (!matcher(body + " " + it.title + " " + it.desc)) continue;

        const p = doc.querySelector("article p");
        const snippet = clean(p ? p.textContent : it.title);
        const dt = toISO(doc.querySelector("time[datetime]")?.getAttribute("datetime") || it.date);
        const src = sourceFrom(html) || sourceFrom(it.title);

        out.push({ title: clean(it.title), url: it.url, date: dt, source: src, snippet });
        if (out.length >= 5) break;
      } catch {
        // skip
      }
    }
    return out;
  } catch {
    return [];
  }
}

// D) Rumors index pages → collect → hydrate → filter body
async function fromRumorsIndex(q, matcher, dbg) {
  try {
    const pages = [RUMORS_INDEX, RUMORS_INDEX + "page/2/", RUMORS_INDEX + "page/3/"];
    const links = [];
    const seen = new Set();

    for (const u of pages) {
      const html = await fetchText(u);
      const dom = new JSDOM(html);
      const doc = dom.window.document;

      for (const a of doc.querySelectorAll("article a")) {
        const href = a.getAttribute("href");
        if (!href || seen.has(href) || isRumorsLanding(href)) continue;
        seen.add(href);
        links.push(href);
        if (links.length >= 80) break;
      }
      if (links.length >= 80) break;
    }
    dbg.indexLinks = links.length;

    const out = [];
    for (const url of links) {
      try {
        const html = await fetchText(url);
        const d2 = new JSDOM(html);
        const doc2 = d2.window.document;
        if (!hasTimestamp(doc2)) continue;

        const article = doc2.querySelector("article") || doc2.body;
        const body = clean(article.textContent || "");
        if (!matcher(body)) continue;

        const title = clean(doc2.querySelector("h1, h2")?.textContent || "");
        const p = doc2.querySelector("article p");
        const snippet = clean(p ? p.textContent : title);
        const dateIso = toISO(doc2.querySelector("time[datetime]")?.getAttribute("datetime") || "");
        const src = sourceFrom(html) || sourceFrom(title);

        out.push({ title, url, date: dateIso, source: src, snippet });
        if (out.length >= 5) break;
      } catch {
        // skip
      }
    }
    out.sort((a, b) => (b.date || "") > (a.date || "") ? 1 : -1);
    return out.slice(0, 5);
  } catch {
    return [];
  }
}

// -------------------- HANDLER --------------------
export const handler = async (event) => {
  const q = (event.queryStringParameters?.q || "").trim();
  const mode = (event.queryStringParameters?.mode || "player").toLowerCase();
  const debug = event.queryStringParameters?.debug === "1";
  if (!q) return json(400, { error: "Missing q" });

  const matcher = buildMatcher(q, mode);
  const dbg = {};

  let items = await fromSearchRSS(q, matcher, dbg);
  if (!items.length) items = await fromSearchHTML(q, matcher, dbg);
  if (!items.length) items = await fromRumorsFeed(q, matcher, dbg);
  if (!items.length) items = await fromRumorsIndex(q, matcher, dbg);

  return json(200, debug ? { subject: q, items, debug: dbg } : { subject: q, items });
};

function json(code, body) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
