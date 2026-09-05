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
