/** Normalize a cloned JSON Schema projection to OpenAPI 3.0 and actual stream media types.
 * Never mutate shared domain/route schemas: they remain the Ajv validation authority.
 */
export function normalizeOpenApiDocument(document: unknown): void {
  function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const node = record(value);
    if (node && Array.isArray(node.type) && node.type.includes("null")) {
      const nonNull = node.type.filter((type) => type !== "null");
      if (nonNull.length === 1) {
        node.type = nonNull[0];
        node.nullable = true;
      }
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(document);
  const paths = record(record(document)?.paths);
  for (const [url, media] of [
    ["/v1/runs/{id}/events", "text/event-stream"],
    ["/v1/runs/{id}/rollout", "application/x-ndjson"],
    ["/v1/artifacts/{id}", "application/octet-stream"],
  ]) {
    const response = record(
      record(record(record(paths?.[url!])?.get)?.responses)?.["200"],
    );
    if (!response) continue;
    const previous = record(record(response.content)?.["application/json"]);
    response.content = {
      [media!]: { schema: previous?.schema ?? { type: "string" } },
    };
  }
}
