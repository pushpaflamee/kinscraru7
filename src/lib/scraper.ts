import * as cheerio from "cheerio";
import { config, HEADERS, AJAX_HEADERS } from "./config";
import { parseInfoSpans } from "./parser";
import { encodeToken, decodeKai, decodeMega } from "./crypto";
import { MegaUp } from "./megacup";
import type {
  AnimeItem,
  BannerItem,
  LatestItem,
  TrendingItem,
  HomeData,
  AnimeDetail,
  Episode,
  ServersData,
  SourceData,
  MostSearchedItem,
} from "../types";



//import axios from "axios";

async function getBatchAnilistIds(titles: string[]) {
  const uniqueTitles = [...new Set(titles.filter(title => title && title.trim()))];

  if (!uniqueTitles.length) return {};

  // Optional: Add batch size limit
  const MAX_BATCH_SIZE = 12;
  if (uniqueTitles.length > MAX_BATCH_SIZE) {
    console.warn(`Batch size ${uniqueTitles.length} exceeds ${MAX_BATCH_SIZE}, truncating`);
    uniqueTitles.length = MAX_BATCH_SIZE;
  }

  // Build query with variables
  let query = "query(";
  const variables: Record<string, string> = {};

  uniqueTitles.forEach((title, i) => {
    query += `$search${i}: String, `;
    variables[`search${i}`] = title;
  });

  query = query.slice(0, -2) + ") {\n"; // remove last comma

  uniqueTitles.forEach((_, i) => {
    query += `
      anime${i}: Media(search: $search${i}, type: ANIME) {
        id
      }
    `;
  });

  query += "\n}";

  try {
    // Add timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query,
        variables,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Handle non-OK responses
    if (!res.ok) {
      if (res.status === 429) {
        console.error("Rate limited by AniList");
      }
      throw new Error(`AniList API error: ${res.status}`);
    }

    const json = await res.json();

    // Handle GraphQL errors
    if (json.errors) {
      console.error("GraphQL errors:", json.errors);
      return {};
    }

    const data = json?.data || {};

    const map: Record<string, number | null> = {};

    uniqueTitles.forEach((title, i) => {
      map[title] = data[`anime${i}`]?.id ?? null;
    });

    return map;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.error("AniList request timeout");
    } else {
      console.error("AniList batch error:", err);
    }
    return {};
  }
}
// ---------- most-searched ----------

