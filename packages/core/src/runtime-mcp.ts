// SPDX-License-Identifier: MIT
/**
 * An MCP server as configuration preparation hands it to a driver for one
 * Session: a stdio command with its environment, or a remote HTTP/SSE endpoint
 * with its headers. Values may be resolved secrets: drivers pass them to the
 * engine and must not log or persist them. Defined in core so that drivers
 * need not depend on configuration preparation (ADR 0017, V2).
 */
export type RuntimeMcpServer =
  | {
      name: string;
      command: string;
      args: string[];
      env: { name: string; value: string }[];
    }
  | {
      name: string;
      type: "http" | "sse";
      url: string;
      headers: { name: string; value: string }[];
    };
