import { NextResponse } from "next/server";
import { resolveSource } from "@/lib/scraper";
import { successResponse, errorResponse } from "@/lib/response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { linkId: string } }
): Promise<NextResponse> {
  console.log(`[API] /source/${params.linkId} - Request started`);
  try {
    const data = await resolveSource(params.linkId);
    console.log(`[API] /source/${params.linkId} - Success`);
    return successResponse({ ...data });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error(`[API] /source/${params.linkId} - ERROR:`, errorMessage);
    console.error(`[API] /source/${params.linkId} - Full error:`, err);
    // Return detailed error to client so it shows in browser devtools
    return errorResponse(errorMessage, 500);
  }
}
