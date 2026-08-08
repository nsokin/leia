#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { accountFromToken, createTokenProvider, forceLogin, logout, resolveClientId } from './auth.ts'
import { resolveChapterIcons } from './icons.ts'
import {
  fetchMp3,
  listSource,
  toolVersions,
  type SourceListing,
  type SourceTrack,
  type YtOptions,
} from './source.ts'
import { mergeItems, readManifest, toChapters, writeManifest, type ManifestItem } from './manifest.ts'
import { YotoClient, type TranscodedAudio } from './yoto.ts'
import {
  cleanTitle,
  clearStatus,
  dedupeKey,
  estimateBytes,
  fail,
  formatDuration,
  info,
  parseSelection,
  pLimit,
  sha256File,
  slugify,
  status,
  warn,
} from './util.ts'

const HELP = `
Leia  playlist in, Yoto MYO card out

Usage
  node src/cli.ts <playlist-or-video-url> [options]
  node src/cli.ts <url> --list  Show what is in there, download nothing
  node src/cli.ts --doctor      Check the setup is ready
  node src/cli.ts --login
  node src/cli.ts --logout
  node src/cli.ts --whoami      Which Yoto account am I signed into?

Options
  --list                 Enumerate only: durations, duplicates, cards needed
  --dedupe               Drop repeat uploads of the same title
  --all                  Take every track, skip the picker
  --select <spec>        Pick without prompting, e.g. "1-5,8,11-13"
  --title <text>         Card title (defaults to the playlist title)
  --icon <png|yoto:#id>  16x16 PNG to upload, or an existing Yoto icon ref
  --icons <dir>          Per-chapter 16x16 PNGs, matched to tracks by filename order
  --cover <jpg|png>      Cover art shown for the card in the app, card-shaped (portrait)
  --card <cardId>        Update this card instead of creating a new one
  --append               Add to what the saved manifest already holds
  --strip <regex>        Cut boilerplate out of chapter titles, case-insensitive
  --bitrate <kbps>       Force an MP3 bitrate, e.g. 96 (default: best quality)
  --spoken               Preset for audiobooks: 64 kbps mono, much smaller files
  --workdir <dir>        Where MP3s land (default ./downloads)
  --cards <dir>          Where manifests land (default ./cards)
  --concurrency <n>      Parallel downloads (default 3)
  --cookies-from <name>  Lift cookies from a browser, e.g. chrome
  --dry-run              Download and convert, but do not touch Yoto
  -h, --help             This text
`.trim()

type Options = {
  list: boolean
  dedupe: boolean
  all: boolean
  select?: string
  title?: string
  icon?: string
  icons?: string
  cover?: string
  card?: string
  append: boolean
  workdir: string
  cards: string
  concurrency: number
  cookiesFrom?: string
  strip?: RegExp
  bitrate?: number
  mono: boolean
  dryRun: boolean
}

/** Yoto's own ceilings for a single MYO card. */
const MAX_TRACKS_PER_CARD = 100
const MAX_BYTES_PER_CARD = 500 * 1024 * 1024

type Parsed = {
  url?: string
  options: Options
  login: boolean
  logoutOnly: boolean
  whoami: boolean
  doctor: boolean
  help: boolean
}

