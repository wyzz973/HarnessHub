// SPDX-License-Identifier: MIT
/**
 * Field checks of the fake provider: walk a request body by protocol and
 * report every field outside the whitelist (whitelist mode) or on the
 * blacklist (blacklist mode), with its path, for example `messages[2].foo`.
 * Required-field and structure rules live with each protocol module.
 */
import { clip, isObject } from "./common.mjs";

/**
 * One rejected detail of a request. `rule` is `unknown` (not declared, in
 * whitelist mode), `forbidden` (blacklisted), `role`, `required`, `type`,
 * `structure`, `stream`, `model` or `reasoning`. `message` describes the
 * problem without repeating the path (for `forbidden`, the reason) and names
 * fields and short values only, never prompt text.
 *
 * @typedef {{path: string, rule: string, message: string}} Violation
 */

/** Join an object path and a key. */
export function joinPath(path, key) {
  return path ? `${path}.${clip(key)}` : clip(key);
}

function eachObject(list, path, visit) {
  if (!Array.isArray(list)) return;
  list.forEach((value, index) => {
    if (isObject(value)) visit(value, `${path}[${index}]`);
  });
}

/** First present key among spellings (Gemini accepts camelCase and snake_case). */
function pick(object, ...keys) {
  const key = keys.find((name) => Object.hasOwn(object, name));
  return key === undefined ? [undefined, keys[0]] : [object[key], key];
}

/** Per protocol: call `visit(scope, object, path)` for every checked object of a body. */
const WALKERS = {
  chat(body, visit) {
    visit("topLevel", body, "");
    eachObject(body.messages, "messages", (message, path) => {
      visit("message", message, path);
      eachObject(message.content, `${path}.content`, (part, at) =>
        visit("contentPart", part, at),
      );
    });
    eachObject(body.tools, "tools", (tool, path) => {
      visit("tool", tool, path);
      if (isObject(tool.function))
        visit("toolFunction", tool.function, `${path}.function`);
    });
  },
  responses(body, visit) {
    visit("topLevel", body, "");
    eachObject(body.input, "input", (item, path) => {
      visit("message", item, path);
      eachObject(item.content, `${path}.content`, (part, at) =>
        visit("contentPart", part, at),
      );
    });
    eachObject(body.tools, "tools", (tool, path) => visit("tool", tool, path));
  },
  messages(body, visit, { countTokens }) {
    visit(countTokens ? "countTokens" : "topLevel", body, "");
    eachObject(body.system, "system", (part, path) =>
      visit("contentPart", part, path),
    );
    eachObject(body.messages, "messages", (message, path) => {
      visit("message", message, path);
      eachObject(message.content, `${path}.content`, (part, at) =>
        visit("contentPart", part, at),
      );
    });
    eachObject(body.tools, "tools", (tool, path) => visit("tool", tool, path));
  },
  gemini(body, visit) {
    visit("topLevel", body, "");
    const content = (value, path) => {
      visit("message", value, path);
      const [parts, key] = pick(value, "parts");
      eachObject(parts, joinPath(path, key), (part, at) =>
        visit("contentPart", part, at),
      );
    };
    eachObject(body.contents, "contents", content);
    const [system, systemKey] = pick(
      body,
      "systemInstruction",
      "system_instruction",
    );
    if (isObject(system)) content(system, systemKey);
    eachObject(body.tools, "tools", (tool, path) => {
      visit("tool", tool, path);
      const [declarations, key] = pick(
        tool,
        "functionDeclarations",
        "function_declarations",
      );
      eachObject(declarations, joinPath(path, key), (declaration, at) =>
        visit("functionDeclaration", declaration, at),
      );
    });
    const [config, configKey] = pick(
      body,
      "generationConfig",
      "generation_config",
    );
    if (isObject(config)) visit("generationConfig", config, configKey);
  },
};

const camel = (name) =>
  name.replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase());

/**
 * Field and role violations of a parsed request body.
 *
 * @param {"chat" | "responses" | "messages" | "gemini"} protocol
 * @param {Record<string, unknown>} body A JSON object (checked by the caller).
 * @param {ReturnType<typeof import("./fields.mjs").resolveFields>[string]} fields
 * @param {"blacklist" | "whitelist"} mode
 * @param {{countTokens?: boolean}} [route] `countTokens` checks the body as a
 *   Messages count_tokens request.
 * @returns {Violation[]} In body order; empty when every field is accepted.
 */
export function fieldViolations(protocol, body, fields, mode, route = {}) {
  const violations = [];
  const snake = protocol === "gemini";
  const forbiddenIn = (scope) =>
    scope === "countTokens"
      ? new Map([...fields.forbidden.topLevel, ...fields.forbidden.countTokens])
      : fields.forbidden[scope];
  const visit = (scope, object, path) => {
    for (const key of Object.keys(object)) {
      const at = joinPath(path, key);
      if (mode === "whitelist") {
        const declared = fields.declared[scope];
        if (!declared.has(key) && !(snake && declared.has(camel(key))))
          violations.push({
            path: at,
            rule: "unknown",
            message: `not a declared ${protocol} field`,
          });
      } else {
        const reason = forbiddenIn(scope).get(key);
        if (reason !== undefined)
          violations.push({ path: at, rule: "forbidden", message: reason });
      }
    }
    if (scope !== "message" || typeof object.role !== "string") return;
    const at = joinPath(path, "role");
    const role = clip(object.role, 32);
    if (mode === "whitelist") {
      if (!fields.declared.role.has(object.role))
        violations.push({
          path: at,
          rule: "role",
          message: `role ${role} is not a declared ${protocol} role`,
        });
    } else {
      const reason = fields.forbidden.role.get(object.role);
      if (reason !== undefined)
        violations.push({
          path: at,
          rule: "role",
          message: `role ${role} is ${reason}`,
        });
    }
  };
  WALKERS[protocol](body, visit, { countTokens: route.countTokens === true });
  return violations;
}
