# @reeleel/mobile

ReelEel for iOS and Android. **Real React Native views, not a WebView** — the UI
is written natively and talks to the ReelEel API over HTTP.

> **Status: scaffold, not verified.** The screens, config and API wiring are
> written and the shared client they depend on is fully tested, but this app has
> never been installed or launched — there is no simulator or Expo toolchain on
> the machine it was written on. Expect to fix small things on first run.

## What is shared, and what is not

React Native has no DOM, so **none** of the web UI carries over. What is shared
is [`@reeleel/client`](../../packages/client): the typed API client and its
types, so mobile and web cannot drift apart on what an endpoint returns.

That is also why this app is **excluded from the pnpm workspace**. React Native
pulls a large, platform-specific dependency tree that the server container must
never install, and the Dockerfile copies workspace manifests explicitly. This
app keeps its own lockfile and consumes the client through a `file:` dependency.

## Running it

```bash
cd apps/mobile
npm install          # not pnpm: RN's resolver expects a hoisted tree
npx expo start       # then press i / a, or scan the QR with Expo Go
```

Sign in with your ReelEel server URL, email and password. The app exchanges
those for a session token via `POST /api/login` and keeps it in AsyncStorage —
the same session a browser stores in a cookie, so signing out anywhere revokes
it everywhere.

## Building

[EAS](https://docs.expo.dev/eas/) is configured in `eas.json`:

```bash
npx eas build --platform android --profile preview   # installable APK
npx eas build --platform ios --profile preview
```

Set `extra.eas.projectId` in `app.json` after `npx eas init`.

EAS is Expo's hosted build service and is the one piece of this stack that is
not self-hostable. `npx expo prebuild` emits plain `ios/` and `android/`
projects, so building locally or in your own CI with Fastlane stays open.

## What is here

- Sign in against any ReelEel server, with the URL configurable
- Session restored on launch; an expired token drops back to sign-in
- Project list, pull to refresh
- Suggested moments per project, with optimistic keep/reject

## What is not

- Creating projects, importing footage, running analysis (web app only for now)
- Camera capture — the obvious next step, and the thing that justifies a native
  app over the PWA
- Offline review, push notifications when analysis finishes