function parse(): Parsed {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: 'boolean', default: false },
      select: { type: 'string' },
      title: { type: 'string' },
      icon: { type: 'string' },
      icons: { type: 'string' },
      cover: { type: 'string' },
      card: { type: 'string' },
      append: { type: 'boolean', default: false },
      workdir: { type: 'string', default: './downloads' },
      cards: { type: 'string', default: './cards' },
      concurrency: { type: 'string', default: '3' },
      'cookies-from': { type: 'string' },
      strip: { type: 'string' },
      bitrate: { type: 'string' },
      spoken: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      dedupe: { type: 'boolean', default: false },
      login: { type: 'boolean', default: false },
      logout: { type: 'boolean', default: false },
      whoami: { type: 'boolean', default: false },
      doctor: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  const concurrency = Number(values.concurrency)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('--concurrency must be a whole number between 1 and 8')
  }

  let strip: RegExp | undefined
  if (values.strip !== undefined) {
    try {
      strip = new RegExp(values.strip, 'gi')
    } catch (error) {
      throw new Error(`--strip is not a valid regular expression: ${(error as Error).message}`)
    }
  }

  const spoken = values.spoken === true
  let bitrate: number | undefined
  if (values.bitrate !== undefined) {
    bitrate = Number(values.bitrate)
    if (!Number.isInteger(bitrate) || bitrate < 32 || bitrate > 320) {
      throw new Error('--bitrate must be a whole number of kbps between 32 and 320')
    }
  } else if (spoken) {
    bitrate = 64
  }

  return {
    url: positionals[0],
    login: values.login === true,
    logoutOnly: values.logout === true,
    whoami: values.whoami === true,
    doctor: values.doctor === true,
    help: values.help === true,
    options: {
      all: values.all === true,
      select: values.select,
      title: values.title,
      icon: values.icon,
      icons: values.icons,
      cover: values.cover,
      card: values.card,
      append: values.append === true,
      workdir: path.resolve(values.workdir ?? './downloads'),
      cards: path.resolve(values.cards ?? './cards'),
      concurrency,
      list: values.list === true,
      dedupe: values.dedupe === true,
      cookiesFrom: values['cookies-from'],
      strip,
      bitrate,
      mono: spoken,
      dryRun: values['dry-run'] === true,
    },
  }
}

/**
 * For each track, the 1-based position of the earlier track it repeats, or null
 * when it is the first of its kind. Comparison runs on the cleaned title so
 * channel boilerplate does not hide a repeat upload.
 */
function findDuplicates(tracks: SourceTrack[], strip?: RegExp): Array<number | null> {
  const firstSeen = new Map<string, number>()
  return tracks.map((track, index) => {
    const key = dedupeKey(cleanTitle(track.title, strip))
    const earlier = firstSeen.get(key)
    if (earlier !== undefined) return earlier + 1
    firstSeen.set(key, index)
    return null
  })
}

function cardsNeeded(seconds: number, bitrateKbps: number): number {
  return estimateBytes(seconds, bitrateKbps) / MAX_BYTES_PER_CARD
}

function showListing(listing: SourceListing, options: Options): void {
  const duplicates = findDuplicates(listing.tracks, options.strip)
  const bitrate = options.bitrate ?? 128

  console.log(`${listing.title}\n`)
  for (const [index, track] of listing.tracks.entries()) {
    const repeat = duplicates[index]
    const title = cleanTitle(track.title, options.strip)
    console.log(
      `${String(index + 1).padStart(4)}  ${formatDuration(track.duration).padStart(7)}  ` +
        `${title.slice(0, 58).padEnd(58)}${repeat ? `  repeat of ${repeat}` : ''}`,
    )
  }

  const total = listing.tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0)
  const uniqueTracks = listing.tracks.filter((_, index) => duplicates[index] === null)
  const uniqueTotal = uniqueTracks.reduce((sum, track) => sum + (track.duration ?? 0), 0)
  const repeats = listing.tracks.length - uniqueTracks.length

  console.log('\nSummary')
  console.log(`  items      ${listing.tracks.length}, ${formatDuration(total)} total`)
  if (repeats > 0) {
    console.log(`  unique     ${uniqueTracks.length}, ${formatDuration(uniqueTotal)}`)
    console.log(`  repeats    ${repeats}, pass --dedupe to drop them`)
  }
  console.log(
    `  capacity   about ${cardsNeeded(uniqueTotal, bitrate).toFixed(1)} card(s) at ${bitrate} kbps` +
      `${options.bitrate ? '' : ' (pass --spoken for roughly half that)'}`,
  )
  console.log(`  limits     ${MAX_TRACKS_PER_CARD} tracks and 500 MB per card`)
}

