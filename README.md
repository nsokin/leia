<p align="center">
  <img src="assets/leia-logo.png" alt="Leia" width="480" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-0f80c0" alt="Apache-2.0 licence" /></a>
  <a href="https://github.com/nsokin/leia/actions/workflows/ci.yml"><img src="https://github.com/nsokin/leia/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status" /></a>
  <a href="https://github.com/nsokin/leia/releases"><img src="https://img.shields.io/github/downloads/nsokin/leia/total?label=downloads&color=f59e0b" alt="GitHub Releases downloads" /></a>
</p>

# Leia

Playlist in, Yoto MYO card out. One command.

Point it at a playlist, tick the tracks you want, and it fetches the audio,
converts it to MP3, uploads each track to Yoto, and assembles a playlist where
every track is its own chapter with a proper title. The card lands in your Yoto
app library ready to link to a physical MYO card.

Runs entirely on your own machine, on your own network, under your own Yoto
account.

## Install

Leia runs on macOS, Linux, and Windows. Install Node 22.18 or newer, yt-dlp,
and FFmpeg, then make sure all three are available on your `PATH`. There is no
build step: Node runs the TypeScript directly.

On macOS, Homebrew installs both in one line:

```sh
brew install yt-dlp ffmpeg
```

On Ubuntu/Debian, apt has FFmpeg but its yt-dlp package lags upstream, so pull
yt-dlp straight from its release binary:

```sh
sudo apt install ffmpeg
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

```sh
git clone https://github.com/nsokin/leia.git
cd leia
npm install
```

Check it over before going further:

```sh
npm run doctor
```

That reports node, yt-dlp, ffmpeg, your client ID and your sign-in state, and
tells you what to fix if anything is missing.

## Development

```sh
npm run typecheck
npm test
```

## One-time Yoto setup

**You need your own Yoto app.** It takes two minutes and cannot be shared:
the client ID is tied to the account that creates it.

1. Go to [dashboard.yoto.dev](https://dashboard.yoto.dev) and create a **Public** app.
2. Set the redirect URL to exactly `http://127.0.0.1:8787/callback`.
3. Tick `user:content:manage`, then press **Update Application**. Miss it and the
   browser bounces straight back with `access_denied`.
4. Copy the client ID and set it for the current shell:

On macOS or Linux:

```sh
export YOTO_CLIENT_ID=your_client_id
```

In Windows PowerShell:

```powershell
$env:YOTO_CLIENT_ID = 'your_client_id'
```

For a persistent configuration, write `{"clientId":"your_client_id"}` to
`~/.leia/config.json` on macOS/Linux or `%USERPROFILE%\.leia\config.json` on
Windows.

Then sign in once:

```sh
npm run login
```

Sign in with your **normal Yoto customer account**, the one your player and
family library live in. It does not have to be the account that made the app in
step 1, and it usually is not.

That opens your browser, catches the callback on localhost, and saves the token
locally in Leia's `.leia` directory.

Two things the dashboard does not make obvious, both learned the hard way:

- **`offline_access` is not available to public apps.** Asking for it fails the
  entire authorize call with "scopes that have not been pre-approved". So there
  is no refresh token, and the access token lasts 24 hours. The tool re-opens
  the browser when it expires, which is one click while your Yoto session
  is still live.
- **Scopes marked "included automatically" are not in the issued token** unless
  you request them. They are on the app's allowlist, not in the grant. Miss one
  and you get a 403 at the point of use rather than an error at login. The tool
  asks for `user:content:manage`, `user:icons:manage` and `user:content:view`.

## Using it with an AI agent

