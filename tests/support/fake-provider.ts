// SPDX-License-Identifier: MIT
/**
 * The strict fake upstream provider (tools/fake-provider) for tests. It is an
 * uncompiled repository tool, so it is loaded from the checkout by path, like
 * the compiled entries in entries.ts. The interfaces are the subset of the
 * tool's JSDoc contract that tests use; the tool's modules are the authority.
 */

const TOOL = new URL("../../../tools/fake-provider/", import.meta.url);

/** One request as the provider recorded it; never contains prompts or key values. */
export interface FakeProviderRecord {
  seq: number;
  method: string;
  path: string;
  protocol: "chat" | "responses" | "messages" | "gemini";
  status: number;
  auth: "ok" | "missing" | "invalid" | "not-required";
  keyId: string | null;
  keyFingerprint: string | null;
  model?: string | null;
  stream?: boolean;
  turn?: string;
  reasoningEcho?: boolean | "mismatch";
  violations: { path: string; rule: string; message: string }[];
  aborted?: boolean;
}

export interface FakeProvider {
  /** Origin without a path; OpenAI-style clients use `${url}/v1`. */
  readonly url: string;
  records(after?: number): FakeProviderRecord[];
  violations(): ({
    seq: number;
    protocol: string;
  } & FakeProviderRecord["violations"][number])[];
  /** Resolves once every request received so far has closed and been recorded. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

export interface DecodedAnswer {
  reasoning: string;
  text: string;
  toolCalls: { id?: string; name: string; arguments: string }[];
  finishes: string[];
  usage: unknown;
  error: unknown;
  events: string[];
  done: boolean;
  signature?: string;
}

export type WireProtocol = FakeProviderRecord["protocol"];

interface ProviderModule {
  startFakeProvider(options: Record<string, unknown>): Promise<FakeProvider>;
  credentialFingerprint(value: string): string;
}
interface DecodeModule {
  decodeAnswer(
    protocol: WireProtocol,
    text: string,
    form: { stream: boolean; sse?: boolean },
  ): DecodedAnswer;
}
interface TestingModule {
  shellTools(protocol: WireProtocol): unknown[];
  followUp(
    protocol: WireProtocol,
    body: Record<string, unknown>,
    answer: DecodedAnswer,
  ): Record<string, unknown>;
}

// The tool is plain JavaScript without declarations: `import()` of its URL is
// untyped, and each module is asserted to the members declared above.
const load = async <T>(file: string): Promise<T> =>
  (await import(new URL(file, TOOL).href)) as T;

/** Start a fake provider; options as documented by `startFakeProvider` in the tool. */
export async function startFakeProvider(
  options: Record<string, unknown>,
): Promise<FakeProvider> {
  return (await load<ProviderModule>("index.mjs")).startFakeProvider(options);
}

/** The fingerprint under which records show a presented credential. */
export async function credentialFingerprint(value: string): Promise<string> {
  return (await load<ProviderModule>("index.mjs")).credentialFingerprint(value);
}

/** Decode an answer in one of the four wire protocols. */
export async function decodeAnswer(
  protocol: WireProtocol,
  text: string,
  form: { stream: boolean; sse?: boolean },
): Promise<DecodedAnswer> {
  return (await load<DecodeModule>("decode.mjs")).decodeAnswer(
    protocol,
    text,
    form,
  );
}

/** Native request builders: a `bash` shell tool and the follow-up answering a tool call. */
export async function requestBuilders(): Promise<TestingModule> {
  return load<TestingModule>("testing.mjs");
}
