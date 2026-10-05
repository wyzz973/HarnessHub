// SPDX-License-Identifier: MIT
/**
 * Web search emulation (Magpie `gw/search.go`, `search_api.go`): a client
 * may offer its model the server-side web search of the vendor it was made
 * for (Responses `web_search`, Anthropic `web_search_*`). An upstream of
 * another vendor cannot run it, so the gateway gives the model a function
 * tool `web_search(query)` instead, runs the searches the model asks for
 * with the search APIs the user registered (Tavily, Brave, Exa, Firecrawl,
 * SearXNG), and asks the model again with what they found, at most
 * {@link SEARCH_ROUNDS} times. The client sees one answer: the searches as
 * its protocol shows its vendor's own (Anthropic `server_tool_use` and
 * `web_search_tool_result` blocks, Responses `web_search_call` items with
 * their sources), never the function tool. Off unless a backend is set.
 */
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import type {
  SearchBackend,
  SearchBackendKind,
} from "@harnesshub/core/gateway-features";
import type { WireProtocol } from "@harnesshub/core/model-plane";
import { proxyFailure, type OutboundFetch } from "@harnesshub/core/outbound";
import { deadline, readLimited } from "./http.js";
import type {
  ChatResult,
  ReasoningField,
  ToolCall,
  Usage,
} from "./protocol.js";
import type { Candidate } from "./routing.js";
import type { CompletionHandlers } from "./upstream.js";

/** How many times an answer may go back to its model with what a search found. */
export const SEARCH_ROUNDS = 6;
/** Pages asked of a search API. */
const HITS = 6;
/** The most of a page's text a hit carries. */
const PAGE_TEXT = 1_500;
/** How long one search API may take. */
const SEARCH_MS = 30_000;
/**
 * How the gateway's searches are marked in what the client gets back:
 * Anthropic `srvtoolu_hh_…` blocks, Responses `ws_hh_…` items. A request
 * whose history has them is answered by the gateway again, never passed to
 * a vendor that would not know them.
 */
export const SEARCH_MARKERS = ["srvtoolu_hh_", "ws_hh_"] as const;
/** The User-Agent of the gateway's searches. */
export const SEARCH_AGENT = "harnesshub-search/1";

/** Each search API's own address, unless the backend overrides it. */
export const SEARCH_BASES: Readonly<
  Record<Exclude<SearchBackendKind, "searxng">, string>
> = {
  tavily: "https://api.tavily.com",
  brave: "https://api.search.brave.com",
  exa: "https://api.exa.ai",
  firecrawl: "https://api.firecrawl.dev",
};

/**
 * Upstreams that run their protocol's web search themselves (Magpie
 * `searchHosts`): a request passed through to them keeps its tool.
 */
const NATIVE_SEARCH: Partial<Record<WireProtocol, readonly string[]>> = {
  responses: ["api.openai.com", "api.x.ai", "api.deepseek.com"],
  anthropic: ["api.anthropic.com"],
};

/** The candidate's upstream runs the inbound protocol's web search itself. */
export function searchesNatively(
  candidate: Candidate,
  protocol: WireProtocol,
): boolean {
  if (candidate.mode !== "passthrough" || candidate.provider.subscription)
    return false;
  let host: string;
  try {
    host = new URL(candidate.endpoint).hostname;
  } catch {
    return false;
  }
  return NATIVE_SEARCH[protocol]?.includes(host) === true;
}

/** Whether a raw request offers its model a server-side web search, or has searches in its history. */
export function searchOffered(protocol: WireProtocol, raw: unknown): boolean {
  if (protocol !== "responses" && protocol !== "anthropic") return false;
  const text = JSON.stringify(raw);
  return text.includes("web_search");
}

/** The function tool the model gets, named so the client's own tools leave it free. */
export function searchTool(tools: unknown): {
  name: string;
  tool: Record<string, unknown>;
} {
  const names = new Set(
    (Array.isArray(tools) ? tools : []).map((tool: unknown) =>
      typeof tool === "object" && tool !== null
        ? (tool as { function?: { name?: unknown } }).function?.name
        : undefined,
    ),
  );
  let name = "web_search";
  while (names.has(name)) name = `hh_${name}`;
  return {
    name,
    tool: {
      type: "function",
      function: {
        name,
        description:
          "Search the web for current information: news, releases, documentation, prices, anything after your training or that you are unsure of. Returns what the pages found say, with their URLs. Cite the URLs you use.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for" },
          },
          required: ["query"],
        },
      },
    },
  };
}

