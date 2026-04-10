import { NextResponse } from "next/server";
import { searchAnime, scrapeAnimeInfo } from "@/lib/scraper";
import { successResponse, errorResponse } from "@/lib/response";
import type { Episode, AnimeDetail } from "@/types";

// Runtime configuration
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Constants (move to env vars in production)
const ANILIST_API_URL = process.env.ANILIST_API_URL || "https://graphql.anilist.co";
const ANIZIP_API_URL = process.env.ANIZIP_API_URL || "https://api.ani.zip";
const CACHE_TTL = 86400; // 24 hours in seconds
const REQUEST_TIMEOUT = 10000; // 10 seconds

// GraphQL query with better formatting
const ANILIST_QUERY = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id
      title {
        romaji
        english
        native
      }
      synonyms
      episodes
      status
      format
    }
  }
`;

// Typed interfaces
interface AniListTitle {
  romaji?: string | null;
  english?: string | null;
  native?: string | null;
}

interface AniListMedia {
  id: number;
  title: AniListTitle;
  synonyms: string[];
  episodes?: number | null;
  status?: string;
  format?: string;
}

interface AniListResponse {
  data?: {
    Media?: AniListMedia;
  };
  errors?: Array<{ message: string }>;
}

interface AniZipEpisode {
  episodeNumber?: number;
  absoluteEpisodeNumber?: number;
  image?: string;
  airDate?: string;
  overview?: string;
}

interface AniZipData {
  episodes?: Record<string, AniZipEpisode>;
  mal_id?: number;
  anilist_id?: number;
}

interface EnhancedEpisode extends Episode {
  image?: string;
  airDate?: string;
  overview?: string;
}

interface AnimeResponse {
  title: string;
  japanese_title?: string;
  episodes: EnhancedEpisode[];
  metadata?: {
    anilist_id: number;
    total_episodes?: number;
    status?: string;
    format?: string;
  };
}

/**
 * Fetch with timeout wrapper
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "AniKai-API/1.0",
        ...options.headers,
      },
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Retry wrapper for external API calls
 */
async function fetchWithRetry<T>(
  fetchFn: () => Promise<T>,
  retries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetchFn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on client errors (4xx)
      if (lastError.message.includes("40") && attempt < retries) {
        throw lastError;
      }

      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
      }
    }
  }

  throw lastError ?? new Error("Request failed after retries");
}

/**
 * Fetch episode images from ani.zip API with caching
 */
async function fetchEpisodeImages(anilistId: number): Promise<Record<string, string>> {
  const imageMap: Record<string, string> = {};

  try {
    const url = `${ANIZIP_API_URL}/mappings?anilist_id=${anilistId}`;
    const res = await fetchWithTimeout(url, {
      next: { revalidate: CACHE_TTL },
      method: "GET",
    });

    if (!res.ok) {
      if (res.status >= 500) {
        console.warn(`ani.zip API returned ${res.status}, retrying...`);
        // Could add retry logic here
      }
      return imageMap;
    }

    const data: AniZipData = await res.json();

    if (!data?.episodes) return imageMap;

    for (const [key, ep] of Object.entries(data.episodes)) {
      if (ep.image) {
        // Prioritize episodeNumber for standard episodes
        const episodeKey = ep.episodeNumber?.toString() ?? key;
        imageMap[episodeKey] = ep.image;

        // Also map absolute episode numbers if different
        if (ep.absoluteEpisodeNumber && ep.absoluteEpisodeNumber !== ep.episodeNumber) {
          imageMap[ep.absoluteEpisodeNumber.toString()] = ep.image;
        }
      }
    }
  } catch (error) {
    console.error(`Failed to fetch episode images for AniList ID ${anilistId}:`, error);
    // Fail silently - images are non-critical
  }

  return imageMap;
}

/**
 * Merge episode images with enhanced metadata support
 */
function mergeEpisodeImages(
  episodes: Episode[],
  imageMap: Record<string, string>,
  extraData?: Record<string, Partial<AniZipEpisode>>
): EnhancedEpisode[] {
  return episodes.map((ep) => {
    const num = ep.number?.toString();
    const imageData = imageMap[num];
    const extraMetadata = extraData?.[num];

    if (imageData || extraMetadata) {
      return {
        ...ep,
        ...(imageData && { image: imageData }),
        ...(extraMetadata?.airDate && { airDate: extraMetadata.airDate }),
        ...(extraMetadata?.overview && { overview: extraMetadata.overview }),
      };
    }
    return ep as EnhancedEpisode;
  });
}

/**
 * Build prioritized search terms from AniList data
 */
function buildSearchTerms(media: AniListMedia): string[] {
  const terms = new Set<string>();

  // Add titles in priority order
  if (media.title?.romaji) terms.add(media.title.romaji);
  if (media.title?.english) terms.add(media.title.english);
  if (media.title?.native) terms.add(media.title.native);

  // Add synonyms, filtering out duplicates and empty strings
  media.synonyms?.forEach(syn => {
    if (syn?.trim()) terms.add(syn.trim());
  });

  return Array.from(terms).filter(Boolean);
}

/**
 * Validate and parse AniList ID
 */
function parseAniListId(id: string): number | null {
  const parsed = parseInt(id, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 999999) {
    return null;
  }
  return parsed;
}

export async function GET(
  _req: Request,
  { params }: { params: { anilistId: string } }
): Promise<NextResponse<AnimeResponse | { error: string }>> {
  const anilistId = parseAniListId(params.anilistId);

  if (!anilistId) {
    return errorResponse("Invalid AniList ID. Must be a positive integer.", 400);
  }

  try {
    // Step 1: Fetch anime data from AniList with retry logic
    const anilistData = await fetchWithRetry<AniListResponse>(async () => {
      const res = await fetchWithTimeout(ANILIST_API_URL, {
        method: "POST",
        body: JSON.stringify({
          query: ANILIST_QUERY,
          variables: { id: anilistId }
        }),
        next: { revalidate: CACHE_TTL },
      });

      if (!res.ok) {
        throw new Error(`AniList API returned ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();

      if (data.errors?.length) {
        throw new Error(`AniList GraphQL error: ${data.errors[0].message}`);
      }

      return data;
    });

    const media = anilistData?.data?.Media;

    if (!media) {
      return errorResponse(`Anime with AniList ID ${anilistId} not found`, 404);
    }

    // Step 2: Build search terms and find match on AniKai
    const searchTerms = buildSearchTerms(media);
    let animeInfo: AnimeDetail | null = null;
    let matchedTerm: string | null = null;

    for (const term of searchTerms) {
      try {
        const results = await searchAnime(term);

        if (Array.isArray(results) && results.length > 0 && results[0]?.slug) {
          animeInfo = await scrapeAnimeInfo(results[0].slug);
          matchedTerm = term;
          break;
        }
      } catch (err) {
        console.warn(`Search failed for term "${term}":`, err);
        continue;
      }
    }

    if (!animeInfo) {
      return errorResponse(
        `Anime "${media.title?.romaji || media.title?.english || anilistId}" not found on AniKai`,
        404
      );
    }

    // Step 3: Fetch episode images (parallel with non-critical path)
    const [episodeImageMap] = await Promise.all([
      fetchEpisodeImages(anilistId),
      // Could add more parallel fetches here if needed
    ]);

    // Step 4: Merge and enhance episodes
    const episodesWithImages = mergeEpisodeImages(
      animeInfo.episodes,
      episodeImageMap
    );

    // Step 5: Build response with metadata
    const responseData: AnimeResponse = {
      title: animeInfo.title,
      japanese_title: animeInfo.japanese_title,
      episodes: episodesWithImages,
      metadata: {
        anilist_id: anilistId,
        total_episodes: media.episodes ?? undefined,
        status: media.status ?? undefined,
        format: media.format ?? undefined,
      },
    };

    // Return with appropriate cache headers
    return NextResponse.json(responseData, {
      status: 200,
      headers: {
        "Cache-Control": `public, s-maxage=${CACHE_TTL}, stale-while-revalidate=${CACHE_TTL / 2}`,
      },
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown server error";
    console.error(`API Error for AniList ID ${anilistId}:`, err);

    // Return appropriate status based on error type
    const statusCode = errorMessage.includes("not found") ? 404 : 500;
    return errorResponse(errorMessage, statusCode);
  }
}