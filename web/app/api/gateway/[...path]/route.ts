/** Same-origin, loopback-only transport. The Gateway remains the execution/state owner. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/;
const allowedRoot = new Set(["v1", "health", "openapi.json"]);
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
  const host = request.headers.get("host") ?? new URL(request.url).host;
  const origin = request.headers.get("origin");
  if (
    !localHost.test(host) ||
    (origin !== null && origin !== `http://${host}`) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return Response.json(
      {
        error: {
          code: "LOCAL_ACCESS_REQUIRED",
          message: "控制台只接受本机同源请求",
        },
      },
      { status: 403 },
    );
  const segments = (await context.params).path;
  if (
    !segments.length ||
    !allowedRoot.has(segments[0]!) ||
    segments.some(
      (p) => !p || p === "." || p === ".." || /[\\/?#\u0000]/.test(p),
    )
  )
    return Response.json(
      { error: { code: "INVALID_GATEWAY_PATH", message: "无效接口路径" } },
      { status: 400 },
    );
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
    return Response.json(
      {
        error: {
          code: "INVALID_GATEWAY_CONFIG",
          message: "后端地址必须是本机 HTTP 服务",
        },
      },
      { status: 503 },
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
    return Response.json(
      {
        error: {
          code: "GATEWAY_UNAVAILABLE",
          message: "暂时无法连接执行服务，请确认 Gateway 已启动",
        },
      },
      { status: 503 },
    );
  }
}
export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as DELETE,
  proxy as HEAD,
};