async function runDoctor(getToken: () => Promise<string>): Promise<void> {
  const versions = await toolVersions()
  const row = (label: string, value: string) => console.log(`  ${label.padEnd(12)} ${value}`)

  console.log('Leia setup\n')
  row('node', process.version)
  row('yt-dlp', versions.ytDlp ?? 'MISSING, run: brew install yt-dlp')
  row('ffmpeg', versions.ffmpeg ?? 'MISSING, run: brew install ffmpeg')

  let clientId: string | null = null
  try {
    clientId = await resolveClientId()
    row('client ID', `set (${clientId.slice(0, 6)}...)`)
  } catch {
    row('client ID', 'MISSING, see the README "One-time Yoto setup"')
  }

  if (clientId) {
    try {
      const token = await getToken()
      const cards = await new YotoClient(getToken).listMyoContent()
      row('signed in', `${accountFromToken(token)}, ${cards.length} MYO playlist(s)`)
    } catch (error) {
      row('signed in', `no, run --login (${(error as Error).message.slice(0, 60)})`)
    }
  }

  const ready = versions.ytDlp && versions.ffmpeg && clientId
  console.log(`\n${ready ? 'Ready to build cards.' : 'Fix the items marked above, then re-run --doctor.'}`)
}

async function pickTracks(tracks: SourceTrack[], options: Options): Promise<SourceTrack[]> {
  if (options.all) return tracks

  if (options.select) {
    const indices = parseSelection(options.select, tracks.length)
    return indices ? indices.map((i) => tracks[i]!) : tracks
  }

  if (!process.stdin.isTTY) {
    warn('Not a terminal, so taking every track. Use --select to choose without prompting.')
    return tracks
  }

  const { checkbox } = await import('@inquirer/prompts')
  const chosen = await checkbox({
    message: `Which tracks? (space to toggle, a to toggle all, enter to confirm)`,
    pageSize: 15,
    loop: false,
    choices: tracks.map((track, index) => ({
      name: `${String(index + 1).padStart(3)}. ${track.title}  [${formatDuration(track.duration)}]`,
      value: index,
      checked: true,
    })),
  })

  if (chosen.length === 0) throw new Error('Nothing selected')
  return chosen.map((index) => tracks[index]!)
}

/**
 * Cache of uploaded audio, so re-runs never upload the same file twice.
 * Keyed by "<yoto account>:<local file hash>", because media belongs to the
 * account that uploaded it: signing in as a different Yoto account must miss
 * the cache and upload afresh rather than reference media it does not own.
 */
type MediaCache = Record<string, TranscodedAudio>

const CACHE_FILE = path.join(homedir(), '.leia', 'media-cache.json')

async function readCache(): Promise<MediaCache> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, 'utf8')) as MediaCache
  } catch {
    return {}
  }
}

