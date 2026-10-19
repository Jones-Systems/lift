export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
}

export function safeHref(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\s\\\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('Unsafe link');
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)) throw new TypeError('Unsafe link');
  if (/^\/(?!\/)/.test(value) || /^#[a-zA-Z][\w-]*$/.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Unsafe link'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Unsafe link');
  return url.href;
}

export function page(title, body, options = {}) {
  const description = options.description ?? 'Form is developing a more personal approach to strength and movement. Explore the concept and an interactive preview.';
  const scripts = [...new Set(['/assets/site.mjs', ...(options.scripts ?? [])])];
  const styles = [...new Set(['/assets/site.css', ...(options.styles ?? [])])];
  const active = options.active ?? '';
  const nav = [['/use-cases/', 'Use cases', 'use-cases'], ['/journal/', 'Journal', 'journal'], ['/account/', 'Account', 'account']];
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${escapeHtml(description)}"><meta name="theme-color" content="#f3f1e8"><title>${escapeHtml(title)} · Form</title>${styles.map(src => `<link rel="stylesheet" href="${escapeHtml(safeHref(src))}">`).join('')}</head><body${options.bodyClass ? ` class="${escapeHtml(options.bodyClass)}"` : ''}><a class="skip-link" href="#main">Skip to content</a><header class="site-header container"><a class="wordmark" href="/" aria-label="Form home">form<span aria-hidden="true">↗︎</span></a><nav aria-label="Main navigation">${nav.map(([href,label,key]) => `<a href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav><span class="status"><span aria-hidden="true"></span> In development</span></header><main id="main">${body}</main><footer class="site-footer container"><div><a class="wordmark" href="/">form<span aria-hidden="true">↗︎</span></a><p>A little more you.<br>A little more movement.</p></div><nav aria-label="Footer navigation"><a href="/use-cases/">Explore Form</a><a href="/journal/">Journal</a><a href="/editorial/">Editorial approach</a><a href="/privacy/">Privacy</a><a href="/account/">Account &amp; availability</a></nav><p class="footer-note">Form is in development. Preview screens illustrate intended features, not an available personalized service. No clinical outcomes are promised.</p></footer>${scripts.map(src => `<script type="module" src="${escapeHtml(safeHref(src))}"></script>`).join('')}</body></html>`;
}

export async function registerSourceTests() {
  const { test } = await import('node:test');
  const { default: assert } = await import('node:assert/strict');
  test('shell escapes untrusted title, metadata and class values', () => {
    assert.equal(escapeHtml(`<a title="x">&'</a>`), '&lt;a title=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    const html = page('<script>alert(1)</script>', '<p>Trusted body</p>', {description:'" onload="bad',bodyClass:'" onclick="bad'});
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('content="" onload='));
    assert.ok(!html.includes('class="" onclick='));
    assert.ok(html.includes('<p>Trusted body</p>'));
  });
  test('shell rejects executable, ambiguous and credential-bearing URLs', () => {
    for (const url of ['javascript:alert(1)','data:text/html,test','//evil.example','/\\evil.example',' /account/','/a\n','/a%0a','https://user:password@example.com/','vbscript:test']) assert.throws(() => safeHref(url), TypeError);
    assert.equal(safeHref('/account/'), '/account/');
    assert.equal(safeHref('#preview'), '#preview');
    assert.equal(safeHref('https://example.com/source'), 'https://example.com/source');
    assert.throws(() => page('Title','',{scripts:['javascript:alert(1)']}), TypeError);
  });
  test('shell provides shared assets and accessible landmark navigation', () => {
    const html = page('Title','',{active:'journal',scripts:['/assets/account.mjs','/assets/site.mjs']});
    assert.equal((html.match(/src="\/assets\/site.mjs"/g) ?? []).length, 1);
    assert.ok(html.includes('href="/assets/site.css"'));
    assert.ok(html.includes('href="#main"'));
    assert.ok(html.includes('<main id="main">'));
    assert.ok(html.includes('href="/journal/" aria-current="page"'));
    assert.ok(!/<script(?![^>]*src=)/.test(html));
  });
}
