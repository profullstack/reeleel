/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx';

/**
 * The public front page.
 *
 * Previously `/` was behind the auth guard, so anyone who wasn't signed in was
 * bounced straight to a login form — a site whose only public page is a
 * password prompt tells a visitor nothing about what it does.
 *
 * The palette is sampled from the mascot rather than invented: the deep navy
 * of its outline (#000030), the cream of its belly (#f0f0c0), and the red and
 * blue of the uniform. That is why it reads as one piece with the logo instead
 * of as a template the logo was dropped into.
 *
 * Committed to dark. It is not theme-aware like the app shell — this is one
 * deliberate look, so every colour is stated rather than inherited.
 */

const STYLES = `
  :root {
    --ink: #05060e;
    --ink-2: #0b0e1d;
    --line: #1b2036;
    --cream: #f2efdc;
    --muted: #8b93ad;
    --red: #f0242c;
    --blue: #1890d8;
    --blue-deep: #0048a8;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background: var(--ink);
    color: var(--cream);
    /* Georgia is on effectively every device and reads editorial and warm.
       A system-ui stack here would look like every other generated page. */
    font: 400 17px/1.65 Georgia, 'Iowan Old Style', 'Times New Roman', serif;
    -webkit-font-smoothing: antialiased;
  }
  /* Numerals and labels borrow a telemetry/scoreboard voice. */
  .mono {
    font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums;
  }

  .glow {
    position: fixed; inset: -30% -10% auto -10%; height: 70vh; pointer-events: none;
    background:
      radial-gradient(60% 55% at 22% 12%, rgba(24,144,216,.20), transparent 70%),
      radial-gradient(45% 45% at 82% 0%, rgba(240,36,44,.13), transparent 70%);
    filter: blur(20px);
    animation: drift 26s ease-in-out infinite alternate;
  }
  @keyframes drift { to { transform: translate3d(-3%, 2%, 0) scale(1.06); } }

  .wrap { max-width: 1080px; margin: 0 auto; padding: 0 1.5rem; position: relative; }

  header.top { display: flex; align-items: center; gap: 1rem; padding: 1.25rem 0 0; }
  header.top img { height: 92px; width: auto; display: block; }
  header.top nav { margin-left: auto; display: flex; gap: 1.75rem; align-items: center; }
  header.top nav a { color: var(--muted); text-decoration: none; font-size: .95rem; }
  header.top nav a:hover { color: var(--cream); }

  .hero { padding: 4.5rem 0 5rem; }
  .eyebrow {
    display: inline-flex; align-items: center; gap: .6rem;
    font-size: .72rem; letter-spacing: .18em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 1.6rem;
  }
  .eyebrow::before {
    content: ''; width: 28px; height: 2px; background: var(--red); display: block;
  }
  h1 {
    font-size: clamp(2.6rem, 7vw, 4.6rem);
    line-height: 1.02; letter-spacing: -.02em; margin: 0 0 1.4rem;
    font-weight: 400;
    /* Measure on the headline itself — on the hero it would also clamp the
       lede, which wants a wider column. */
    max-width: 15ch;
  }
  h1 em { font-style: italic; color: var(--blue); }
  .lede { font-size: 1.18rem; color: #cdd2e0; max-width: 46ch; margin: 0 0 2.4rem; }

  .actions { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; }
  .btn {
    display: inline-block; padding: .85rem 1.6rem; border-radius: 2px;
    background: var(--red); color: #fff; text-decoration: none;
    font: 600 .95rem/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .02em;
    border: 1px solid var(--red);
    transition: transform .14s ease, box-shadow .14s ease;
  }
  .btn:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(240,36,44,.28); }
  .btn.ghost { background: transparent; color: var(--cream); border-color: var(--line); }
  .btn.ghost:hover { border-color: var(--blue); box-shadow: none; }

  section { padding: 4rem 0; border-top: 1px solid var(--line); }
  h2 {
    font-size: .75rem; letter-spacing: .18em; text-transform: uppercase;
    color: var(--muted); margin: 0 0 2.2rem; font-weight: 400;
  }

  /* The steps are the real pipeline, not invented features. */
  .steps { display: grid; gap: 2.5rem; grid-template-columns: repeat(4, 1fr); }
  .step .n {
    font-size: .78rem; color: var(--blue); letter-spacing: .1em; display: block;
    margin-bottom: .9rem; padding-bottom: .9rem; border-bottom: 1px solid var(--line);
  }
  .step h3 { font-size: 1.1rem; margin: 0 0 .5rem; font-weight: 400; }
  .step p { margin: 0; font-size: .95rem; color: var(--muted); line-height: 1.6; }

  .honest { display: grid; gap: 2.5rem; grid-template-columns: 1fr 1fr; }
  .honest ul { list-style: none; margin: 0; padding: 0; }
  .honest li {
    padding: .7rem 0 .7rem 1.6rem; position: relative; font-size: .98rem; color: #cdd2e0;
    border-bottom: 1px solid var(--line);
  }
  .honest li::before {
    position: absolute; left: 0; top: .7rem; font-size: .85rem;
  }
  .can li::before { content: '✓'; color: var(--blue); }
  .cannot li::before { content: '—'; color: var(--red); }
  .honest h3 { font-size: 1rem; margin: 0 0 .4rem; font-weight: 400; }
  .honest .sub { color: var(--muted); font-size: .88rem; margin: 0 0 1rem; }

  footer {
    padding: 3rem 0 4rem; border-top: 1px solid var(--line);
    color: var(--muted); font-size: .88rem;
    display: flex; flex-wrap: wrap; gap: 1rem; align-items: center;
  }
  footer a { color: var(--muted); }

  /* Entrance, staggered. Disabled wholesale for anyone who asked for less. */
  .rise { animation: rise .7s cubic-bezier(.2,.7,.3,1) both; }
  .rise-2 { animation-delay: .08s; }
  .rise-3 { animation-delay: .16s; }
  @keyframes rise { from { opacity: 0; transform: translateY(14px); } }
  @media (prefers-reduced-motion: reduce) {
    .rise, .glow { animation: none; }
    .btn { transition: none; }
  }

  @media (max-width: 820px) {
    .steps { grid-template-columns: repeat(2, 1fr); }
    .honest { grid-template-columns: 1fr; }
    header.top img { height: 64px; }
    .hero { padding: 3rem 0 3.5rem; }
  }
  @media (max-width: 520px) {
    .steps { grid-template-columns: 1fr; }
    header.top nav { display: none; }
  }
`;

