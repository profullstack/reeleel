/** @jsxImportSource hono/jsx */
import type { FC, PropsWithChildren } from 'hono/jsx';

import { isAuthEnabled } from '@reeleel/api';

import { StatsTracker } from './tracker.js';

/**
 * One stylesheet, inline, no CDN. The desktop app runs offline by design and
 * the web app should not be the one thing that needs a network to look right.
 */
const STYLES = `
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #16181d; --muted: #6b7280; --line: #e5e7eb;
    --accent: #0f766e; --keep: #15803d; --reject: #b91c1c; --card: #f9fafb;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --fg: #e8eaed; --muted: #9aa0a6; --line: #262a31;
      --accent: #2dd4bf; --keep: #4ade80; --reject: #f87171; --card: #171a20;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    /* Centred, not baseline: the mark is 148px tall and a baseline
       alignment would strand the nav at the bottom of it. */
    display: flex; align-items: center; gap: 1rem;
    padding: .5rem 1.25rem; border-bottom: 1px solid var(--line);
  }
  header a { color: inherit; text-decoration: none; font-weight: 650; }
  header nav { margin-left: auto; display: flex; gap: 1rem; }
  header nav a { color: var(--muted); font-weight: 500; }
  main { max-width: 60rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .75rem; }
  .muted { color: var(--muted); }
  /* Advice that only applies without JavaScript — telling someone to refresh
     is actively wrong once the page updates itself. */
  html.js .no-js-only { display: none; }
  .card {
    border: 1px solid var(--line); border-radius: .6rem;
    padding: .9rem 1rem; margin-bottom: .6rem; background: var(--card);
  }
  .row { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
  .grow { flex: 1; }
  .pill {
    font-size: .75rem; padding: .1rem .5rem; border-radius: 999px;
    border: 1px solid var(--line);
  }
  .keep { color: var(--keep); border-color: currentColor; }
  .reject { color: var(--reject); border-color: currentColor; }
  button {
    font: inherit; padding: .3rem .7rem; border-radius: .4rem;
    border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer;
  }
  button:hover { border-color: var(--accent); color: var(--accent); }
  button[disabled] { opacity: .5; cursor: default; }
  label { display: block; font-size: .82rem; color: var(--muted); margin-bottom: .25rem; }
  input[type="text"], input[type="email"], input[type="password"] {
    font: inherit; width: 100%; padding: .45rem .6rem; border-radius: .4rem;
    border: 1px solid var(--line); background: var(--bg); color: inherit;
  }
  input:focus-visible, button:focus-visible, a:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  .field { margin-bottom: .85rem; }
  .narrow { max-width: 24rem; }
  .actions { display: flex; align-items: center; gap: 1rem; margin-top: 1rem; }
  .notice {
    border-left: 3px solid var(--accent); padding: .5rem .75rem; margin: .75rem 0;
    background: var(--card);
  }
  .error { border-left-color: var(--reject); color: var(--reject); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; font-size: .8rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  .empty { color: var(--muted); padding: 2rem 0; }

  /* ── Realtime uploader ─────────────────────────────────────────────────── */
  .dropzone {
    border: 2px dashed var(--line); border-radius: .6rem;
    padding: 1.6rem 1rem; text-align: center; cursor: pointer;
    transition: border-color .12s ease, background .12s ease;
  }
  .dropzone:hover, .dropzone.dragging { border-color: var(--accent); background: var(--card); }
  .dropzone.dragging { border-style: solid; }
  .upload-item { margin-top: .6rem; }
  .upload-meta { margin-top: .4rem; font-size: .85rem; }
  .upload-error { display: inline-block; margin: .5rem 0 0; padding: .3rem .6rem; }
  .upload-total { margin: .75rem 0 .25rem; display: grid; gap: .3rem; }
  /* ── Live job log ──────────────────────────────────────────────────────── */
  .job-head { margin: .25rem 0 .6rem; }
  .job-card { margin-bottom: .5rem; }
  .live-live { color: var(--keep); border-color: currentColor; }
  .live-live::before,
  .live-connecting::before,
  .live-offline::before,
  .live-idle::before {
    content: ''; display: inline-block; width: .45rem; height: .45rem;
    border-radius: 999px; background: currentColor; margin-right: .35rem;
    vertical-align: baseline;
  }
  .live-live::before { animation: pulse 1.6s ease-in-out infinite; }
  .live-offline { color: var(--reject); border-color: currentColor; }
  .live-idle, .live-connecting { color: var(--muted); }
  @keyframes pulse { 50% { opacity: .25; } }
  .log-pane {
    margin-top: .75rem; max-height: 18rem; overflow-y: auto;
    background: var(--card); border: 1px solid var(--line); border-radius: .5rem;
    padding: .6rem .75rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem;
    overflow-wrap: anywhere;
  }
  .log-line { display: flex; gap: .6rem; padding: .05rem 0; }
  .log-time { color: var(--muted); flex: none; font-variant-numeric: tabular-nums; }
  .log-warn .log-message { color: #b45309; }
  .log-error .log-message { color: var(--reject); }
  @media (prefers-reduced-motion: reduce) { .live-live::before { animation: none; } }

  /* ── Identify your athlete ─────────────────────────────────────────────── */
  .candidate-grid {
    display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .5rem;
  }
  .candidate {
    display: flex; flex-direction: column; align-items: center; gap: .25rem;
    padding: .3rem; border: 1px solid var(--line); border-radius: .5rem;
    background: var(--card); cursor: pointer;
  }
  .candidate:hover { border-color: var(--accent); }
  .candidate.chosen { border-color: var(--keep); border-width: 2px; }
  .candidate-crop {
    display: block; border-radius: .3rem; background-color: var(--line);
  }
  .candidate-meta { font-size: .7rem; color: var(--muted); }

  .stored-uploads { margin-top: 1.25rem; padding-top: .5rem; border-top: 1px solid var(--line); }
  .stored-uploads h3 { font-size: .9rem; margin: .5rem 0; color: var(--muted); font-weight: 600; }
  progress {
    width: 100%; height: .5rem; appearance: none; border: 0;
    border-radius: 999px; overflow: hidden; background: var(--line);
  }
  progress::-webkit-progress-bar { background: var(--line); }
  progress::-webkit-progress-value { background: var(--accent); transition: width .15s linear; }
  progress::-moz-progress-bar { background: var(--accent); }
  /* An indeterminate bar means "working, duration unknown" — importing. */
  progress:not([value]) { background:
    repeating-linear-gradient(90deg, var(--accent) 0 1rem, var(--line) 1rem 2rem);
    animation: upload-sweep 1s linear infinite;
  }
  @keyframes upload-sweep { to { background-position: 2rem 0; } }
  @media (prefers-reduced-motion: reduce) {
    progress:not([value]) { animation: none; }
    progress::-webkit-progress-value { transition: none; }
  }
`;

