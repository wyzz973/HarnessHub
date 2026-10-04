// SPDX-License-Identifier: MIT
/**
 * Vision fallback (Magpie `gw/vision.go`): when a request with images goes to
 * a model whose metadata says it takes no image input, a configured
 * vision-capable model describes each image, and the image becomes
 * `[image: <description>]`. Each describing call is a model call of the
 * gateway's own, with its own ledger entry (agent `harnesshub-vision`).
 * Descriptions are cached by the image's hash. Without a configured model
 * the images become placeholder text, as before.
 */
import { createHash } from "node:crypto";

/** A model call the gateway makes for itself; see `InternalCalls` of ./server.js. */
export type InternalCall = (
  purpose: "vision" | "search",
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<{ status: number; body: unknown; callId?: string }>;

/** Images described at once. */
const CONCURRENCY = 4;
/** Descriptions kept, least recently used first out. */
const CACHE_SIZE = 256;
/** The longest description kept. */
const MAX_DESCRIPTION = 8_000;

export const VISION_PROMPT =
  "Describe this image for a reader who cannot see it, completely and precisely. Transcribe any text in it verbatim. Answer with the description only.";

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The URL of a Chat `image_url` part, or undefined. */
function imageUrl(part: unknown): string | undefined {
  if (!object(part) || part.type !== "image_url") return undefined;
  const url = object(part.image_url) ? part.image_url.url : part.image_url;
  return typeof url === "string" && url ? url : undefined;
}

/**
 * The images of Chat messages, each once; `current` marks those of the
 * newest user turn (after the last assistant message).
 */
export function imagesOf(
  messages: unknown,
): { url: string; current: boolean }[] {
  const list = Array.isArray(messages) ? messages : [];
  const lastAssistant = list.findLastIndex(
    (message) => object(message) && message.role === "assistant",
  );
  const seen = new Map<string, boolean>();
  list.forEach((message, index) => {
    if (!object(message) || !Array.isArray(message.content)) return;
    for (const part of message.content) {
      const url = imageUrl(part);
      if (url) seen.set(url, (seen.get(url) ?? false) || index > lastAssistant);
    }
  });
  return [...seen].map(([url, current]) => ({ url, current }));
}

/** Replace described images in Chat messages with their descriptions; others stay. */
export function describeImages(
  messages: unknown,
  descriptions: ReadonlyMap<string, string>,
): void {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!object(message) || !Array.isArray(message.content)) continue;
    message.content = message.content.map((part: unknown) => {
      const url = imageUrl(part);
      const text = url === undefined ? undefined : descriptions.get(url);
      return text === undefined
        ? part
        : { type: "text", text: `[image: ${text}]` };
    });
  }
}

/** What describing a request's images gave. */
export interface VisionResult {
  descriptions: Map<string, string>;
  /** Ledger patches: `vision:<callId>` per describing call, `vision:cached:<n>`, `vision:failed:<n>`. */
  patches: string[];
  /** An image of the newest user turn could not be described. */
  currentFailed: boolean;
}

/** Describes images with the configured model, with a cache by image hash. */
export class VisionDescriber {
  #cache = new Map<string, string>();

  constructor(private readonly internal: InternalCall) {}

  #remember(hash: string, text: string): void {
    this.#cache.delete(hash);
    this.#cache.set(hash, text);
    while (this.#cache.size > CACHE_SIZE)
      this.#cache.delete(this.#cache.keys().next().value!);
  }

  async describe(
    model: string,
    images: { url: string; current: boolean }[],
    signal: AbortSignal,
  ): Promise<VisionResult> {
    const result: VisionResult = {
      descriptions: new Map(),
      patches: [],
      currentFailed: false,
    };
    let cached = 0;
    let failed = 0;
    const pending: { url: string; current: boolean; hash: string }[] = [];
    for (const image of images) {
      const hash = createHash("sha256").update(image.url).digest("hex");
      const known = this.#cache.get(hash);
      if (known === undefined) pending.push({ ...image, hash });
      else {
        this.#remember(hash, known);
        result.descriptions.set(image.url, known);
        cached++;
      }
    }
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const image = pending[next++]!;
        signal.throwIfAborted();
        const text = await this.#one(model, image.url, signal, result);
        if (text === undefined) {
          failed++;
          if (image.current) result.currentFailed = true;
          continue;
        }
        this.#remember(image.hash, text);
        result.descriptions.set(image.url, text);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker),
    );
    if (cached) result.patches.push(`vision:cached:${cached}`);
    if (failed) result.patches.push(`vision:failed:${failed}`);
    return result;
  }

  /** One description, or undefined when the describing call failed. */
  async #one(
    model: string,
    url: string,
    signal: AbortSignal,
    result: VisionResult,
  ): Promise<string | undefined> {
    let answer: Awaited<ReturnType<InternalCall>>;
    try {
      answer = await this.internal(
        "vision",
        {
          model,
          stream: false,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: VISION_PROMPT },
                { type: "image_url", image_url: { url } },
              ],
            },
          ],
        },
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      return undefined;
    }
    if (answer.callId) result.patches.push(`vision:${answer.callId}`);
    if (answer.status !== 200 || !object(answer.body)) return undefined;
    const choice = Array.isArray(answer.body.choices)
      ? answer.body.choices[0]
      : undefined;
    const content =
      object(choice) && object(choice.message)
        ? choice.message.content
        : undefined;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part) =>
                object(part) && typeof part.text === "string" ? part.text : "",
              )
              .join("")
          : "";
    const trimmed = text.trim();
    return trimmed ? trimmed.slice(0, MAX_DESCRIPTION) : undefined;
  }
}