/** One page a search found. */
export interface Hit {
  title: string;
  url: string;
  text: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A search API's text without its markup (Brave's `<strong>`), on one line. */
function plain(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(amp|lt|gt|quot|#39);/g,
      (_, name: string) =>
        ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[name] ?? "",
    )
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** The pages in a search API's answer. */
export function readHits(kind: SearchBackendKind, body: unknown): Hit[] {
  if (!object(body)) return [];
  let list: unknown = body.results;
  if (kind === "brave") list = object(body.web) ? body.web.results : undefined;
  if (kind === "firecrawl")
    list = object(body.data) ? body.data.web : body.data;
  const hits: Hit[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!object(item) || typeof item.url !== "string" || !item.url) continue;
    const text = [
      item.content,
      item.text,
      item.description,
      item.markdown,
    ].find(
      (value): value is string => typeof value === "string" && value !== "",
    );
    const title = typeof item.title === "string" ? plain(item.title) : "";
    const clipped = plain(text ?? "");
    hits.push({
      title: title || item.url,
      url: item.url,
      text:
        clipped.length > PAGE_TEXT
          ? `${clipped.slice(0, PAGE_TEXT)}…`
          : clipped,
    });
  }
  return hits.slice(0, HITS);
}

/** The request a search API takes for `query`. */
function searchRequest(
  backend: SearchBackend,
  key: string | undefined,
  query: string,
): { url: URL; init: RequestInit } {
  const base = (
    backend.baseUrl ??
    (backend.kind === "searxng" ? "" : SEARCH_BASES[backend.kind])
  ).replace(/\/+$/, "");
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": SEARCH_AGENT,
  };
  if (key)
    if (backend.kind === "brave") headers["x-subscription-token"] = key;
    else if (backend.kind === "exa") headers["x-api-key"] = key;
    else headers.authorization = `Bearer ${key}`;
  const post = (path: string, body: unknown) => ({
    url: new URL(`${base}${path}`),
    init: {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  });
  const get = (path: string, query: Record<string, string>) => {
    const url = new URL(`${base}${path}`);
    for (const [name, value] of Object.entries(query))
      url.searchParams.set(name, value);
    return { url, init: { method: "GET", headers } };
  };
  switch (backend.kind) {
    case "tavily":
      return post("/search", {
        query,
        max_results: HITS,
        search_depth: "basic",
      });
    case "brave":
      return get("/res/v1/web/search", { q: query, count: String(HITS) });
    case "exa":
      return post("/search", {
        query,
        numResults: HITS,
        contents: { text: { maxCharacters: PAGE_TEXT } },
      });
    case "firecrawl":
      return post("/v2/search", { query, limit: HITS });
    case "searxng":
      return get("/search", { q: query, format: "json" });
  }
}

/**
 * Search with the backends in their order until one finds something; the
 * text for the model and the pages, or the reasons each failed. Requests go
 * out through `send`, the daemon's proxy policy.
 */
