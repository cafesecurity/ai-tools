// Security-relevant events, logged without secrets or personal data: no tokens,
// codes, emails, names, analytics or comment text. Only an event name, a short
// fixed reason, and small numbers.

export type LogEvent =
  | 'config_invalid'
  | 'client_registration_refused'
  | 'authorize_refused'
  | 'consent_denied'
  | 'signin_refused'
  | 'signin_completed'
  | 'google_refresh_failed'
  | 'mcp_refused'
  | 'rate_limited'
  | 'tool_error'
  | 'oauth_error';

export function logEvent(event: LogEvent, fields: Record<string, string | number | boolean> = {}): void {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    safe[key] = typeof value === 'string' ? value.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80) : value;
  }
  console.log(JSON.stringify({ event, ...safe }));
}
