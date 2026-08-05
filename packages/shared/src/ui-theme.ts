/**
 * The one visual theme for every functional browser surface (box root page,
 * box OAuth sign-in). Small on purpose: shadcn's visual language (zinc
 * palette, 8px radius, bordered cards, quiet tables) hand-rolled as one
 * stylesheet over semantic HTML — no Tailwind, no React, no webfonts. The
 * system font stack keeps every surface zero-asset.
 */

/** shadcn-ish tokens + primitives. Served inline in a <style> tag. */
export const UI_CSS = `
  :root {
    --bg: #fff;
    --fg: #09090b;
    --muted: #71717a;
    --border: #e4e4e7;
    --surface: #fafafa;
    --ring: #18181b;
    --green: #16a34a;
    --red: #dc2626;
    --radius: 8px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    padding: 40px 20px;
  }
  main { margin: 0 auto; }
  main.narrow { max-width: 400px; padding-top: 8vh; }
  main.wide { max-width: 1160px; }
  h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
  h2 { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  p { font-size: 14px; }
  small, .muted { font-size: 13px; color: var(--muted); font-weight: 400; }
  a { color: inherit; }
  code, pre {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace;
    font-size: 12.5px;
  }
  pre {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px);
    padding: 10px 12px;
    overflow-x: auto;
  }

  .card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 24px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04);
  }
  .card + .card, .stack > * + * { margin-top: 16px; }
  .card-head { margin-bottom: 16px; }
  .card-head p { margin-top: 4px; }

  label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 6px; }
  input {
    width: 100%;
    height: 36px;
    padding: 0 12px;
    font: inherit;
    font-size: 14px;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px);
    box-shadow: 0 1px 2px rgba(0,0,0,.04);
  }
  input::placeholder { color: var(--muted); }
  input:focus-visible { outline: none; border-color: var(--ring); box-shadow: 0 0 0 3px rgba(24,24,27,.12); }
  input.code {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    letter-spacing: 0.35em;
    text-align: center;
  }
  .field + .field, form .field ~ button { margin-top: 14px; }

  button {
    font: inherit;
    font-size: 14px;
    font-weight: 500;
    height: 36px;
    padding: 0 16px;
    border-radius: calc(var(--radius) - 2px);
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(0,0,0,.04);
    transition: background-color 150ms ease, border-color 150ms ease;
  }
  button:hover { background: var(--surface); }
  button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  button.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
  button.primary:hover { background: #27272a; }
  button.sm { height: 28px; padding: 0 10px; font-size: 13px; box-shadow: none; }
  button.full { width: 100%; }
  button.ghost { border-color: transparent; box-shadow: none; background: transparent; }
  button.ghost:hover { background: var(--surface); }
  /* Destructive ops: red outline; solid-red on hover. The explicit :hover MUST
     come after base button:hover so it wins the cascade. */
  button.danger { color: var(--red); border-color: var(--red); background: var(--bg); }
  button.danger:hover { background: var(--red); color: var(--bg); border-color: var(--red); }
  .actions-danger { display: inline-block; margin-left: 10px; padding-left: 10px; border-left: 1px solid var(--border); }

  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th {
    text-align: left;
    font-size: 13px;
    font-weight: 500;
    color: var(--muted);
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  td { padding: 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: var(--surface); }
  td form { display: inline-block; margin: 0 2px 2px 0; }
  .card table { margin: 0 -24px; width: calc(100% + 48px); }
  .card th:first-child, .card td:first-child { padding-left: 24px; }
  .card th:last-child, .card td:last-child { padding-right: 24px; }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 10px;
    white-space: nowrap;
  }
  .badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
  .badge.live::before { background: var(--green); }
  .badge.off::before { background: var(--red); }
  .ok { color: var(--green); }
  .bad { color: var(--red); }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; }

  .alert {
    font-size: 14px;
    color: var(--red);
    border: 1px solid rgba(220,38,38,.35);
    background: rgba(220,38,38,.04);
    border-radius: calc(var(--radius) - 2px);
    padding: 10px 12px;
    margin-bottom: 14px;
  }
  .row { display: flex; gap: 8px; align-items: end; flex-wrap: wrap; }
  .row .field { margin: 0; }
  .row .grow { flex: 1 1 220px; }
  .topbar {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 20px;
  }
`;

export interface UiPageOptions {
  /** page column: narrow (auth cards) or wide (console). */
  readonly width?: "narrow" | "wide";
  /** when set, inject a no-JS <meta http-equiv="refresh"> so the page auto-
   *  refreshes every N seconds (the operator console; honors the no-script
   *  product-surface doctrine, works under any CSP). Omit everywhere else. */
  readonly refreshSeconds?: number;
}

/** Wrap body markup in the themed HTML shell. `title` is escaped by callers' esc() upstream when dynamic. */
export function uiPage(title: string, body: string, opts: UiPageOptions = {}): string {
  const width = opts.width ?? "narrow";
  const refresh =
    opts.refreshSeconds !== undefined && opts.refreshSeconds > 0
      ? `<meta http-equiv="refresh" content="${Math.floor(opts.refreshSeconds)}" />\n`
      : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${refresh}<title>${title}</title>
<style>${UI_CSS}</style></head>
<body><main class="${width}">${body}</main></body></html>`;
}
