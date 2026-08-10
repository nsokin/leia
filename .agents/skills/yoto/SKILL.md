---
name: yoto
description: Build a Yoto MYO card from a playlist or video URL using the Leia CLI. Handles enumerating, spotting duplicate uploads, fitting to card limits, cleaning up chapter titles, and uploading. Invoke with `/yoto <url>` in Claude Code, `$yoto <url>` in Codex, or "make a Yoto card from this playlist".
---

# Yoto card builder

Turn a playlist into a Yoto MYO card. The CLI does the mechanical work; your job
is the judgment it cannot do: which items are worth putting on a card, how to
name the chapters, and how to fit them inside the card's limits.

Run everything from the Leia repo directory.

## Never download before you have looked

Always start with `--list`. It enumerates without fetching a byte, and answers
the three questions that decide everything else:

```sh
node src/cli.ts "<url>" --list --spoken
```

It reports every item with its duration, marks any that repeat an earlier title,
and estimates how many cards the runtime needs. A playlist that looks like "100
episodes" is routinely 85 once repeat uploads are removed.

If the user has not set up yet, or something behaves oddly, `node src/cli.ts
--doctor` reports node, yt-dlp, ffmpeg, client ID and sign-in state in one go.

## Then decide four things

**1. Does it fit?** A card holds 100 tracks and 500 MB. At `--spoken` that is
roughly 16 to 18 hours. If the listing needs more than one card, say so plainly
with the numbers and ask what the user wants on the first one. Do not silently
truncate, and do not start a multi-hour job without agreement.

**2. Are there duplicates?** If `--list` marks repeats, add `--dedupe`. Mention
how many it drops and how much runtime that saves.

**3. Which items, and in what order?** For a child's card, prefer individual
episodes over hour-long compilations: each item becomes its own chapter, so
short episodes give buttons that skip somewhere useful. A card of six 10-minute
episodes is far more usable than one 60-minute block. Pass the choice as
`--select "1,2,3,9-12"` using the positions from the listing.

`--select` keeps the order you write, so when a playlist is uploaded out of
sequence, work out the right running order and write the positions in it. A
season listed as episode 24, 40, 1, 13 becomes a card in episode order only if
you ask for it. Add `--number` so the position shows in the app's chapter list,
not just on the player's screen.

**4. What will the chapters be called?** This matters more than it sounds,
because the chapter title is what shows in the Yoto app. Channel titles are
usually unusable as-is, for example:

    Ben and Holly's Little Kingdom | Nanny Plum's Giant Pudding! - Full Episode | Kids Cartoon Shows

Write a `--strip` regex (case-insensitive) removing the show name, the "Full
Episode" and "Cartoon for Kids" style boilerplate, and any channel suffix. The
tool tidies up the separators left behind. Check the result in `--list` output
before committing to a run: `--list` shows cleaned titles.

Note that `--strip` is compiled without the unicode flag, so write emoji ranges
as surrogate pairs, `[\uD800-\uDBFF][\uDC00-\uDFFF]`, not as `\u{1F300}`.

Some uploads have no name to recover, only `Season 2 | Episode 24`. No regex
fixes that. Find the real episode names, then pass them with `--titles <file>`,
a JSON map of `{"<source id>": "Chapter title"}`. Be careful mapping names by
episode number: a broadcast list that merges double episodes into one entry
drifts out of step with an uploader that numbers each half separately. Check
where the two agree before trusting the mapping, and say plainly that the names
are inferred rather than verified from the audio.

**5. Icons?** `--icons` gives each chapter its own artwork, either as a
directory of PNGs matched by sorted filename, or as a JSON file of
`{"<source id>": "<png|yoto:#id>"}`. Prefer the JSON form whenever the card is
built from more than one run or the selection might be reordered, since the
directory form is positional and silently shifts if the selection changes.

Yoto renders these at 16x16, so use art drawn at icon size; a photo or a large
render turns to mush. Check the pixel dimensions of anything you download and
reject what is bigger than about 32x32. Render your picks as a contact sheet
and look at them before pushing, because matching a filename to what it
actually depicts is exactly the step that goes wrong silently: a file tagged
"ladybird" turned out to be a sunflower, and only the render caught it.

`--cover <jpg|png>` sets the card's own artwork in the app, shown portrait.

## Then build it

```sh
node src/cli.ts "<url>" \
  --select "1,2,3,4,9,10" \
  --dedupe --spoken --number \
  --title "Card name" \
  --strip "<boilerplate regex>"
```

Note that `--dedupe` renumbers the list, so its positions are not the ones
`--list` showed. Either read the positions off a deduped run, or leave
`--dedupe` off and write out the positions you want from the `--list` numbering.

- `--spoken` (64 kbps mono) for speech: audiobooks, stories, episodes. Halves
  the size with no audible cost.
- Omit it for music, where stereo matters.
- `--dry-run` converts without touching Yoto, if you want to check first.

Report back what landed: the card title, chapter count, runtime, and how much of
the 500 MB it used. Then tell the user to open the Yoto app and tap "Link to a
card" onto a blank MYO, because that step cannot be done through the API.

## Coming back to a card

Re-running with the same `--title` updates that card in place rather than making
a duplicate, so a card already linked to physical NFC stays linked. `--append`
adds new items to what is already there. Both are cheap: converted audio is
cached in `./downloads` and uploaded audio is cached by file hash, so nothing is
fetched or uploaded twice.

## Things that will bite you

- **Wrong account.** The dashboard account owns the app; the account that signs
  in owns the cards. `--whoami` shows which is active and how many playlists it
  has. A surprisingly low count means the wrong account.
- **Daily re-auth.** Yoto does not grant refresh tokens to public apps, so the
  token lasts 24 hours. Re-login is one browser click.
- **Bot checks.** Rare on a home connection. If they appear, add
  `--cookies-from chrome` and keep `--concurrency` low. Never suggest running
  this on a VPS: datacenter IPs get flagged hard.
- **Stale yt-dlp.** If extraction fails across the board, `brew upgrade yt-dlp`.

## Rights

Yoto's API guidelines require the user to hold rights to what they upload, and
YouTube's terms prohibit downloading. This is a personal tool for content the
user is entitled to use. Do not offer to host it as a public service, and do not
suggest running it on a server: it is designed to run locally for a reason.
