const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";


export class MegaUp {
    private static apiBase = "https://enc-dec.app/api";

    static async generateToken(n: string): Promise<string> {
        const url = `${this.apiBase}/enc-kai?text=${encodeURIComponent(n)}`;
        try {
            const res = await fetch(url);
            const ct = res.headers.get("content-type") || "";
            if (!ct.includes("application/json")) {
                const text = await res.text();
                console.error(`[MegaUp.generateToken] Non-JSON from ${url}:`, text.substring(0, 200));
                throw new Error(`generateToken: Expected JSON from ${url} but got ${ct}`);
            }
            const data = await res.json();
            return data.result;
        } catch (error: any) {
            console.error(`[MegaUp.generateToken] Error for ${url}:`, error.message);
            throw new Error(error.message);
        }
    }

    static async decodeIframeData(n: string): Promise<{
        url: string;
        skip: {
            intro: [number, number];
            outro: [number, number];
        };
    }> {
        const url = `${this.apiBase}/dec-kai`;
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: n }),
            });
            const ct = res.headers.get("content-type") || "";
            if (!ct.includes("application/json")) {
                const text = await res.text();
                console.error(`[MegaUp.decodeIframeData] Non-JSON from ${url}:`, text.substring(0, 200));
                throw new Error(`decodeIframeData: Expected JSON from ${url} but got ${ct}`);
            }
            const data = await res.json();
            return data.result;
        } catch (error: any) {
            console.error(`[MegaUp.decodeIframeData] Error for ${url}:`, error.message);
            throw new Error(error.message);
        }
    }

    static async decode(n: string): Promise<{
        sources: { file: string }[];
        tracks: { kind: string; file: string; label: string }[];
        download: string;
    }> {
        const url = `${this.apiBase}/dec-mega`;
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text: n,
                    agent: USER_AGENT,
                }),
            });
            const ct = res.headers.get("content-type") || "";
            if (!ct.includes("application/json")) {
                const text = await res.text();
                console.error(`[MegaUp.decode] Non-JSON from ${url}:`, text.substring(0, 200));
                throw new Error(`decode: Expected JSON from ${url} but got ${ct}`);
            }
            const data = await res.json();
            return data.result;
        } catch (error: any) {
            console.error(`[MegaUp.decode] Error for ${url}:`, error.message);
            throw new Error(error.message);
        }
    }

    static async extract(videoUrl: string): Promise<any> {
        try {
            const url = videoUrl.replace("/e/", "/media/");
            const res = await fetch(url, {
                headers: {
                    "Connection": "keep-alive",
                    "User-Agent": USER_AGENT,
                    "Referer": videoUrl,
                }
            });
            // Check if response is JSON before parsing
            const contentType = res.headers.get("content-type") || "";
            if (!contentType.includes("application/json")) {
                const text = await res.text();
                console.error(`Non-JSON response from ${url}:`, text.substring(0, 200));
                throw new Error(`Expected JSON but got ${res.status} ${res.statusText} from ${url}`);
            }
            const data = await res.json();
            const decrypted = await this.decode(data.result);

            return {
                sources: decrypted.sources?.map((s: any) => ({
                    url: s.file,
                    isM3U8: s.file.includes(".m3u8") || s.file.endsWith("m3u8"),
                })) || [],
                subtitles: decrypted.tracks?.map((t: any) => ({
                    kind: t.kind,
                    url: t.file,
                    lang: t.label,
                })) || [],
                download: decrypted.download || "",
            };
        } catch (error: any) {
            throw new Error(error.message);
        }
    }
}
