import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { isInternalAddress } from "../net.js";
import { type Tool, tool } from "../tools/tool.js";
import { truncate, withTimeout } from "./shared.js";

export { isInternalAddress };

export interface WebToolsOptions {
  /** Only these domains (and their subdomains) may be fetched. Omit to allow any public host. */
  allowedDomains?: string[];
  /**
   * Allow loopback, private, link-local and other internal addresses. Off by
   * default so a model cannot reach internal services or cloud metadata
   * endpoints (SSRF).
   */
  allowPrivateNetwork?: boolean;
  /** Longest text returned. Defaults to 20 000 characters. */
  maxChars?: number;
  /** Defaults to 15 seconds. */
  timeoutMs?: number;
  /** Sent as the User-Agent header. */
  userAgent?: string;
}

const MAX_REDIRECTS = 5;
const TEXT_TYPES =
  /^(text\/|application\/(json|xml|xhtml\+xml|ld\+json|rss\+xml|atom\+xml|javascript))/;

/** `fetch_url`: HTTP(S) GET returning readable text (HTML is converted to plain text). */
export function webTools(options: WebToolsOptions = {}): Tool[] {
  const maxChars = options.maxChars ?? 20_000;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function checkUrl(url: URL): Promise<void> {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Only http and https URLs are allowed, got ${url.protocol}`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      options.allowedDomains &&
      !options.allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))
    ) {
      throw new Error(`Host ${host} is not in the allowed domains.`);
    }
    if (options.allowPrivateNetwork) return;
    const addresses = isIP(host)
      ? [host]
      : (await lookup(host, { all: true })).map((a) => a.address);
    const internal = addresses.find(isInternalAddress);
    if (internal) throw new Error(`Host ${host} resolves to an internal address (${internal}).`);
  }

  const fetchUrl = tool({
    name: "fetch_url",
    description:
      "Fetches a web page or text resource over HTTP(S) and returns its text content. HTML is converted to plain text.",
    parameters: z.object({ url: z.string().url().describe("Absolute http(s) URL.") }),
    annotations: { readOnly: true, openWorld: true },
    execute: async ({ url }, { signal }) => {
      let current = new URL(url);
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        // Checked on every hop: a public URL may redirect to an internal one.
        await checkUrl(current);
        const response = await fetch(current, {
          redirect: "manual",
          signal: withTimeout(signal, timeoutMs),
          headers: {
            "user-agent": options.userAgent ?? "umio/0.1 (+https://github.com)",
            accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
          },
        });
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
          current = new URL(location, current);
          continue;
        }
        const type = response.headers.get("content-type") ?? "";
        if (type && !TEXT_TYPES.test(type)) {
          throw new Error(`Unsupported content type ${type}; only text resources can be read.`);
        }
        const body = await response.text();
        const text = type.includes("html") ? htmlToText(body) : body;
        const header = `URL: ${current.href}\nStatus: ${response.status}\n\n`;
        return header + truncate(text, maxChars);
      }
      throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
    },
  });

  return [fetchUrl];
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** A small HTML-to-text conversion: drops scripts/styles, keeps block structure and link targets. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (match, code: string) => {
      if (code.startsWith("#x")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
