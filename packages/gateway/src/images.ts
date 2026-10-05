// SPDX-License-Identifier: MIT
/**
 * Images (Magpie `gw/draw.go`, narrowed): `POST /v1/images/generations` and
 * `POST /v1/images/edits`, in OpenAI's Images shape, JSON or (for edits
 * mostly) multipart.
 *
 * A provider that declares an images endpoint (`ProviderConfig.imageEndpoint`)
 * is asked on it: the JSON request is passed through with the model's wire
 * name, a multipart edit is sent again as a form with its images, and the
 * answer (JSON, or the `stream: true` events) goes back as the provider sent
 * it. A provider with a Chat endpoint and no images endpoint is asked in chat
 * completions with `modalities: ["image", "text"]`, once per image (at most
 * {@link CHAT_DRAWINGS}), and its images are given back in the Images shape;
 * an images endpoint that answers 404 or 405 is asked again that way once,
 * on the same credential, when the provider has a Chat endpoint.
 *
 * The model is a Model Ref, or a `group/<id>` whose models (groups inside it
 * included) are tried in order; credentials fail over as for model calls.
 * Prompts have their known secrets redacted. The call is a ledger entry with
 * the usage the provider reports and its cost when the model is priced.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  modelAllowed,
  parseModelRef,
  providerEnabled,
  type CallAttempt,
  type GatewayKeyRecord,
  type ModelCallEntry,
  type ModelRef,
  type ProviderConfig,
  type RouteGroupId,
  wireName,
} from "@harnesshub/core/model-plane";
import { providerProxy } from "@harnesshub/core/outbound";
import { groupModels } from "@harnesshub/core/route-groups";
import { redactKeyText } from "@harnesshub/core/key-text";
import { errorResponse, type CallServices } from "./call.js";
import { deadline, failure, readBody, readLimited } from "./http.js";
import { callCost, callUsage, type UsageParts } from "./ledger.js";
import { upstreamHeaders } from "./passthrough.js";
import { GatewayError, object, record } from "./protocol.js";
import type { QuotaRefusal } from "./quota.js";
import {
  classify,
  echoFree,
  failureKind,
  hiddenBy,
  KEYLESS_CREDENTIAL,
  type Candidate,
} from "./routing.js";
import { sanitize } from "./upstream.js";

/** How long a provider may take to answer an image request (Magpie: 5 minutes). */
const IMAGE_MS = 5 * 60_000;

/** A chat model draws one image a call; a request through chat asks for at most this many (Magpie `maxDrawings`). */
export const CHAT_DRAWINGS = 4;

/** An image to edit or draw from, or one drawn: bytes, or a URL left for the vendor to fetch. */
interface Picture {
  mime: string;
  data?: Buffer;
  url?: string;
  name?: string;
}

/** One images request, whichever shape it came in. */
export interface Drawing {
  model: string;
  prompt: string;
  n: number;
  stream: boolean;
  /** The JSON body as it came; absent for a multipart request. */
  json?: Record<string, unknown>;
  /** The text fields of a multipart request, as they came. */
  fields: Map<string, string>;
  size?: string;
  background?: string;
  images: Picture[];
  mask?: Picture;
}