export async function webSearch(
  query: string,
  backends: readonly SearchBackend[],
  resolveSecret: (ref: SecretReference) => Promise<string>,
  signal: AbortSignal,
  send: OutboundFetch,
): Promise<{ text: string; hits: Hit[] } | { error: string }> {
  const errors: string[] = [];
  for (const backend of backends) {
    let key: string | undefined;
    try {
      key = backend.credential
        ? await resolveSecret(backend.credential)
        : undefined;
    } catch {
      errors.push(`${backend.kind}: its key could not be read`);
      continue;
    }
    const { url, init } = searchRequest(backend, key, query);
    const timeout = deadline(signal, SEARCH_MS);
    try {
      const response = await send(url, {
        ...init,
        redirect: "error",
        signal: timeout.signal,
      });
      const text = await readLimited(response, 4 * 1024 * 1024);
      if (!response.ok) {
        errors.push(`${backend.kind}: HTTP ${response.status}`);
        continue;
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        errors.push(`${backend.kind}: the answer is not JSON`);
        continue;
      }
      const hits = readHits(backend.kind, body);
      if (!hits.length) {
        errors.push(`${backend.kind} found nothing`);
        continue;
      }
      return {
        hits,
        text: hits
          .map(
            (hit, index) =>
              `${index + 1}. ${hit.title} — ${hit.url}${hit.text ? `\n${hit.text}` : ""}`,
          )
          .join("\n\n"),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      const proxied = proxyFailure(error);
      errors.push(`${backend.kind}: ${proxied ? proxied.brief : "no answer"}`);
    } finally {
      timeout.dispose();
    }
  }
  return { error: errors.join("; ") || "no search backend is set" };
}

/** Usage of several rounds as one. */
function addUsage(
  a: Usage | undefined,
  b: Usage | undefined,
): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum: Usage = {};
  for (const key of [
    "input",
    "output",
    "total",
    "reasoning",
    "cached",
    "cacheWrite",
  ] as const)
    if (a[key] !== undefined || b[key] !== undefined)
      sum[key] = (a[key] ?? 0) + (b[key] ?? 0);
  return sum;
}

/** A search a round asked for. */
export interface SearchCall {
  id: string;
  query: string;
}

/**
 * The completion handlers of a search answer: rounds after the first go on
 * where the client's answer left off. The search tool's calls are kept
 * from the client and collected; the client's own calls keep their order
 * with indices of their own.
 */
export class SearchRelay implements CompletionHandlers {
  #started = false;
  #said = false;
  #gap = false;
  #hidden = new Set<number>();
  #mapped = new Map<number, number>();
  #nextIndex = 0;
  #text = "";
  #reasoning = "";
  #calls: ToolCall[] = [];
  #usage: Usage | undefined;

  constructor(
    private readonly handlers: CompletionHandlers,
    private readonly tool: string,
  ) {}

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.handlers.start();
  }
  async reasoning(text: string, field: ReasoningField): Promise<void> {
    await this.handlers.reasoning(text, field);
  }
  async text(text: string): Promise<void> {
    if (!text) return;
    // What it says after a search goes on from what it said before it.
    const shown = this.#gap ? `\n\n${text.replace(/^\n+/, "")}` : text;
    this.#gap = false;
    this.#said = true;
    await this.handlers.text(shown);
  }
  async toolStart(call: {
    index: number;
    id: string;
    name: string;
  }): Promise<void> {
    if (call.name === this.tool) {
      this.#hidden.add(call.index);
      return;
    }
    const index = this.#nextIndex++;
    this.#mapped.set(call.index, index);
    await this.handlers.toolStart({ ...call, index });
  }
  async toolArgs(index: number, text: string): Promise<void> {
    if (this.#hidden.has(index)) return;
    await this.handlers.toolArgs(this.#mapped.get(index) ?? index, text);
  }

  /**
   * A round ended: its searches, when it asked only for searches; the
   * client's calls end the answer.
   */
  round(result: ChatResult): SearchCall[] {
    this.#text += (this.#text && result.text ? "\n\n" : "") + result.text;
    this.#reasoning += result.reasoning;
    this.#usage = addUsage(this.#usage, result.usage);
    const searches: SearchCall[] = [];
    const theirs = result.calls.filter((call) => call.name !== this.tool);
    this.#calls.push(...theirs);
    this.#hidden.clear();
    this.#mapped.clear();
    if (theirs.length) return [];
    for (const call of result.calls)
      if (call.name === this.tool)
        searches.push({
          id: call.id,
          query:
            typeof call.input?.query === "string"
              ? call.input.query.trim()
              : "",
        });
    if (searches.length) this.#gap = this.#said;
    return searches;
  }

  /** The answer the client gets, from the last round's end. */
  result(last: ChatResult): ChatResult {
    return {
      ...last,
      text: this.#text,
      reasoning: this.#reasoning,
      calls: this.#calls,
      finish: this.#calls.length
        ? last.finish
        : last.finish === "tool_calls"
          ? "stop"
          : last.finish,
      ...(this.#usage ? { usage: this.#usage } : {}),
    };
  }
}