export const Layout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      {/* viewport-fit=cover so the app respects a notch when installed. */}
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>{title} · ReelEel</title>
      <link rel="manifest" href="/manifest.webmanifest" />
      {/* Real PNGs at the sizes browsers and installers ask for. */}
      <link rel="icon" href="/brand/favicon-32.png" sizes="32x32" type="image/png" />
      <link rel="icon" href="/brand/favicon-16.png" sizes="16x16" type="image/png" />
      <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" sizes="180x180" />
      <meta name="theme-color" content="#0f766e" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-title" content="ReelEel" />
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <script type="module" src="/client.js" defer />
      <script
        dangerouslySetInnerHTML={{
          __html:
            "if('serviceWorker' in navigator){addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}",
        }}
      />
      <StatsTracker />
    </head>
    <body>
      <header>
        {/* The mark carries the name, so the link's accessible name comes from
            alt text rather than a second copy of the word beside it. Width and
            height are set to stop the header reflowing as it loads. */}
        <a href="/" style="display:inline-flex;align-items:center">
          <img
            src="/brand/logo.png"
            srcset="/brand/logo.png 1x, /brand/logo@2x.png 2x"
            alt="ReelEel"
            width="207"
            height="148"
            style="height:148px;width:auto;display:block"
          />
        </a>
        <nav>
          <a href="/">Projects</a>
          <a href="/doctor">Doctor</a>
          {/* Only meaningful when a token is configured; a local instance has
              no session to end. */}
          {isAuthEnabled() ? <a href="/logout">Sign out</a> : null}
        </nav>
      </header>
      <main>{children}</main>
    </body>
  </html>
);
