// SPDX-License-Identifier: MIT
/**
 * Same-origin, loopback-only transport. The Gateway remains the execution/state owner.
 * `/api/v1` requests get the daemon's admin token here, on the server: it is read
 * from `$HARNESSHUB_DATA_DIR/admin.token` for every request and never sent to the
 * browser. Other roots are forwarded without credentials.
 */
import { readAdminToken } from "@harnesshub/sdk/local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/;
const allowedRoot = new Set(["v1", "health", "openapi.json", "api"]);

/** `/api/v1` failures of the proxy itself use the API's problem format. */
function failure(api: boolean, status: number, code: string, message: string) {
  if (!api) return Response.json({ error: { code, message } }, { status });
  return new Response(
    JSON.stringify({
      type: `https://harnesshub.dev/problems/${code.toLowerCase().replaceAll("_", "-")}`,
      title: message,
      status,
      detail: message,
      code,
      requestId: "console-proxy",
    }),
    {
      status,
      headers: { "content-type": "application/problem+json; charset=utf-8" },
    },
  );
}
const responseHeaders = [
  "content-type",
  "content-disposition",
  "x-content-sha256",
  "x-content-type-options",
  "content-security-policy",
];

async function proxy(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const segments = (await context.params).path;
  const api = segments[0] === "api";
  const host = request.headers.get("host") ?? new URL(request.url).host;
  const origin = request.headers.get("origin");
  if (
    !localHost.test(host) ||
    (origin !== null && origin !== `http://${host}`) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return failure(
      api,
      403,
      "LOCAL_ACCESS_REQUIRED",
      "控制台只接受本机同源请求",
    );
  if (
    !segments.length ||
    !allowedRoot.has(segments[0]!) ||
    (api && segments[1] !== "v1") ||
    segments.some(
      (p) => !p || p === "." || p === ".." || /[\\/?#\u0000]/.test(p),
    )
  )
    return failure(api, 400, "INVALID_GATEWAY_PATH", "无效接口路径");
  const configured =
    process.env.HARNESSHUB_GATEWAY_URL ?? "http://127.0.0.1:3182";
  let target: URL;
  try {
    target = new URL(configured);
    if (
      target.protocol !== "http:" ||
      !localHost.test(target.host) ||
      target.username ||
      target.password ||
      target.pathname !== "/"
    )
      throw new Error("Invalid local upstream");
  } catch {
    return failure(
      api,
      503,
      "INVALID_GATEWAY_CONFIG",
      "后端地址必须是本机 HTTP 服务",
    );
  }
  target.pathname = `/${segments.map(encodeURIComponent).join("/")}`;
  target.search = new URL(request.url).search;
  const headers = new Headers();
  for (const name of [
    "content-type",
    "accept",
    "idempotency-key",
    "last-event-id",
  ]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (api) {
    const dataDir = process.env.HARNESSHUB_DATA_DIR;
    if (!dataDir)
      return failure(
        true,
        503,
        "ADMIN_TOKEN_UNAVAILABLE",
        "控制台未配置 HARNESSHUB_DATA_DIR，无法读取守护进程的管理令牌",
      );
    try {
      headers.set("authorization", `Bearer ${await readAdminToken(dataDir)}`);
    } catch {
      // The reason names the token file; the browser only learns that it is unusable.
      return failure(
        true,
        503,
        "ADMIN_TOKEN_UNAVAILABLE",
        "无法读取守护进程的管理令牌，请确认 HARNESSHUB_DATA_DIR 指向正在运行的守护进程的数据目录",
      );
    }
  }
  const upstreamAbort = new AbortController();
  const signal = AbortSignal.any([request.signal, upstreamAbort.signal]);
  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      signal,
      cache: "no-store",
      redirect: "error",
      ...(["GET", "HEAD"].includes(request.method)
        ? {}
        : { body: await request.arrayBuffer() }),
    });
    const outgoing = new Headers({
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    for (const name of responseHeaders) {
      const value = response.headers.get(name);
      if (value !== null) outgoing.set(name, value);
    }
    if (!response.body)
      return new Response(null, { status: response.status, headers: outgoing });
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            reader.releaseLock();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
          upstreamAbort.abort();
        }
      },
      async cancel(reason) {
        upstreamAbort.abort(reason);
        await reader.cancel(reason).catch(() => undefined);
      },
    });
    return new Response(stream, { status: response.status, headers: outgoing });
  } catch {
    upstreamAbort.abort();
    return failure(
      api,
      503,
      "GATEWAY_UNAVAILABLE",
      "暂时无法连接执行服务，请确认 Gateway 已启动",
    );
  }
}
export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
  proxy as HEAD,
};
