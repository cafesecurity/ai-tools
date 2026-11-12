// Outbound HTTP to Google: fixed hosts, redirects refused, a timeout, and a size cap
// on what we read back. Platform-neutral (uses only fetch and web streams).

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 2_000_000;

const ALLOWED_HOSTS = new Set([
  'accounts.google.com',
  'oauth2.googleapis.com',
  'openidconnect.googleapis.com',
  'www.googleapis.com',
  'youtubeanalytics.googleapis.com',
]);

export class UpstreamError extends Error {
  constructor(
    readonly kind: 'auth' | 'forbidden' | 'quota' | 'not_found' | 'bad_request' | 'unavailable',
    message: string,
    readonly status = 0,
    readonly detail = '',
  ) {
    super(message);
  }
}

export async function callGoogle(fetchImpl: FetchLike, url: URL, init: RequestInit = {}): Promise<{ status: number; json: unknown }> {
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new UpstreamError('bad_request', 'Refused to call an unexpected host.');
  }
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      ...init,
      redirect: 'manual', // never follow: a redirect from Google's APIs is unexpected (Workers has no 'error' mode)
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new UpstreamError('unavailable', 'Google could not be reached. Try again shortly.');
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new UpstreamError('unavailable', 'Google answered with an unexpected redirect.');
  }
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > MAX_RESPONSE_BYTES) throw new UpstreamError('unavailable', 'Google sent an unexpectedly large response.');
  const text = await readCapped(response, MAX_RESPONSE_BYTES);
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

/** Reads a body, stopping as soon as it passes the cap (the Content-Length header can be absent or wrong). */
async function readCapped(response: Response, cap: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new UpstreamError('unavailable', 'Google sent an unexpectedly large response.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Pulls a short, harmless message out of a Google error body (for 400s only, so the model can fix its query). */
export function googleErrorMessage(json: unknown): string {
  const message = (json as { error?: { message?: unknown } } | null)?.error?.message;
  if (typeof message !== 'string') return '';
  return message.replace(/[^\w\s.,:;'"()/=-]/g, '').slice(0, 200);
}

export function googleErrorReason(json: unknown): string {
  const errors = (json as { error?: { errors?: Array<{ reason?: unknown }> } } | null)?.error?.errors;
  const reason = Array.isArray(errors) ? errors[0]?.reason : undefined;
  return typeof reason === 'string' ? reason : '';
}
