// VS Code host: rewrites web/static/index.html for a VS Code Webview with strict CSP and resource URIs (R-26, ADR 0021).

export interface WebviewHtmlOptions {
  readonly indexHtml: string;
  readonly cspSource: string;
  readonly toUri: (relativePath: string) => string;
}

const HEAD_TAG = /<head(\s[^>]*)?>/i;
const ASSET_ATTR = /\b(href|src)="([^"]+)"/g;

/**
 * Injects a strict Content-Security-Policy meta tag and rewrites relative asset `href`/`src` attributes to Webview URIs.
 */
export function buildWebviewHtml(options: WebviewHtmlOptions): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource}; script-src ${options.cspSource}; img-src ${options.cspSource};" />`;
  const withCsp = options.indexHtml.replace(HEAD_TAG, (match) => `${match}\n    ${csp}`);
  return withCsp.replace(ASSET_ATTR, (full, attr: string, target: string) => {
    if (/^(?:[a-z]+:|#|\/\/)/i.test(target)) return full;
    return `${attr}="${options.toUri(target)}"`;
  });
}