async function writeCache(cache: MediaCache): Promise<void> {
  try {
    await mkdir(path.dirname(CACHE_FILE), { recursive: true })
    await writeFile(CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`)
  } catch {
    // The cache is only an optimisation; losing it costs a re-upload, nothing more.
  }
}

async function resolveIcon(client: YotoClient, icon: string | undefined): Promise<string | undefined> {
  if (!icon) return undefined
  if (icon.startsWith('yoto:#')) return icon

  const png = await readFile(path.resolve(icon))
  const mediaId = await client.uploadIcon(png)
  info(`Uploaded icon as yoto:#${mediaId}`)
  return `yoto:#${mediaId}`
}

async function resolveCover(client: YotoClient, cover: string | undefined): Promise<string | undefined> {
  if (!cover) return undefined
  const ext = path.extname(cover).toLowerCase()
  const contentType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : null
  if (!contentType) throw new Error(`--cover must be a .jpg or .png file, got "${cover}"`)

  const image = await readFile(path.resolve(cover))
  const mediaUrl = await client.uploadCoverImage(image, contentType)
  info(`Uploaded cover image`)
  return mediaUrl
}

async function main(): Promise<void> {
  const { url, options, login, logoutOnly, whoami, doctor, help } = parse()

  if (help) {
    console.log(HELP)
    return
  }

  if (logoutOnly) {
    await logout()
    info('Removed the saved Yoto token.')
    return
  }

  const getToken = createTokenProvider()

  if (doctor) {
    await runDoctor(getToken)
    return
  }

  if (login) {
    await forceLogin()
    const client = new YotoClient(getToken)
    const cards = await client.listMyoContent()
    info(`Signed in as ${accountFromToken(await getToken())}`)
    info(`This account has ${cards.length} MYO playlist(s).`)
    return
  }

  if (whoami) {
    const token = await getToken()
    const client = new YotoClient(getToken)
    const cards = await client.listMyoContent()
    info(`Yoto account : ${accountFromToken(token)}`)
    info(`MYO playlists: ${cards.length}`)
    for (const card of cards.slice(0, 20)) info(`  ${card.cardId}  ${card.title}`)
    if (cards.length > 20) info(`  ... and ${cards.length - 20} more`)
    info('')
    info('If that count looks wrong, this is not the account you make cards in.')
    info('Run --logout, then --login and sign in with your Yoto customer account.')
    return
  }

  if (!url) {
    console.log(HELP)
    process.exitCode = 1
    return
  }

  const yt: YtOptions = {
    cookiesFrom: options.cookiesFrom,
    bitrate: options.bitrate,
    mono: options.mono,
  }

  info('Reading the playlist ...')
  const listing = await listSource(url, yt)

  if (options.list) {
    clearStatus()
    showListing(listing, options)
    return
  }

  info(`"${listing.title}" has ${listing.tracks.length} playable item(s).\n`)

  // Dedupe before display, so the numbers in the list are the numbers --select
  // refers to. Positions shift relative to the source playlist, which is why
  // --list always shows the unfiltered numbering.
  let candidates = listing.tracks
  if (options.dedupe) {
    const duplicates = findDuplicates(candidates, options.strip)
    const kept = candidates.filter((_, index) => duplicates[index] === null)
    const dropped = candidates.length - kept.length
    if (dropped > 0) info(`Dropped ${dropped} repeat upload(s) of the same title.\n`)
    candidates = kept
  }

  for (const [index, track] of candidates.entries()) {
    console.log(
      `${String(index + 1).padStart(3)}. ${cleanTitle(track.title, options.strip)}` +
        `  [${formatDuration(track.duration)}]`,
    )
  }
  console.log('')

  const selected = await pickTracks(candidates, options)
  const cardTitle = options.title ?? listing.title

  if (selected.length > MAX_TRACKS_PER_CARD) {
    throw new Error(
      `A Yoto card holds at most ${MAX_TRACKS_PER_CARD} tracks and you picked ${selected.length}. ` +
        `Split it across cards, for example --select "1-${MAX_TRACKS_PER_CARD}" then ` +
        `--select "${MAX_TRACKS_PER_CARD + 1}-${selected.length}" with a different --title.`,
    )
  }

  info(`\nTaking ${selected.length} of ${candidates.length} into "${cardTitle}".\n`)

  await mkdir(options.workdir, { recursive: true })

  // Fetch and convert, a few at a time. Going wider invites YouTube's bot checks.
  // One bad item must not sink the run, so failures are collected and reported.
  const limit = pLimit(options.concurrency)
  const settled = await Promise.all(
    selected.map((track) =>
      limit(async () => {
        try {
          const file = await fetchMp3(track, options.workdir, yt)
          status(`  done    ${track.title}`)
          return { track, file, error: null as Error | null }
        } catch (error) {
          return { track, file: null, error: error as Error }
        }
      }),
    ),
  )
  clearStatus()

  const failures = settled.filter((entry) => entry.error !== null)
  const files = settled.flatMap((entry) => (entry.file ? [{ track: entry.track, file: entry.file }] : []))

  for (const failure of failures) {
    warn(`Could not fetch "${failure.track.title}": ${failure.error?.message ?? 'unknown error'}`)
  }
  if (files.length === 0) throw new Error('Nothing downloaded, so there is no card to build.')
  if (failures.length > 0) {
    warn(`Carrying on with the ${files.length} that worked. Re-run to retry the rest.`)
  }

  const localBytes = (await Promise.all(files.map(({ file }) => stat(file)))).reduce(
    (sum, entry) => sum + entry.size,
    0,
  )
  const localMb = Math.round((localBytes / 1024 / 1024) * 10) / 10
  info(`Converted ${files.length} file(s), ${localMb} MB, into ${options.workdir}`)

  if (localBytes > MAX_BYTES_PER_CARD) {
    warn(
      `That is over the 500 MB a single Yoto card holds. Yoto re-encodes on upload so it may ` +
        `still fit, but if the card rejects it, re-run with --spoken (64 kbps mono) or ` +
        `--bitrate 96, or split the selection across two cards.`,
    )
  }
  console.log('')

  if (options.dryRun) {
    info('Dry run, so stopping before the Yoto upload.')
    return
  }

  const client = new YotoClient(getToken)
  const account = accountFromToken(await getToken())
  const icon = await resolveIcon(client, options.icon)
  const cover = await resolveCover(client, options.cover)
  const chapterIcons = options.icons
    ? await resolveChapterIcons(client, path.resolve(options.icons), selected.length, account)
    : null
  const iconBySourceId = chapterIcons
    ? new Map(selected.map((track, index) => [track.id, chapterIcons[index]!]))
    : null
  const cache = await readCache()

  // Uploads run one at a time: transcoding is the slow part and Yoto asks for
  // a light touch on rate limits.
  const items: ManifestItem[] = []
  for (const [index, { track, file }] of files.entries()) {
    const position = `[${index + 1}/${files.length}]`
    const cacheKey = `${account}:${await sha256File(file)}`
    let media = cache[cacheKey]

    if (media) {
      info(`${position} ${track.title} (already on Yoto)`)
    } else {
      status(`${position} uploading ${track.title} ...`)
      const { uploadUrl, uploadId } = await client.getAudioUploadUrl()
      await client.putAudio(uploadUrl, file)
      media = await client.waitForTranscode(uploadId, track.title)
      cache[cacheKey] = media
      await writeCache(cache)
      clearStatus()
      info(`${position} ${track.title}  ${formatDuration(media.duration)}`)
    }

    const chapterIcon = iconBySourceId?.get(track.id)

    items.push({
      sourceId: track.id,
      title: cleanTitle(track.title, options.strip),
      sha256: media.sha256,
      duration: media.duration,
      fileSize: media.fileSize,
      channels: media.channels,
      format: media.format,
      ...(chapterIcon ? { icon: chapterIcon } : {}),
    })
  }

  const slug = slugify(cardTitle)
  const manifestFile = path.join(options.cards, `${slug}.json`)
  const saved = await readManifest(manifestFile)

  // A cardId belongs to one Yoto account. If the manifest was written by a
  // different one, reusing its cardId would fail, so start a fresh card instead.
  const sameAccount = !saved?.account || saved.account === account
  const existing = sameAccount ? saved : null
  if (saved && !sameAccount) {
    warn(
      `${path.basename(manifestFile)} was made under a different Yoto account, so ` +
        `its card cannot be updated from this one. Creating a new card instead.`,
    )
  }

  const finalItems = options.append && existing ? mergeItems(existing.items, items) : items

  if (finalItems.length > MAX_TRACKS_PER_CARD) {
    throw new Error(
      `Appending would put ${finalItems.length} tracks on the card, over Yoto's limit of ` +
        `${MAX_TRACKS_PER_CARD}. The audio is uploaded and cached, so start a second card ` +
        `with --title instead and nothing is re-downloaded.`,
    )
  }

  const chapters = toChapters(finalItems, icon)
  const totalDuration = finalItems.reduce((sum, item) => sum + item.duration, 0)
  const totalBytes = finalItems.reduce((sum, item) => sum + item.fileSize, 0)
  const cardId = options.card ?? existing?.cardId ?? undefined

  info('\nAssembling the card ...')
  const savedCardId = await client.createOrUpdateContent({
    ...(cardId ? { cardId } : {}),
    title: cardTitle,
    content: { chapters },
    metadata: {
      media: {
        duration: totalDuration,
        fileSize: totalBytes,
        readableFileSize: Math.round((totalBytes / 1024 / 1024) * 10) / 10,
      },
      ...(cover ? { cover: { imageL: cover } } : {}),
    },
  })

  await writeManifest(manifestFile, {
    title: cardTitle,
    cardId: savedCardId,
    account,
    updatedAt: new Date().toISOString(),
    items: finalItems,
  })

  info('')
  info(`Card ${cardId ? 'updated' : 'created'}: ${cardTitle}`)
  info(`  cardId    ${savedCardId}`)
  info(`  tracks    ${finalItems.length}`)
  info(`  runtime   ${formatDuration(totalDuration)}`)
  info(`  manifest  ${manifestFile}`)
  info('')
  info('It is now in your Yoto app library. Open the playlist there and tap')
  info('"Link to a card" to write it onto a MYO card, then re-run this command')
  info('any time to update the same card in place.')
}

process.on('SIGINT', () => {
  clearStatus()
  console.error('\nStopped.')
  process.exit(130)
})

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
