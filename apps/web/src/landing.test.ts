import { describe, expect, it } from 'vitest';

import { LandingPage } from './views/landing.js';

/**
 * `/` used to fall through to the auth guard, so a signed-out visitor was
 * redirected to a password form and never saw what the site was.
 *
 * These assert the two things that would silently undo that — the page has to
 * describe the product to someone with no account, and it has to keep working
 * for someone who has one.
 */

const render = async (signedIn: boolean): Promise<string> =>
  String(await LandingPage({ signedIn }));

describe('the public landing page', () => {
  it('offers a way in for a visitor with no account', async () => {
    const html = await render(false);
    expect(html).toContain('/register');
    expect(html).toContain('/login');
  });

  it('sends someone who is already signed in to their projects', async () => {
    const html = await render(true);
    expect(html).toContain('/projects');
    // No point offering a sign-up to someone with a session.
    expect(html).not.toContain('/register');
  });

  it('says what the product does before asking for anything', async () => {
    const html = await render(false);
    expect(html).toContain('Two hours of footage');
    expect(html).toContain('How it works');
  });

  /**
   * The most useful thing on the page. Every parent has been sold a model that
   * claims to understand a game it has only seen as boxes moving around.
   */
  it('states plainly what it cannot do', async () => {
    const html = await render(false);
    expect(html).toContain('Know whether a shot went in');
    expect(html).toContain('It does not understand the game');
  });

  it('uses the brand mark and its own icons, not the deleted placeholder', async () => {
    const html = await render(false);
    expect(html).toContain('/brand/logo.png');
    expect(html).toContain('/brand/favicon-32.png');
    expect(html).not.toContain('icon.svg');
  });

  it('respects a request for reduced motion', async () => {
    // The page animates a drifting glow and an entrance; both must be optional.
    expect(await render(false)).toContain('prefers-reduced-motion');
  });

  it('is committed to dark rather than inheriting the app theme', async () => {
    const html = await render(false);
    expect(html).toContain('--ink: #05060e');
    expect(html).toContain('name="theme-color" content="#05060e"');
  });
});