/** Usage of an Images answer or of its `image_generation.completed` event. */
export function imageUsage(value: unknown): UsageParts | undefined {
  const fields = record(record(value)?.usage);
  if (!fields) return undefined;
  const count = (field: unknown) =>
    typeof field === "number" && Number.isFinite(field) && field >= 0
      ? Math.round(field)
      : undefined;
  const input = count(fields.input_tokens);
  const output = count(fields.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

function invalid(message: string): GatewayError {
  return new GatewayError(message, 400, "invalid_request");
}

/** The image at a `data:` URL, or an `http(s)` one left for the vendor. */
function pictureOf(source: string): Picture {
  const text = source.trim();
  if (text.startsWith("data:")) {
    const comma = text.indexOf(",");
    const meta = comma > 0 ? text.slice(5, comma) : "";
    if (!meta.endsWith(";base64"))
      throw invalid("An image's data: URL must be base64");
    return {
      mime: meta.slice(0, -";base64".length) || "image/png",
      data: Buffer.from(text.slice(comma + 1), "base64"),
    };
  }
  if (/^https?:\/\//i.test(text)) return { mime: "", url: text };
  throw invalid("An image is a data: or http(s) URL");
}

/** The images a JSON field gives: a URL, `{image_url}` or `{url}`, or a list of them. */
function imageSources(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(imageSources);
  const item = record(value);
  if (!item) return [];
  if (typeof item.url === "string") return [item.url];
  return item.image_url === undefined ? [] : imageSources(item.image_url);
}

/**
 * Read an images request: JSON, or a `multipart/form-data` form with
 * `image`, `image[]` and `mask` files. A prompt is required; `n` is a
 * positive integer, 1 when absent.
 *
 * @throws GatewayError 400 `invalid_request` for anything else.
 */
export async function readDrawing(
  bytes: Buffer,
  contentType: string | undefined,
): Promise<Drawing> {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  let drawing: Drawing;
  if (type === "multipart/form-data") {
    let form: FormData;
    try {
      form = await new Response(bytes, {
        headers: { "content-type": contentType! },
      }).formData();
    } catch {
      throw invalid("The multipart form cannot be read");
    }
    const fields = new Map<string, string>();
    const images: Picture[] = [];
    let mask: Picture | undefined;
    for (const [name, value] of form) {
      if (typeof value === "string") {
        if (!fields.has(name)) fields.set(name, value.trim());
        continue;
      }
      const picture: Picture = {
        mime: value.type || "image/png",
        data: Buffer.from(await value.arrayBuffer()),
        name: value.name,
      };
      if (name === "image" || name === "image[]") images.push(picture);
      else if (name === "mask") mask ??= picture;
    }
    const n = fields.get("n");
    drawing = {
      model: fields.get("model") ?? "",
      prompt: fields.get("prompt") ?? "",
      n: n === undefined || n === "" ? 1 : Number(n),
      stream: fields.get("stream") === "true",
      fields,
      ...(fields.get("size") ? { size: fields.get("size")! } : {}),
      ...(fields.get("background")
        ? { background: fields.get("background")! }
        : {}),
      images,
      ...(mask ? { mask } : {}),
    };
  } else {
    let raw: Record<string, unknown>;
    try {
      raw = object(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw invalid("The request body is not a JSON object");
    }
    const masks = imageSources(raw.mask);
    drawing = {
      model: typeof raw.model === "string" ? raw.model.trim() : "",
      prompt: typeof raw.prompt === "string" ? raw.prompt : "",
      n: raw.n === undefined || raw.n === null ? 1 : Number(raw.n),
      stream: raw.stream === true,
      json: raw,
      fields: new Map(),
      ...(typeof raw.size === "string" ? { size: raw.size } : {}),
      ...(typeof raw.background === "string"
        ? { background: raw.background }
        : {}),
      images: [...imageSources(raw.image), ...imageSources(raw.images)].map(
        pictureOf,
      ),
      ...(masks.length ? { mask: pictureOf(masks[0]!) } : {}),
    };
  }
  if (!drawing.prompt.trim()) throw invalid("Say what to draw in prompt");
  if (!Number.isSafeInteger(drawing.n) || drawing.n < 1)
    throw invalid("n is a positive integer");
  return drawing;
}

function dataUrl(picture: Picture): string {
  return (
    picture.url ??
    `data:${picture.mime};base64,${(picture.data ?? Buffer.alloc(0)).toString("base64")}`
  );
}

function extension(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".png";
  }
}

/** `1536x1024` as `3:2`; undefined for no size or `auto`. */
export function aspectOf(size: string | undefined): string | undefined {
  const match = /^(\d+)x(\d+)$/.exec(size ?? "");
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return undefined;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

/** The prompt with what an images API takes as parameters said in words, for a chat model. */
function chatPrompt(drawing: Drawing): string {
  const aspect = aspectOf(drawing.size);
  return `${drawing.prompt}${aspect ? `\n\nAspect ratio: ${aspect}.` : ""}${drawing.background === "transparent" ? " Transparent background." : ""}`;
}

/** The images, text and usage of a chat answer that drew. */
export function chatPictures(value: unknown): {
  images: string[];
  text: string;
  usage: UsageParts;
} {
  const answer = record(value);
  const usage = record(answer?.usage);
  const tokens = (field: unknown) =>
    typeof field === "number" && field >= 0 ? Math.round(field) : undefined;
  const input = tokens(usage?.prompt_tokens);
  const output = tokens(usage?.completion_tokens);
  const parts: UsageParts = {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
  const choices = Array.isArray(answer?.choices) ? answer.choices : [];
  const message = record(record(choices[0])?.message);
  const images: string[] = [];
  let text = "";
  for (const item of Array.isArray(message?.images) ? message.images : [])
    images.push(...imageSources(record(item)?.image_url));
  // AIHubMix's Gemini answers with Gemini's own parts.
  for (const item of Array.isArray(message?.multi_mod_content)
    ? message.multi_mod_content
    : []) {
    const inline = record(record(item)?.inline_data);
    if (typeof inline?.data === "string" && inline.data)
      images.push(
        `data:${typeof inline.mime_type === "string" ? inline.mime_type : "image/png"};base64,${inline.data}`,
      );
  }
  const content = message?.content;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content))
    for (const part of content) {
      const item = record(part);
      if (typeof item?.text === "string") text += item.text;
      if (item?.image_url !== undefined)
        images.push(...imageSources(item.image_url));
    }
  // A model that puts the image in its text, as markdown.
  if (!images.length)
    for (const match of text.matchAll(/\((data:image\/[^)\s]+)\)/g))
      images.push(match[1]!);
  return { images, text: text.trim(), usage: parts };
}

type Via = "images" | "chat";

/** A provider's ways to draw, the one it is asked on first. */
function ways(provider: ProviderConfig, drawing: Drawing): Via[] {
  const chat =
    provider.endpoints.chat !== undefined && drawing.n <= CHAT_DRAWINGS;
  if (provider.imageEndpoint) return chat ? ["images", "chat"] : ["images"];
  return chat ? ["chat"] : [];
}

/** The candidates of an images request: providers that can draw, in order. */
async function candidates(
  services: CallServices,
  requested: string,
  drawing: Drawing,
): Promise<Candidate[]> {
  const parsed = parseModelRef(requested);
  if (!parsed) return [];
  let refs: { provider: string; model: string; ref: ModelRef }[];
  if (parsed.kind === "model")
    refs = [
      { provider: parsed.provider, model: parsed.model, ref: parsed.ref },
    ];
  else {
    const groups = new Map(
      (await services.store.listRouteGroups()).map((group) => [
        group.id,
        group,
      ]),
    );
    const group = groups.get(parsed.group);
    refs = group
      ? groupModels(group, (id: RouteGroupId) => groups.get(id))
      : [];
  }
  const found: Candidate[] = [];
  for (const { provider: id, model, ref } of refs) {
    const provider = await services.store.getProvider(
      id as ProviderConfig["id"],
    );
    // Subscription accounts serve model calls only; one switched off nothing.
    if (
      !provider ||
      !providerEnabled(provider) ||
      provider.subscription ||
      !ways(provider, drawing).length
    )
      continue;
    const credentials = provider.credentials.length
      ? provider.credentials.filter((credential) => credential.enabled)
      : [KEYLESS_CREDENTIAL];
    for (const credential of credentials)
      found.push({
        provider,
        credential,
        model: provider.models.list.find((entry) => entry.id === model),
        ref,
        wireModel: wireName(provider, model),
        mode: "passthrough",
        upstream: "chat",
        endpoint: provider.imageEndpoint ?? provider.endpoints.chat!,
      });
  }
  return found;
}

/** What one way of asking gave. */
type Outcome =
  | { kind: "answer"; answer: Response }
  | {
      kind: "drawn";
      images: string[];
      text: string;
      usage: UsageParts;
    }
  | { kind: "failed"; status: number; text: string }
  | { kind: "unreachable" };

/**
 * Serve one `/v1/images/generations` or `/v1/images/edits` call; `entry` is
 * committed exactly once, before the answer's last bytes.
 */
export async function imagesCall(options: {
  services: CallServices;
  request: IncomingMessage;
  response: ServerResponse;
  key: GatewayKeyRecord;
  entry: ModelCallEntry;
  started: number;
  signal: AbortSignal;
  edit: boolean;
}): Promise<void> {
  const { services, request, response, key, entry, signal, edit } = options;
  const { limits } = services;
  const path = edit ? "/v1/images/edits" : "/v1/images/generations";
  entry.inbound = { protocol: "chat", path, stream: false };
  const fail = async (
    status: number,
    code: string,
    message: string,
    refusal?: QuotaRefusal,
  ) => {
    entry.status = status;
    entry.errorClass = code;
    entry.errorSource = "gateway";
    entry.error = message.slice(0, 500);
    entry.timing.durationMs = Math.round(performance.now() - options.started);
    await services.commit(entry);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const answer = errorResponse("chat", failure(status, code, message));
    response.writeHead(answer.status, {
      "content-type": "application/json",
      ...(refusal
        ? {
            "retry-after": String(
              Math.max(1, Math.ceil(refusal.retryAfterMs / 1000)),
            ),
            "x-should-retry": "false",
            ...(refusal.resetsAt
              ? { "x-hh-limit-reset": refusal.resetsAt }
              : {}),
          }
        : {}),
    });
    response.end(JSON.stringify(answer.body));
  };
  let reserved = 0;
  let release = () => {};
  try {
    const bytes = await readBody(request, {
      maxBytes: limits.maxRequestBytes,
      timeoutMs: limits.requestBodyTimeoutMs,
      signal,
      memory: services.memory,
    });
    reserved = bytes.length;
    const drawing = await readDrawing(bytes, request.headers["content-type"]);
    entry.inbound.stream = drawing.stream;
    const given = drawing.model;
    if (given) entry.requestedModel = redactKeyText(given).slice(0, 256);
    if (edit && !drawing.images.length)
      return fail(400, "invalid_request", "An edit needs the image to edit");
    if (!given)
      return fail(
        400,
        "model_invalid",
        "The model must be a Model Ref (provider/model), group/<id> or a model's name",
      );
    let requested: string;
    try {
      // A bare name is what it resolves to; the allowlist applies to that.
      const resolution = await services.resolveModel(given, key);
      requested = resolution.ref;
      if (resolution.standIn) entry.patches.push("stand-in");
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      return fail(error.status, error.code, error.message);
    }
    if (!modelAllowed(key.modelAllow, requested, key.modelDeny))
      return fail(
        403,
        "model_not_allowed",
        `This Gateway Key may not use ${requested.slice(0, 200)}${requested !== given ? ` (what ${given.slice(0, 100)} names here)` : ""}`,
      );
    const admission = await services.quotas.admit(key, {
      bytes: bytes.length,
    });
    if (!admission.ok)
      return fail(
        429,
        "quota_exceeded",
        admission.refusal.message,
        admission.refusal,
      );
    release = admission.release;
    const planned = await candidates(services, requested, drawing);
    // A model the key hides is not reached through a group either (M4).
    const queue = planned.filter(
      (candidate) => !hiddenBy(key.modelDeny, candidate.ref, candidate.path),
    );
    if (planned.length && !queue.length)
      return requested !== given
        ? fail(
            404,
            "model_not_found",
            `No route group or model is named ${given.slice(0, 200)}; name one as provider/model or group/<id>`,
          )
        : fail(
            403,
            "model_not_allowed",
            `This Gateway Key may not use any model of ${requested.slice(0, 200)}`,
          );
    if (!queue.length)
      return fail(
        404,
        "images_unavailable",
        `No provider of ${requested.slice(0, 200)} that is switched on declares an images endpoint, or a Chat endpoint to draw at most ${CHAT_DRAWINGS} images through`,
      );
    const settings = services.features().redaction;
    let masked = 0;
    const redacted = <T>(value: T): T => {
      if (!settings.enabled) return value;
      const result = services.redactor.maskJson(value, settings.rules);
      masked += result.count;
      return result.value as T;
    };
    let last: { status: number; text: string } | undefined;
    for (const candidate of queue) {
      if (signal.aborted)
        return fail(499, "client_cancelled", "The call was cancelled");
      const admitted = services.breakers.admit(candidate, key.keyId);
      if (!admitted.ok) continue;
      entry.provider = candidate.provider.id;
      entry.credentialId = candidate.credential.id;
      entry.modelRef = candidate.ref;
      entry.wireModel = candidate.wireModel;
      entry.upstreamProtocol = "chat";
      entry.mode = "passthrough";
      const slots = services.slots(candidate);
      const attempt = (): CallAttempt => {
        const made: CallAttempt = {
          provider: candidate.provider.id,
          credentialId: candidate.credential.id,
          modelRef: candidate.ref,
          wireModel: candidate.wireModel,
          upstreamProtocol: "chat",
          startedAt: new Date(services.clock()).toISOString(),
          decision: "stop",
        };
        entry.attempts.push(made);
        return made;
      };
      let current = attempt();
      // Each upstream request's 5-minute deadline, cleared when the attempt ends.
      const deadlines: { dispose(): void }[] = [];
      try {
        await slots.acquire(signal, key.keyId);
      } catch {
        services.breakers.release(candidate);
        current.decision = "failover";
        current.errorClass = "busy";
        continue;
      }
      try {
        let secret = "";
        if (candidate.credential !== KEYLESS_CREDENTIAL) {
          try {
            secret = await services.resolveSecret(candidate.credential.ref);
          } catch {
            services.breakers.release(candidate);
            current.decision = "failover";
            current.errorClass = "credential_unavailable";
            continue;
          }
          services.redactor.remember(secret, "PROVIDER_KEY");
        }
        // Each attempt's own patches, after how the model was named.
        entry.patches = entry.patches.filter((patch) => patch === "stand-in");
        masked = 0;
        const ask = async (via: Via): Promise<Outcome> => {
          const base =
            via === "images"
              ? candidate.provider.imageEndpoint!
              : candidate.provider.endpoints.chat!;
          const url = new URL(
            `${base.replace(/\/+$/, "")}${via === "chat" ? "/chat/completions" : edit ? "/images/edits" : "/images/generations"}`,
          );
          const { headers } = upstreamHeaders(
            "chat",
            undefined,
            candidate.provider,
            secret,
            url,
            undefined,
          );
          const post = async (body: string | FormData) => {
            if (typeof body !== "string") headers.delete("content-type");
            const asked = performance.now();
            const timeout = deadline(signal, IMAGE_MS);
            deadlines.push(timeout);
            try {
              const answer = await services.fetch(
                url,
                {
                  method: "POST",
                  redirect: "error",
                  headers,
                  body,
                  signal: timeout.signal,
                },
                providerProxy(candidate.provider),
              );
              current.firstByteMs ??= Math.round(performance.now() - asked);
              current.status = answer.status;
              return answer;
            } catch {
              return undefined;
            }
          };
          const failed = async (answer: Response): Promise<Outcome> => ({
            kind: "failed",
            status: answer.status,
            text: sanitize(await readLimited(answer, 64 * 1024), [secret]),
          });
          if (via === "images") {
            let body: string | FormData;
            if (drawing.json)
              body = JSON.stringify(
                redacted({ ...drawing.json, model: candidate.wireModel }),
              );
            else if (!edit)
              body = JSON.stringify(
                redacted({
                  ...Object.fromEntries(drawing.fields),
                  model: candidate.wireModel,
                  n: drawing.n,
                }),
              );
            else {
              const form = new FormData();
              for (const [name, value] of drawing.fields)
                if (name !== "model")
                  form.append(
                    name,
                    name === "prompt" ? redacted(value) : value,
                  );
              form.set("model", candidate.wireModel);
              const field = drawing.images.length > 1 ? "image[]" : "image";
              drawing.images.forEach((picture, index) =>
                form.append(
                  field,
                  new Blob([picture.data ?? Buffer.alloc(0)], {
                    type: picture.mime,
                  }),
                  picture.name ?? `image${index}${extension(picture.mime)}`,
                ),
              );
              if (drawing.mask)
                form.append(
                  "mask",
                  new Blob([drawing.mask.data ?? Buffer.alloc(0)], {
                    type: drawing.mask.mime,
                  }),
                  drawing.mask.name ?? `mask${extension(drawing.mask.mime)}`,
                );
              body = form;
            }
            const answer = await post(body);
            if (!answer) return { kind: "unreachable" };
            return answer.ok ? { kind: "answer", answer } : failed(answer);
          }
          const content = [
            { type: "text", text: redacted(chatPrompt(drawing)) },
            ...drawing.images.map((picture) => ({
              type: "image_url",
              image_url: { url: dataUrl(picture) },
            })),
          ];
          const aspect = aspectOf(drawing.size);
          const body = JSON.stringify({
            model: candidate.wireModel,
            stream: false,
            modalities: ["image", "text"],
            messages: [{ role: "user", content }],
            ...(aspect ? { image_config: { aspect_ratio: aspect } } : {}),
          });
          const drawn: Extract<Outcome, { kind: "drawn" }> = {
            kind: "drawn",
            images: [],
            text: "",
            usage: {},
          };
          for (let index = 0; index < drawing.n; index++) {
            const answer = await post(body);
            if (!answer) return { kind: "unreachable" };
            if (!answer.ok) return failed(answer);
            let value: unknown;
            try {
              value = JSON.parse(
                await readLimited(answer, limits.maxResponseBytes),
              );
            } catch {
              value = undefined;
            }
            const result = chatPictures(value);
            drawn.images.push(...result.images);
            drawn.text = [drawn.text, result.text].filter(Boolean).join("\n");
            drawn.usage = {
              input: (drawn.usage.input ?? 0) + (result.usage.input ?? 0),
              output: (drawn.usage.output ?? 0) + (result.usage.output ?? 0),
            };
          }
          return drawn;
        };
        const [first, second] = ways(candidate.provider, drawing);
        let outcome = await ask(first!);
        let via = first!;
        if (
          outcome.kind === "failed" &&
          (outcome.status === 404 || outcome.status === 405) &&
          second
        ) {
          // The other way, once, on the same credential (Magpie `draw`).
          current.decision = "retry";
          current.errorClass = "upstream_http_error";
          const firstFailure = outcome;
          current = attempt();
          const other = await ask(second);
          entry.patches.push(`images:${second}-after-${first}`);
          if (other.kind !== "failed") {
            outcome = other;
            via = second;
          } else outcome = firstFailure;
        }
        if (via === "chat") entry.patches.push("images:via-chat");
        if (masked) entry.patches.push(`redact:${masked}`);
        if (outcome.kind === "unreachable") {
          if (signal.aborted)
            return fail(499, "client_cancelled", "The call was cancelled");
          services.breakers.failure(
            candidate,
            { kind: "none" },
            failure(502, "upstream_unreachable", "unreachable"),
            "upstream_unreachable",
            key.keyId,
          );
          current.decision = "failover";
          current.errorClass = "upstream_unreachable";
          continue;
        }
        if (outcome.kind === "failed") {
          const kind = failureKind(outcome.status, outcome.text);
          // The request's own words decide no rest (routing `echoFree`).
          const restKind = failureKind(
            outcome.status,
            echoFree(outcome.text, drawing),
          );
          const error = {
            failure: failure(
              outcome.status,
              "upstream_http_error",
              outcome.text.slice(0, 500),
            ),
            errorClass: "upstream_http_error",
            source: "upstream" as const,
            phase: "response" as const,
            status: outcome.status,
            kind,
            restKind,
          };
          const verdict = classify(error);
          services.breakers.failure(
            candidate,
            verdict.breaker,
            error.failure,
            error.errorClass,
            key.keyId,
          );
          current.errorClass = error.errorClass;
          last = { status: outcome.status, text: outcome.text };
          if (verdict.failover) {
            current.decision = "failover";
            continue;
          }
          break;
        }
        const finish = (usage: UsageParts | undefined) => {
          entry.status = 200;
          entry.usage = callUsage(usage ?? {});
          entry.cost = callCost(entry.usage, candidate.model);
          entry.completion = "explicit";
          entry.timing.durationMs = Math.round(
            performance.now() - options.started,
          );
        };
        if (outcome.kind === "drawn") {
          if (!outcome.images.length) {
            services.breakers.release(candidate);
            last = {
              status: 502,
              text: `${candidate.ref} drew nothing${outcome.text ? `: ${outcome.text.slice(0, 300)}` : ""}`,
            };
            current.decision = "failover";
            current.errorClass = "nothing_drawn";
            continue;
          }
          services.breakers.success(candidate);
          current.decision = "success";
          finish(outcome.usage);
          await services.commit(entry);
          const created = Math.floor(services.clock() / 1000);
          const data = outcome.images.map((source) => {
            const picture = pictureOf(source);
            return picture.url
              ? { url: picture.url }
              : {
                  b64_json: (picture.data ?? Buffer.alloc(0)).toString(
                    "base64",
                  ),
                  mime_type: picture.mime,
                };
          });
          const usage = {
            input_tokens: outcome.usage.input ?? 0,
            output_tokens: outcome.usage.output ?? 0,
            total_tokens:
              (outcome.usage.input ?? 0) + (outcome.usage.output ?? 0),
          };
          if (drawing.stream) {
            // One completed event per image, as an images API streams them.
            const type = edit
              ? "image_edit.completed"
              : "image_generation.completed";
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
            });
            for (const item of data)
              response.write(
                `event: ${type}\ndata: ${JSON.stringify({ type, created_at: created, ...item, usage })}\n\n`,
              );
            response.end();
            return;
          }
          response.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-cache",
          });
          response.end(
            JSON.stringify({
              created,
              data,
              usage,
              ...(outcome.text ? { text: outcome.text } : {}),
            }),
          );
          return;
        }
        services.breakers.success(candidate);
        current.decision = "success";
        const answer = outcome.answer;
        const contentType =
          answer.headers.get("content-type") ?? "application/json";
        if (!/event-stream/i.test(contentType)) {
          const text = await readLimited(answer, limits.maxResponseBytes);
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch {
            value = undefined;
          }
          finish(imageUsage(value));
          await services.commit(entry);
          response.writeHead(200, {
            "content-type": contentType,
            "cache-control": "no-cache",
          });
          response.end(text);
          return;
        }
        // Streamed partial images: forwarded as they come; the completed
        // event's usage is kept for the ledger.
        response.writeHead(200, {
          "content-type": contentType,
          "cache-control": "no-cache",
        });
        let usage: UsageParts | undefined;
        let carry = "";
        const decoder = new TextDecoder();
        let bytesRead = 0;
        if (answer.body)
          for await (const chunk of answer.body) {
            bytesRead += chunk.byteLength;
            if (bytesRead > limits.maxResponseBytes)
              throw new GatewayError(
                "Upstream image response exceeds the gateway size limit",
                502,
                "response_too_large",
              );
            carry += decoder.decode(chunk, { stream: true });
            const events = carry.split(/\n\n/);
            carry = events.pop() ?? "";
            for (const event of events)
              for (const line of event.split("\n"))
                if (line.startsWith("data:")) {
                  try {
                    usage = imageUsage(JSON.parse(line.slice(5))) ?? usage;
                  } catch {
                    // Not JSON: forwarded all the same.
                  }
                }
            await new Promise<void>((resolve, reject) =>
              response.write(chunk, (error) =>
                error ? reject(error) : resolve(),
              ),
            );
          }
        finish(usage);
        await services.commit(entry);
        response.end();
        return;
      } finally {
        for (const timeout of deadlines) timeout.dispose();
        slots.release(key.keyId);
      }
    }
    if (last) {
      entry.status = last.status;
      entry.errorClass = "upstream_http_error";
      entry.errorSource = "upstream";
      entry.error = last.text.slice(0, 500);
      entry.timing.durationMs = Math.round(performance.now() - options.started);
      await services.commit(entry);
      response.writeHead(last.status, { "content-type": "application/json" });
      response.end(
        last.text.trimStart().startsWith("{")
          ? last.text
          : JSON.stringify(
              errorResponse(
                "chat",
                failure(last.status, "upstream_http_error", last.text),
              ).body,
            ),
      );
      return;
    }
    return fail(
      503,
      "no_candidate",
      "No credential of the images provider can serve now",
    );
  } catch (error) {
    if (error instanceof GatewayError)
      return fail(error.status, error.code, error.message);
    throw error;
  } finally {
    release();
    services.memory.give(reserved);
  }
}
