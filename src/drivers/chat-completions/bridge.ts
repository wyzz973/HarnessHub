import { startModelGateway } from "./gateway.js";

/** A Session owns this authenticated loopback listener; each Run owns its upstream requests. */
export interface ModelBridge {
  /** Responses: gateway URL with `/v1`; Google: gateway URL without a path. */
  readonly baseUrl: string;
  readonly token: string;
  /** Start exactly one Run scope. An inactive or aborted scope never sends model requests. */
  beginRun(signal: AbortSignal): void;
  /** Abort outstanding requests and await their completion before reusing the Session. */
  endRun(): Promise<void>;
  /** Idempotently stop accepting requests, abort work and await listener shutdown. */
  close(): Promise<void>;
}

/**
 * Compatibility entry for callers that still start a per-adapter bridge.
 * It is a {@link startModelGateway} whose alias is the configured model, so
 * every inbound protocol the gateway supports is available on the same port;
 * `wire` only selects the returned `baseUrl` shape. No upstream request occurs before `beginRun`.
 */
export async function startModelBridge(options: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  wire?: "responses" | "google";
}): Promise<ModelBridge> {
  const gateway = await startModelGateway({
    upstream: {
      protocol: "openai-completions",
      baseUrl: options.baseUrl,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    },
    model: options.model,
    alias: options.model,
  });
  return {
    baseUrl: gateway.baseUrl + (options.wire === "google" ? "" : "/v1"),
    token: gateway.token,
    beginRun: (signal) => gateway.beginRun(signal),
    endRun: () => gateway.endRun(),
    close: () => gateway.close(),
  };
}