The repo ships a skill following the [Agent Skills](https://agentskills.io)
open standard. Clone the repo, start your agent inside it, and it is already
there. No install step.

| Agent       | Invoke with     |
| ----------- | --------------- |
| Claude Code | `/yoto <url>`   |
| Codex       | `$yoto <url>`   |

```
/yoto https://www.youtube.com/playlist?list=...
```

The skill handles what the CLI cannot: reading the listing, spotting repeat
uploads, working out how many cards the runtime needs, picking items that make
sensible chapters, and writing the `--strip` pattern for that channel's title
boilerplate. It checks with you before anything long-running.

One file serves both agents. It lives at `.agents/skills/yoto/SKILL.md`, which
is where Codex looks, and `.claude/skills/yoto` is a symlink to it for Claude
Code. Both scan from your working directory up to the repository root, so
starting the agent anywhere inside the repo works.

To use it from any directory, link it into your personal skills:

```sh
ln -s "$PWD/.agents/skills/yoto" ~/.claude/skills/yoto   # Claude Code
ln -s "$PWD/.agents/skills/yoto" ~/.agents/skills/yoto   # Codex
```

None of this is required. Every step is a plain CLI flag and the tool works
standalone.

## Typical run

Look first, download nothing:

```sh
node src/cli.ts "<playlist-url>" --list --spoken
```

Then build from what you saw:

```sh
node src/cli.ts "<playlist-url>" \
  --select "1,2,3,4,9,10" --dedupe --spoken \
  --title "Ben and Holly" \
  --strip "Show Name|Full Episode!?|Cartoon for Kids"
```

Finally, open the Yoto app, find the playlist in your library, and tap **Link to
a card** onto a blank MYO. That last step has no API and has to be done by hand,
once per card.

## Which account do the cards land in?

Two separate things, easily confused:

- The **dashboard.yoto.dev account** owns the *app*, which is only an OAuth
  client identity. It never owns content.
- The account you **sign into at the Yoto login page** during `--login` is whose
  library receives the cards.

They do not have to match. Keep the same client ID and sign in as your normal
Yoto customer account, the one your player and your family library live in.
Nothing in the dashboard needs changing.

Check any time with:

```sh
node src/cli.ts --whoami
```

If the MYO playlist count is lower than you expect, you are signed into the
wrong account. `--logout`, then `--login` again with the right one.

Account identity is recorded where it matters, because uploaded media and card
IDs belong to the account that made them:

- The upload cache is keyed per account, so switching accounts re-uploads rather
  than pointing a card at media the new account does not own.
- Each manifest records its account. Run against a manifest written by a
  different one and the tool creates a fresh card rather than failing on a
  `cardId` it cannot touch.

## Usage

```sh
# The normal case: pick from a playlist, build a card
node src/cli.ts "https://www.youtube.com/playlist?list=..."

# Take everything without prompting
node src/cli.ts "<url>" --all --title "Bedtime Stories"

# Choose without prompting, for scripts and repeat runs
node src/cli.ts "<url>" --select "1-12,15" --title "Aesop"

# Audiobooks: 64 kbps mono, roughly half the file size, no audible loss on speech
node src/cli.ts "<url>" --all --spoken

# Check what you would get without touching Yoto
node src/cli.ts "<url>" --dry-run
```

Full option list: `node src/cli.ts --help`

## How it maps onto Yoto

One selected track becomes one chapter containing one track, so the player's
back and forward buttons step between them, which is what you want on a card a
child is operating.

Per card, Yoto allows **100 tracks** and **500 MB**. The tool refuses to exceed
the track limit rather than letting the API reject the upload, and warns when
your audio is heading past the size limit. If you hit either, split the
selection across two cards with `--select` and different `--title` values.

Yoto re-encodes everything to opus on upload, so what counts against the 500 MB
is their output, not your MP3. That output still scales with what you send: a
34 minute test at `--spoken` uploaded as 15.6 MB of MP3 and landed as 14.0 MB on
the card. The size warning measures your local files, which errs slightly high,
which is the safe direction.

## Re-running

Every run writes a manifest to `./cards/<slug>.json` holding the `cardId`. Run
the same command again and it updates that card in place instead of creating a
duplicate, so a card already linked to physical NFC stays linked.

Two caches make re-runs cheap:

- Converted MP3s stay in `./downloads`, keyed by video ID and quality settings,
  so nothing is fetched twice.
- Uploaded audio is remembered in `~/.leia/media-cache.json`, keyed by the
  local file hash, so nothing is uploaded twice even across different cards.

`--append` adds new tracks to what the manifest already holds rather than
replacing the card's contents.

## Icons

Pass `--icon` either a 16x16 PNG path (uploaded once, then reused for every
chapter) or an existing Yoto icon reference such as
`--icon "yoto:#gCgNJrpHZ186Hd1ttD-k0R2Cf38FbPW3riwe27WAiJA"`. Public icon IDs
are listed at [yoto.dev/icons/using-icons](https://yoto.dev/icons/using-icons/).
Cards work fine without icons; they just show the default.

## Troubleshooting

**"Sign in to confirm you're not a bot"**

YouTube's bot detection. On a home connection this is rare. If it happens, sign
into YouTube in your browser and pass `--cookies-from chrome`. Keep
`--concurrency` low (the default of 3 is deliberate). Do not run this on a VPS:
datacenter IPs get flagged far more aggressively and proof-of-origin tokens no
longer get you past the check.

**Extraction suddenly fails on everything**

YouTube changed something and yt-dlp needs to catch up. `brew upgrade yt-dlp`.

**A track fails mid-run**

The run carries on with the rest and tells you what it skipped. Re-run the same
command to retry; everything already done is cached.

## Independent project

Leia is an independent command-line tool. It is not affiliated with,
endorsed by, or supported by Yoto. It uses the OAuth client ID and Yoto account
you configure, and keeps its credentials and cache data locally in
`~/.leia`; it does not operate a hosted service or collect user data.

## Rights

Yoto's [API guidelines](https://yoto.dev/get-started/api-guidelines/) require
that you hold the rights to what you upload. This tool is for content you are
entitled to use: public domain recordings such as LibriVox, Creative Commons
audio, podcasts, and your own recordings. Downloading commercial music or
audiobooks from YouTube is a breach of YouTube's terms and, in most places, of
copyright.
