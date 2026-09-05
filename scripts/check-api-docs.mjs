import { access } from "node:fs/promises";
import path from "node:path";
const methods = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "options",
  "head",
]);
/** Bidirectional route coverage; missing documentation or stale operations fail closed. */
export async function checkApiCatalog(catalog, specification, root) {
  if (!Array.isArray(catalog) || !specification?.paths)
    throw new Error("Missing API catalog or OpenAPI paths");
  if (specification.openapi?.startsWith("3.0")) {
    const verify = (value) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value.type))
        throw new Error(
          "OpenAPI 3.0 requires a scalar type and nullable, not a JSON Schema type array",
        );
      for (const child of Object.values(value)) verify(child);
    };
    verify(specification);
  }
  const expected = new Set(
    Object.entries(specification.paths).flatMap(([url, entries]) =>
      Object.keys(entries)
        .filter((method) => methods.has(method) && method !== "head")
        .map((method) => `${method.toUpperCase()} ${url}`),
    ),
  );
  const seen = new Set(),
    ids = new Set();
  for (const entry of catalog) {
    for (const field of [
      "method",
      "path",
      "title",
      "group",
      "request",
      "response",
      "implementation",
      "effects",
      "errors",
      "source",
      "operationId",
    ])
      if (typeof entry[field] !== "string" || !entry[field].trim())
        throw new Error(`Missing API documentation field: ${field}`);
    const key = `${entry.method} ${entry.path}`;
    if (seen.has(key) || ids.has(entry.operationId))
      throw new Error(`Duplicate documented operation: ${key}`);
    if (!expected.has(key))
      throw new Error(`Stale documented operation: ${key}`);
    const operation =
      specification.paths[entry.path]?.[entry.method.toLowerCase()];
    if (
      !operation?.responses ||
      !Object.keys(operation.responses).some((code) => /^2\d\d$/.test(code))
    )
      throw new Error(`Missing success response schema: ${key}`);
    if (!Array.isArray(entry.tests) || !entry.tests.length)
      throw new Error(`Missing test pointer: ${key}`);
    for (const filename of [entry.source, ...entry.tests]) {
      const absolute = path.resolve(root, filename),
        relative = path.relative(root, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Source link escapes repository");
      await access(absolute);
    }
    seen.add(key);
    ids.add(entry.operationId);
  }
  const missing = [...expected].filter((key) => !seen.has(key));
  if (missing.length)
    throw new Error(`Undocumented operations: ${missing.join(", ")}`);
  return seen.size;
}
