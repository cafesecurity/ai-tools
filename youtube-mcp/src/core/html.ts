// The only HTML this server sends: the consent page and plain message pages.
// Every value that reaches a page is escaped, pages carry no script, and the
// Content-Security-Policy forbids scripts, framing and posting the form anywhere
// but here, Google and the approved client redirect origins.

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
body{font:16px/1.5 system-ui,sans-serif;background:#0E2A4E;color:#eef2f7;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{background:#fff;color:#14213d;max-width:30rem;width:calc(100% - 2rem);border-radius:12px;padding:1.75rem}
h1{font-size:1.3rem;margin:0 0 1rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.35rem 1rem;margin:0 0 1rem}
dt{font-weight:600}dd{margin:0;word-break:break-all}
.warn{background:#fff4e0;border-left:4px solid #e0a100;padding:.6rem .8rem;margin:0 0 1rem}
.note{color:#4a5568;font-size:.9rem}
.actions{display:flex;gap:.75rem;margin-top:1.25rem}
button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:1px solid #14213d;cursor:pointer}
button.primary{background:#14213d;color:#fff}
button.secondary{background:#fff;color:#14213d}
`;

export function pageCsp(formActions: string[]): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `form-action ${formActions.join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function htmlResponse(html: string, status: number, csp: string, extra?: Headers): Response {
  const headers = new Headers(extra);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Content-Security-Policy', csp);
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cache-Control', 'no-store');
  return new Response(html, { status, headers });
}

export interface ConsentView {
  clientName: string;
  clientDomain?: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
  handle: string;
}

export function consentPage(view: ConsentView): string {
  const who = view.clientDomain
    ? `<dt>App</dt><dd>${escapeHtml(view.clientName)}</dd><dt>Verified domain</dt><dd>${escapeHtml(view.clientDomain)}</dd>`
    : `<dt>App (self-named)</dt><dd>${escapeHtml(view.clientName)}</dd>`;
  const loopback = view.redirectIsLoopback
    ? '<p class="warn">This app runs on this computer. Any program on this computer could be listening at that address, whatever name it gives. Only continue if you started it yourself.</p>'
    : '';
  return page(
    'Allow read-only access?',
    `<h1>Allow this app to read your YouTube analytics?</h1>
<dl>${who}<dt>Sends you back to</dt><dd>${escapeHtml(view.redirectHost)}</dd></dl>
${loopback}
<p>It will be able to <strong>read</strong> your channel's statistics, analytics and (if the owner turned them on) recent comments. It cannot upload, edit, delete or post anything.</p>
<p class="note">Next you'll sign in with Google. Only accounts on this server's allowlist are accepted. This approval isn't remembered: you'll see this page every time.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(view.handle)}">
<div class="actions"><button class="primary" type="submit" name="decision" value="approve">Continue to Google</button><button class="secondary" type="submit" name="decision" value="deny">Cancel</button></div>
</form>`,
  );
}

export function messagePage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
