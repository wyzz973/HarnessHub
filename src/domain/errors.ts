/** A safe public error whose detail can cross the HTTP boundary. */
export class HubError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "HubError";
  }
}

/**
 * Run failures whose engine backend stayed healthy: the model gateway saw an
 * upstream error, or the engine ended the turn without calling the model or
 * producing output (ADR 0013). The Session keeps its Worker for the next Run.
 */
export const modelRunFailureCodes: ReadonlySet<string> = new Set([
  "MODEL_UPSTREAM_ERROR",
  "ENGINE_NO_OUTPUT",
]);