const STEPS: { title: string; body: string }[] = [
  {
    title: 'Upload the game',
    body: 'A whole game, straight from the camera. Large files resume if the connection drops.',
  },
  {
    title: 'Point at your kid',
    body: 'Scrub to any frame and click them. That one click is the only thing a computer cannot work out for itself.',
  },
  {
    title: 'It watches the footage',
    body: 'Every player is tracked frame by frame, and the stretches where your athlete is in the thick of it are scored.',
  },
  {
    title: 'Keep what you like',
    body: 'Watch each suggestion with the tracking drawn over it, keep the good ones, and render a reel.',
  },
];

const CAN = [
  'Follows one child through a crowded court',
  'Finds the passages where they are on the ball',
  'Shows you exactly what it detected, frame by frame',
  'Cuts, fades, scores and renders a shareable reel',
];

const CANNOT = [
  'Know whether a shot went in',
  'Read a scoreboard or track the score',
  'Tell you who won',
  'Replace you deciding what is worth keeping',
];

export const LandingPage: FC<{ signedIn: boolean }> = ({ signedIn }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>ReelEel — highlight reels from a whole game</title>
      <meta
        name="description"
        content="Upload a whole game, point at your kid once, and get the minutes worth watching."
      />
      <link rel="icon" href="/brand/favicon-32.png" sizes="32x32" type="image/png" />
      <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" sizes="180x180" />
      <meta name="theme-color" content="#05060e" />
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    </head>
    <body>
      <div class="glow" aria-hidden="true" />

      <div class="wrap">
        <header class="top">
          <a href="/" aria-label="ReelEel">
            <img
              src="/brand/logo.png"
              srcset="/brand/logo.png 1x, /brand/logo@2x.png 2x"
              alt="ReelEel"
              width="207"
              height="148"
            />
          </a>
          <nav>
            <a href="#how">How it works</a>
            <a href={signedIn ? '/projects' : '/login'}>{signedIn ? 'Your projects' : 'Sign in'}</a>
          </nav>
        </header>

        <div class="hero rise">
          <span class="eyebrow mono">Youth sports</span>
          <h1>
            Two hours of footage. <em>Four minutes</em> worth watching.
          </h1>
          <p class="lede">
            Upload the whole game. Point at your kid once. ReelEel follows them through it and
            hands back the passages they were actually in — for you to keep or throw away.
          </p>
          <div class="actions">
            <a class="btn" href={signedIn ? '/projects' : '/register'}>
              {signedIn ? 'Go to your projects' : 'Start a project'}
            </a>
            {signedIn ? null : (
              <a class="btn ghost" href="/login">
                Sign in
              </a>
            )}
          </div>
        </div>

        <section id="how" class="rise rise-2">
          <h2 class="mono">How it works</h2>
          <div class="steps">
            {STEPS.map((step, index) => (
              <div class="step" key={step.title}>
                <span class="n mono">{String(index + 1).padStart(2, '0')}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Saying plainly what it cannot do is the most useful thing on the
            page. Every parent has been sold a model that claims to understand
            a game it has only ever seen as boxes moving around. */}
        <section class="rise rise-3">
          <h2 class="mono">Straight about it</h2>
          <div class="honest">
            <div class="can">
              <h3>What it does</h3>
              <p class="sub">Tracking and scoring, on footage you already have.</p>
              <ul>
                {CAN.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div class="cannot">
              <h3>What it doesn't</h3>
              <p class="sub">It sees players and a ball. It does not understand the game.</p>
              <ul>
                {CANNOT.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <footer>
          <span style="margin-left:auto">
            <a href={signedIn ? '/projects' : '/login'}>
              {signedIn ? 'Your projects' : 'Sign in'}
            </a>
          </span>
        </footer>
      </div>
    </body>
  </html>
);
