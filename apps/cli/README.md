# @profullstack/reeleel

The `reeleel` command line for [ReelEel](https://reeleel.com): local-first
youth-sports video intelligence. Import a game, point at your athlete, get a
highlight reel. Nothing leaves your machine.

## Install

```bash
curl -fsSL https://reeleel.com/install.sh | sh
```

or with a package manager (Node.js 22.5+):

```bash
npm install -g @profullstack/reeleel   # or: bun add -g @profullstack/reeleel
```

ReelEel shells out to **FFmpeg and ffprobe**, which must be on your `PATH`.
Check your setup with:

```bash
reeleel doctor
```

Automatic moment detection needs the CV worker (`reeleel-cv` on your `PATH`, or
a checkout of the repository); everything else works without it.

Full command reference: [docs/cli.md](https://github.com/profullstack/reeleel/blob/master/docs/cli.md).
Source: [github.com/profullstack/reeleel](https://github.com/profullstack/reeleel) (MIT).
