import { NextResponse } from "next/server";
import { encodeToken } from "@/lib/crypto";
import { config, AJAX_HEADERS } from "@/lib/config";
import * as cheerio from "cheerio";
import { successResponse, errorResponse } from "@/lib/response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { aniId: string } }
): Promise<NextResponse> {
  const { aniId } = params;
  const debug: any = { ani_id: aniId, steps: [] };

  try {
    // Step 1: generate token
    debug.steps.push("1. Calling encodeToken...");
    const encoded = await encodeToken(aniId);
    debug.encoded_token = encoded;

    if (!encoded) {
      debug.steps.push("   FAILED: encodeToken returned null");
      return NextResponse.json({ error: "Token encryption failed", debug }, { status: 500 });
    }
    debug.steps.push(`   OK: token = ${encoded}`);

    // Step 2: build URL and fetch
    const url = new URL(config.ANIMEKAI_EPISODES_URL);
    url.searchParams.set("ani_id", aniId);
    url.searchParams.set("_", encoded);
    debug.fetch_url = url.toString();
    debug.steps.push(`2. Fetching: ${url.toString()}`);

    const res = await fetch(url.toString(), {
      headers: AJAX_HEADERS,
      next: { revalidate: 0 },
    });

    debug.http_status = res.status;
    debug.steps.push(`   HTTP status: ${res.status}`);

    if (!res.ok) {
      const text = await res.text();
      debug.response_body = text.substring(0, 500);
      debug.steps.push(`   FAILED: HTTP ${res.status}`);
      return NextResponse.json({ error: `HTTP ${res.status}`, debug }, { status: 500 });
    }

    // Step 3: parse JSON
    const ct = res.headers.get("content-type") || "";
    debug.content_type = ct;

    if (!ct.includes("application/json")) {
      const text = await res.text();
      debug.response_body = text.substring(0, 500);
      debug.steps.push(`   FAILED: Expected JSON but got ${ct}`);
      return NextResponse.json({ error: `Non-JSON response: ${ct}`, debug }, { status: 500 });
    }

    const json = await res.json();
    debug.raw_result_preview = JSON.stringify(json).substring(0, 300);
    debug.steps.push("3. JSON parsed OK");

    const html: string = json?.result ?? "";
    debug.html_length = html.length;
    debug.steps.push(`   HTML length: ${html.length} chars`);

    if (!html) {
      debug.steps.push("   FAILED: result HTML is empty");
      return NextResponse.json({ error: "Empty result from server", debug }, { status: 500 });
    }

    // Step 4: parse episodes
    const $ = cheerio.load(html);
    const epElements = $(".eplist a");
    debug.ep_elements_found = epElements.length;
    debug.steps.push(`4. Found ${epElements.length} episode elements`);

    const episodes: any[] = [];
    epElements.each((_, el) => {
      const ep = $(el);
      const langsAttr = ep.attr("langs");
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

    debug.steps.push("5. Done");

    return NextResponse.json({
      ani_id: aniId,
      count: episodes.length,
      episodes,
      debug,
    });

  } catch (err) {
    debug.exception = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: debug.exception, debug }, { status: 500 });
  }
}
