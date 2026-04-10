import { NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { HEADERS } from "@/lib/config";

export const revalidate = 86400;

/* ------------------ ✅ Title Normalizer ------------------ */
function normalizeTitle(title: string = "") {
    return title
        .replace(/\(.*?\)/g, "") // remove (2026)
        .replace(/[:\-]/g, " ")
        .replace(/[^\w\s]/g, "") // remove special chars
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

/* ------------------ ✅ AniList Batch Fetch ------------------ */
async function getBatchAnilistIds(titles: string[]) {
    const uniqueTitles = [...new Set(titles.filter(Boolean))];

    if (!uniqueTitles.length) return {};

    let query = "query(";
    const variables: Record<string, string> = {};

    uniqueTitles.forEach((title, i) => {
        query += `$search${i}: String, `;
        variables[`search${i}`] = title;
    });

    query = query.slice(0, -2) + ") {\n";

    uniqueTitles.forEach((_, i) => {
        query += `
        anime${i}: Media(search: $search${i}, type: ANIME) {
          id
          title {
            romaji
            english
            native
          }
        }
      `;
    });

    query += "\n}";

    try {
        const res = await fetch("https://graphql.anilist.co", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({ query, variables }),
        });

        const json = await res.json();
        const data = json?.data || {};

        const map: Record<string, number | null> = {};

        uniqueTitles.forEach((title, i) => {
            const media = data[`anime${i}`];

            if (!media) {
                map[title] = null;
                return;
            }

            const possibleTitles = [
                media.title?.romaji,
                media.title?.english,
                media.title?.native,
            ]
                .filter(Boolean)
                .map((t: string) => normalizeTitle(t));

            const isMatch = possibleTitles.some((t: string) =>
                t.includes(title)
            );

            map[title] = isMatch ? media.id : null;
        });

        return map;
    } catch (err) {
        console.error("AniList batch error:", err);
        return {};
    }
}

/* ------------------ ✅ API Route ------------------ */
export async function GET(
    req: Request,
    { params }: { params: { name: string } }
) {
    try {
        const { name } = params;

        const { searchParams } = new URL(req.url);
        const page = Number(searchParams.get("page")) || 1;

        const url = `https://anikai.to/ajax/home/items?name=${name}&page=${page}`;

        const res = await fetch(url, {
            headers: {
                ...HEADERS,
                "X-Requested-With": "XMLHttpRequest",
            },
        });

        const jsonData = await res.json();
        const html = jsonData.result;

        const $ = cheerio.load(html);

        const tempList: any[] = [];

        $(".aitem").each((_, el) => {
            const titleEl = $(el).find(".title");

            const title = titleEl.attr("title")?.trim() || "";
            const jpTitle = titleEl.attr("data-jp")?.trim() || "";

            const link = $(el).find(".poster").attr("href") || "";
            const id =
                link.split("/watch/")[1]?.split("#")[0] || "";

            const image =
                $(el).find("img").attr("data-src") || "";

            const subEpisode = ($(el).find(".sub")).text().trim();
            const dubEpisode = ($(el).find(".dub")).text().trim();

            const infoElements = $(el).find(".info span b");

            const totalEpisodes =
                infoElements.length > 1
                    ? infoElements.first().text().trim()
                    : null;

            const type =
                infoElements.last().text().trim() || "";

            const isAdult =
                $(el).find(".adult").length > 0;

            const tooltipId =
                $(el)
                    .find(".ttip-btn")
                    .attr("data-tip") || null;

            // Extra computed fields
            const sub = subEpisode ? Number(subEpisode) : 0;
            const dub = dubEpisode ? Number(dubEpisode) : 0;
            const total = totalEpisodes
                ? Number(totalEpisodes)
                : null;

            const isCompleted =
                total && sub === total ? true : false;

            const progress =
                total && sub
                    ? Number(((sub / total) * 100).toFixed(2))
                    : null;

            tempList.push({
                id,
                title,
                jpTitle,
                image,
                link,

                subEpisode: sub,
                dubEpisode: dub,
                totalEpisodes: total,

                type,
                isAdult,
                tooltipId,

                isCompleted,
                progress,
            });
        });

        /* ------------------ ✅ Prepare Titles ------------------ */
        const titlePairs = tempList.map(item => ({
            original: item,
            searchTitles: [
                normalizeTitle(item.jpTitle),
                normalizeTitle(item.title),
            ].filter(Boolean),
        }));

        const allTitles = titlePairs.flatMap(t => t.searchTitles);

        /* ------------------ ✅ Fetch AniList IDs ------------------ */
        const anilistMap = await getBatchAnilistIds(allTitles);

        /* ------------------ ✅ Attach IDs ------------------ */
        const animeList = titlePairs.map(({ original, searchTitles }) => {
            let anilist_id: number | null = null;

            for (const t of searchTitles) {
                if (anilistMap[t]) {
                    anilist_id = anilistMap[t];
                    break;
                }
            }

            return {
                ...original,
                anilist_id,
            };
        });

        return NextResponse.json({
            status: "ok",
            page,
            results: animeList.length,
            data: animeList,
        });

    } catch (error) {
        console.error("API ERROR:", error);

        return NextResponse.json(
            { status: "error", message: "Failed to fetch data" },
            { status: 500 }
        );
    }
}