export async function scrapeMostSearched(): Promise<MostSearchedItem[]> {
  const res = await fetch(config.ANIMEKAI_URL, {
    headers: HEADERS,
    next: { revalidate: 60 },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const $ = cheerio.load(await res.text());
  const section =
    $(".most_searched").first() ?? $(".most-searched").first();
  if (!section.length) throw new Error("Could not find most-searched section");

  const results: MostSearchedItem[] = [];
  section.find("a").each((_, el) => {
    const name = $(el).text().trim();
    const href = $(el).attr("href") ?? "";
    const keyword = href.includes("keyword=")
      ? href.split("keyword=").pop()!.replace(/\+/g, " ")
      : "";
    if (name) {
      results.push({
        name,
        keyword,
        search_url: href.startsWith("/")
          ? `${config.ANIMEKAI_URL.replace(/\/$/, "")}${href}`
          : href,
      });
    }
  });
  return results;
}

// ---------- search ----------

export async function searchAnime(keyword: string): Promise<AnimeItem[]> {
  const url = new URL(config.ANIMEKAI_SEARCH_URL);
  url.searchParams.set("keyword", keyword);

  const res = await fetch(url.toString(), {
    headers: AJAX_HEADERS,
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  const html: string = json?.result?.html ?? "";
  if (!html) return [];

  const $ = cheerio.load(html);
  const results: AnimeItem[] = [];

  $("a.aitem").each((_, el) => {
    const item = $(el);
    const titleTag = item.find("h6.title");
    const title = titleTag.text().trim();
    const japanese_title = titleTag.attr("data-jp") ?? "";
    const poster = item.find(".poster img").attr("src") ?? "";
    const href = item.attr("href") ?? "";
    const slug = href.startsWith("/watch/") ? href.replace("/watch/", "") : href;

    let sub = "",
      dub = "",
      animeType = "",
      year = "",
      rating = "",
      total_eps = "";

    item.find(".info span").each((_, span) => {
      const cls = $(span).attr("class")?.split(" ") ?? [];
      const text = $(span).text().trim();
      if (cls.includes("sub")) sub = text;
      else if (cls.includes("dub")) dub = text;
      else if (cls.includes("rating")) rating = text;
      else {
        const hasB = $(span).find("b").length > 0;
        if (hasB && /^\d+$/.test(text)) total_eps = text;
        else if (hasB) animeType = text;
        else year = text;
      }
    });

    if (title) {
      results.push({
        title,
        japanese_title,
        slug,
        url: `${config.ANIMEKAI_URL.replace(/\/$/, "")}${href}`,
        poster,
        sub_episodes: sub,
        dub_episodes: dub,
        total_episodes: total_eps,
        year,
        type: animeType,
        rating,
      });
    }
  });

  return results;
}

// ---------- home ----------

export async function scrapeHome(): Promise<HomeData> {
  const res = await fetch(config.ANIMEKAI_HOME_URL, {
    headers: HEADERS,
    next: { revalidate: 60 },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const $ = cheerio.load(await res.text());
  const base = config.ANIMEKAI_URL.replace(/\/$/, "");

  // Banner
  const banner: BannerItem[] = [];
  const slides = $(".swiper-slide").toArray();

  // ✅ STEP 1: Collect titles first
  const titles = slides.map((el) => {
    const titleTag = $(el).find("p.title");
    return (
      titleTag.attr("data-jp")?.trim() ||
      titleTag.text().trim()
    );
  });

  // ✅ STEP 2: Fetch all AniList IDs in ONE request
  const anilistMap = await getBatchAnilistIds(titles);

  // ✅ STEP 3: Build banner
  for (const el of slides) {
    const slide = $(el);

    const style = slide.attr("style") ?? "";
    const poster = style.includes("url(")
      ? style.split("url(")[1].split(")")[0]
      : "";

    const titleTag = slide.find("p.title");
    const href = slide.find("a.watch-btn").attr("href") || "";
    const id = href.startsWith("/watch/") ? href.slice(7) : "";

    const title = titleTag.text().trim();
    const japanese_title = titleTag.attr("data-jp") ?? "";

    // ⭐ Use JP title first (more accurate)
    const searchTitle = japanese_title || title;

    const description = slide.find("p.desc").text().trim();

    const infoEl = slide.find(".info");
    const { sub, dub, animeType } = parseInfoSpans($, infoEl);

    let genres = "";
    infoEl.find("span").each((_, span) => {
      const cls = $(span).attr("class") ?? "";
      if (!cls && !$(span).find("b").length) {
        const t = $(span).text().trim();
        if (t && !/^\d+$/.test(t)) genres = t;
      }
    });

    let rating = "", release = "", quality = "";
    slide.find(".mics > div").each((_, div) => {
      const lbl = $(div).find("div").first().text().trim().toLowerCase();
      const val = $(div).find("span").first().text().trim();
      if (lbl === "rating") rating = val;
      else if (lbl === "release") release = val;
      else if (lbl === "quality") quality = val;
    });

    // ⭐ INSTANT lookup (no API call here)
    const anilist_id = anilistMap[searchTitle] || null;

    if (title) {
      banner.push({
        id,
        anilist_id,
        title,
        japanese_title,
        description,
        poster,
        url: href ? `${base}${href}` : "",
        sub_episodes: sub,
        dub_episodes: dub,
        type: animeType,
        genres,
        rating,
        release,
        quality,
      });
    }
  }


  // Latest
  const latest: LatestItem[] = [];
  $(".aitem-wrapper.regular .aitem").each((_, el) => {
    const item = $(el);
    const titleTag = item.find("a.title");
    let href = item.find("a.poster").attr("href") ?? "";
    const episode = href.includes("#ep=") ? href.split("#ep=").pop()! : "";
    href = href.split("#ep=")[0];
    const id = href.startsWith("/watch/") ? href.slice(7) : "";
    const { sub, dub, animeType } = parseInfoSpans($, item.find(".info"));

    if (titleTag.text().trim()) {
      latest.push({
        id: id,
        title: titleTag.text().trim(),
        japanese_title: titleTag.attr("data-jp") ?? "",
        poster: item.find("img.lazyload").attr("data-src") ?? "",
        url: `${base}${href}`,
        current_episode: episode,
        sub_episodes: sub,
        dub_episodes: dub,
        type: animeType,
      });
    }
  });

  // Trending
  const top_trending: Record<string, TrendingItem[]> = {};
  const TAB_MAP: Record<string, string> = {
    trending: "NOW",
    day: "DAY",
    week: "WEEK",
    month: "MONTH",
  };

  for (const [tabId, tabLabel] of Object.entries(TAB_MAP)) {
    const container = $(`.aitem-col.top-anime[data-id="${tabId}"]`);
    if (!container.length) continue;
    const items: TrendingItem[] = [];

    container.find("a.aitem").each((_, el) => {
      const item = $(el);
      const style = item.attr("style") ?? "";
      const poster = style.includes("url(")
        ? style.split("url(")[1].split(")")[0]
        : "";
      const { sub, dub, animeType } = parseInfoSpans($, item.find(".info"));
      const id = item.attr("href")?.split("/").pop() ?? "";

      items.push({
        id: id,
        rank: item.find(".num").text().trim(),
        title: item.find(".detail .title").text().trim(),
        japanese_title: item.find(".detail .title").attr("data-jp") ?? "",
        poster,
        url: `${base}${item.attr("href") ?? ""}`,
        sub_episodes: sub,
        dub_episodes: dub,
        type: animeType,
      });
    });

    top_trending[tabLabel] = items;
  }

  return { banner, latest_updates: latest, top_trending };
}

// ---------- anime info ----------

export async function scrapeAnimeInfo(slug: string): Promise<AnimeDetail> {
  const url = `${config.ANIMEKAI_URL}watch/${slug}`;
  const res = await fetch(url, { headers: HEADERS, next: { revalidate: 300 } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const $ = cheerio.load(await res.text());

  // Try data-id from rating box first (primary method)
  let ani_id = $(".rate-box#anime-rating").attr("data-id") ?? "";

  // Fallback: try script#syncData
  if (!ani_id) {
    const syncScript = $("script#syncData");
    if (syncScript.length) {
      try {
        ani_id = JSON.parse(syncScript.html() ?? "")?.anime_id ?? "";
      } catch {
        /* ignore */
      }
    }
  }

  const infoEl = $(".main-entity .info");
  const { sub, dub, animeType } = parseInfoSpans($, infoEl);

  const detail: Record<string, string | string[]> = {};
  $(".detail > div > div").each((_, div) => {
    const text = $(div).text().replace(/\s+/g, " ").trim();
    if (!text.includes(":")) return;
    const [rawKey, ...rest] = text.split(":");
    const key = rawKey.trim().toLowerCase().replace(/\s+/g, "_");
    const links = $(div).find("span a");
    detail[key] = links.length
      ? links.map((_, a) => $(a).text().trim()).get()
      : rest.join(":").trim();
  });

  const seasons = $(".swiper-wrapper.season .aitem")
    .map((_, el) => {
      const item = $(el);
      const d = item.find(".detail");
      return {
        title: d.find("span").first().text().trim(),
        episodes: d.find(".btn").first().text().trim(),
        poster: item.find("img").attr("src") ?? "",
        url: item.find("a.poster").length
          ? `${config.ANIMEKAI_URL.replace(/\/$/, "")}${item.find("a.poster").attr("href") ?? ""
          }`
          : "",
        active: (item.attr("class") ?? "").includes("active"),
      };
    })
    .get();

  const bgEl = $(".watch-section-bg");
  const bgStyle = bgEl.attr("style") ?? "";
  const bannerImg =
    bgStyle.includes("url(") ? bgStyle.split("url(")[1].split(")")[0] : "";

  const episodes: Episode[] = [];
  try {
    const epRes = await fetchEpisodes(ani_id);
    episodes.push(...epRes);
  } catch (e) {
    // ignore
  }

  return {
    ani_id,
    title: $("h1.title").first().text().trim(),
    japanese_title: $("h1.title").first().attr("data-jp") ?? "",
    description: $(".desc").first().text().trim(),
    poster: $(".poster img[itemprop='image']").attr("src") ?? "",
    banner: bannerImg,
    sub_episodes: sub,
    dub_episodes: dub,
    type: animeType,
    rating: infoEl.find(".rating").first().text().trim(),
    mal_score: $(".rate-box .value").first().text().trim(),
    detail,
    seasons,
    episodes,
  };
}

// ---------- episodes ----------

export async function fetchEpisodes(ani_id: string): Promise<Episode[]> {
  const encoded = await encodeToken(ani_id);
  if (!encoded) throw new Error("Token encryption failed");

  const url = new URL(config.ANIMEKAI_EPISODES_URL);
  url.searchParams.set("ani_id", ani_id);
  url.searchParams.set("_", encoded);

  const res = await fetch(url.toString(), {
    headers: AJAX_HEADERS,
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html: string = (await res.json())?.result ?? "";
  if (!html) return [];

  const $ = cheerio.load(html);
  const episodes: Episode[] = [];

  $(".eplist a").each((_, el) => {
    const ep = $(el);
    const langsAttr = ep.attr("langs");
    // If langs bitmask attr exists use it; otherwise default sub=true, dub=false
    let has_sub = true;
    let has_dub = false;
    if (langsAttr !== undefined && /^\d+$/.test(langsAttr)) {
      const bits = parseInt(langsAttr);
      has_sub = Boolean(bits & 1);
      has_dub = Boolean(bits & 2);
    }
    episodes.push({
      number: ep.attr("num") ?? "",
      slug: ep.attr("slug") ?? "",
      title: ep.find("span").first().text().trim(),
      japanese_title: ep.find("span").first().attr("data-jp") ?? "",
      token: ep.attr("token") ?? "",
      has_sub,
      has_dub,
    });
  });

  return episodes;
}

// ---------- servers ----------

export async function fetchServers(ep_token: string): Promise<ServersData> {
  const encoded = await encodeToken(ep_token);
  if (!encoded) throw new Error("Token encryption failed");

  const url = new URL(config.ANIMEKAI_SERVERS_URL);
  url.searchParams.set("token", ep_token);
  url.searchParams.set("_", encoded);

  const res = await fetch(url.toString(), {
    headers: AJAX_HEADERS,
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html: string = (await res.json())?.result ?? "";
  const $ = cheerio.load(html);

  const servers: Record<string, ServersData["servers"][string]> = {};
  $(".server-items").each((_, group) => {
    const lang = $(group).attr("data-id") ?? "unknown";
    servers[lang] = $(group)
      .find(".server")
      .map((_, s) => ({
        name: $(s).text().trim(),
        server_id: $(s).attr("data-sid") ?? "",
        episode_id: $(s).attr("data-eid") ?? "",
        link_id: $(s).attr("data-lid") ?? "",
      }))
      .get();
  });

  return {
    watching: $(".server-note p").first().text().trim(),
    servers,
  };
}

// ---------- source ----------

export async function resolveSource(link_id: string): Promise<SourceData & { debug?: any }> {
  // Collect debug info to return to client
  const debugInfo: any = {
    link_id,
    steps: [] as string[],
    urls: [] as string[],
  };

  debugInfo.steps.push("1. Starting resolveSource");

  // 🔐 Generate token using MegaUp API
  debugInfo.steps.push("2. Generating token via MegaUp API");
  const encoded = await MegaUp.generateToken(link_id);
  debugInfo.encoded_token = encoded;
  debugInfo.steps.push(`   Token generated: ${encoded ? 'success' : 'failed'}`);

  if (!encoded) throw new Error("Token encryption failed");

  const url = new URL(config.ANIMEKAI_LINKS_VIEW_URL);
  url.searchParams.set("id", link_id);
  url.searchParams.set("_", encoded);

  const linksViewUrl = url.toString();
  debugInfo.urls.push({ step: "links_view", url: linksViewUrl });
  debugInfo.steps.push(`3. Fetching links view: ${linksViewUrl}`);

  const res = await fetch(linksViewUrl, {
    headers: AJAX_HEADERS,
    next: { revalidate: 0 },
  });

  debugInfo.steps.push(`   Response status: ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  // Check content-type before parsing JSON
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const text = await res.text();
    debugInfo.steps.push(`   ❌ Non-JSON response: ${ct}`);
    debugInfo.error_response = text.substring(0, 500);
    throw new Error(`Expected JSON from links view but got ${ct}`);
  }
  const json = await res.json();
  debugInfo.steps.push(`   Response: ${JSON.stringify(json).substring(0, 200)}...`);

  const encryptedResult: string = json?.result ?? "";
  debugInfo.encrypted_result = encryptedResult;
  debugInfo.steps.push("4. Decoding iframe data via MegaUp API");

  // 🔓 Decode iframe data using MegaUp
  const embedData = await MegaUp.decodeIframeData(encryptedResult);
  debugInfo.embed_data = embedData;
  debugInfo.steps.push("   Decryption successful");

  if (!embedData) throw new Error("Embed decryption failed");

  const embed_url = embedData.url || "";
  debugInfo.urls.push({ step: "embed_url", url: embed_url });
  debugInfo.steps.push(`5. Embed URL: ${embed_url}`);

  if (!embed_url) throw new Error("No embed URL found");

  // 🚀 Extract final sources directly
  debugInfo.steps.push("6. Extracting media sources");
  const extracted = await MegaUp.extract(embed_url);
  debugInfo.extracted_media = extracted;
  debugInfo.steps.push("   Extraction successful");

  const output: SourceData = {
    embed_url,
    skip: embedData.skip ?? {},
    sources: extracted.sources ?? [],
    tracks: extracted.subtitles ?? [],
    download: extracted.download ?? "",
  };

  debugInfo.steps.push("7. Final output prepared");
  debugInfo.final_output = output;

  // Attach debug info to output
  return { ...output, debug: debugInfo };
}
