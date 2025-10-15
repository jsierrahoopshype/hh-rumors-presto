// Uses Node 18+ global fetch (no extra fetch library needed)
import { JSDOM } from "jsdom";

const RUMORS_FEED = "https://hoopshype.com/category/rumors/feed/";
const RUMORS_INDEX = "https://hoopshype.com/rumors/";

const TEAM_ALIASES = {
  lakers: ["los angeles lakers", "lal", "lakers"],
  clippers: ["los angeles clippers", "lac", "clippers"],
  knicks: ["new york knicks", "nyk", "knicks"],
  nets: ["brooklyn nets", "bkn", "nets"],
  heat: ["miami heat", "mia", "heat"],
  bucks: ["milwaukee bucks", "mil", "bucks"],
  celtics: ["boston celtics", "bos", "celtics"],
  sixers: ["philadelphia 76ers", "phi", "76ers", "sixers"],
  mavs: ["dallas mavericks", "dal", "mavericks", "mavs"],
  suns: ["phoenix suns", "phx", "suns"],
  warriors: ["golden state warriors", "gsw", "warriors"],
  thunder: ["oklahoma city thunder", "okc", "thunder"],
};

function toISO(dstr){
  const d = new Date(dstr);
  return isNaN(d) ? "" : d.toISOString().slice(0,10);
}

function escapeRegExp(str){ return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function matchMode(subject, mode){
  const s = subject.toLowerCase().trim();
  if(mode === "team"){
    const key = s.replace(/[^a-z]/g,'');
    const aliases = TEAM_ALIASES[key] || [s];
    return (txt) => {
      const t = txt.toLowerCase();
      return aliases.some(a => t.includes(a));
    };
  }
  if(mode === "player"){
    const parts = s.split(/\s+/);
    const last = parts[parts.length-1];
    const re = new RegExp(`\\b(${parts.map(p=>escapeRegExp(p)).join("|")}|${escapeRegExp(last)})\\b`, "i");
    return (txt) => re.test(txt);
  }
  return (txt) => txt.toLowerCase().includes(s);
}

function normSource(text){
  const via = /via\s+([A-Z][A-Za-z0-9 .'-]+)/i.exec(text);
  if(via) return via[1].trim();
  const dash = /[-–]\s*([A-Z][A-Za-z0-9 .'-]+)$/.exec(text.trim());
  if(dash) return dash[1].trim();
  return "HoopsHype";
}

function clean(s){ return (s||"").replace(/\s+/g,' ').trim(); }

async function getFromRSS(query, mode){
  const res = await fetch(RUMORS_FEED, { headers: { "user-agent": "Mozilla/5.0" }});
  if(!res.ok) throw new Error("RSS not reachable");
  const xml = await res.text();
  const dom = new JSDOM(xml, { contentType: "text/xml" });
  const items = [...dom.window.document.querySelectorAll("item")].map(it => {
    const title = it.querySelector("title")?.textContent || "";
    const link = it.querySelector("link")?.textContent || "";
    const pubDate = it.querySelector("pubDate")?.textContent || "";
    const desc = it.querySelector("description")?.textContent || "";
    return { title, url: link, date: toISO(pubDate), raw: `${title} ${desc}` };
  });

  const matches = items.filter(x => matchMode(query, mode)(x.raw)).slice(0, 20);
  const unique = [];
  const seen = new Set();
  for(const m of matches){
    if(seen.has(m.url)) continue;
    seen.add(m.url);
    unique.push(m);
    if(unique.length >= 12) break;
  }
  const refined = [];
  for (const it of unique) {
    try {
      const pg = await fetch(it.url, { headers:{ "user-agent":"Mozilla/5.0" }});
      const html = await pg.text();
      const d2 = new JSDOM(html);
      const doc = d2.window.document;
      const p = doc.querySelector("article p");
      const metaDate = doc.querySelector("time[datetime]")?.getAttribute("datetime");
      const snippet = p ? clean(p.textContent) : it.title;
      const source = normSource(html) || normSource(it.title);
      refined.push({ title: it.title, url: it.url, date: toISO(metaDate) || it.date || "", source, snippet });
    } catch {
      refined.push({ title: it.title, url: it.url, date: it.date || "", source: "HoopsHype", snippet: it.title });
    }
  }
  refined.sort((a,b)=> (b.date||"") > (a.date||"") ? 1 : -1);
  return refined.slice(0,5);
}

async function getFromIndex(query, mode){
  const pages = [RUMORS_INDEX, RUMORS_INDEX + "page/2/", RUMORS_INDEX + "page/3/"];
  const acc = [];
  for(const url of pages){
    const res = await fetch(url, { headers:{ "user-agent":"Mozilla/5.0" }});
    if(!res.ok) continue;
    const html = await res.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const articles = [...doc.querySelectorAll("article")];
    for(const a of articles){
      const link = a.querySelector("a")?.href;
      const title = a.querySelector("h2, h3")?.textContent || a.textContent || "";
      if(!link) continue;
      acc.push({ url: link, title });
    }
  }
  const filt = acc.filter(x => matchMode(query, mode)(x.title));
  const unique = [];
  const seen = new Set();
  for(const f of filt){
    if(seen.has(f.url)) continue;
    seen.add(f.url);
    unique.push(f);
    if(unique.length >= 12) break;
  }
  const out = [];
  for (const it of unique) {
    try {
      const pg = await fetch(it.url, { headers:{ "user-agent":"Mozilla/5.0" }});
      const html = await pg.text();
      const d2 = new JSDOM(html);
      const doc = d2.window.document;
      const p = doc.querySelector("article p");
      const metaDate = doc.querySelector("time[datetime]")?.getAttribute("datetime");
      const snippet = p ? clean(p.textContent) : it.title;
      const source = normSource(html) || normSource(it.title);
      out.push({ title: it.title, url: it.url, date: toISO(metaDate) || "", source, snippet });
    } catch {
      out.push({ title: it.title, url: it.url, date: "", source:"HoopsHype", snippet: it.title });
    }
  }
  out.sort((a,b)=> (b.date||"") > (a.date||"") ? 1 : -1);
  return out.slice(0,5);
}

export const handler = async (event) => {
  const q = (event.queryStringParameters?.q || "").trim();
  const mode = (event.queryStringParameters?.mode || "player").toLowerCase();
  if(!q) return json(400, { error:"Missing q" });
  try {
    let items = [];
    try {
      items = await getFromRSS(q, mode);
    } catch {
      items = await getFromIndex(q, mode);
    }
    return json(200, { subject:q, items });
  } catch (e) {
    return json(500, { error: e.message || "Unknown error" });
  }
};

function json(code, body){
  return { statusCode: code, headers: { "Content-Type":"application/json" }, body: JSON.stringify(body) };
}
