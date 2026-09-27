/** An error with an HTTP status, surfaced to the client verbatim. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}
/** An unavailable backend or malformed upstream reply, mapped to HTTP 502. */
export class BackendError extends Error {
  override name = 'BackendError';
}
