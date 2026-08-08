import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { status, warn } from './util.ts'

export type SourceTrack = {
  id: string
  title: string
  duration: number | null
  uploader: string | null
  url: string
}

export type SourceListing = {
  title: string
  tracks: SourceTrack[]
  skipped: number
}

export type YtOptions = {
  /** Browser to lift cookies from, e.g. "chrome". Helps when a video is age-gated. */
  cookiesFrom?: string
  /** Target MP3 bitrate in kbps. Omit for best available quality. */
  bitrate?: number
  /** Downmix to a single channel, which roughly halves spoken-word file sizes. */
  mono?: boolean
  /** Extra raw yt-dlp arguments, for anything this wrapper does not cover. */
  extraArgs?: string[]
}

const UNAVAILABLE = /^\[?(private|deleted|unavailable) video\]?$/i

// Some extractors (e.g. archive.org) hand back ids that already carry a media
// extension, e.g. "adventuresoftomsawyer_00_twain_128kb.mp3", or a path-like
// prefix from a flat-playlist listing, e.g. "item_name/adventuresoftomsawyer_00_twain_128kb.mp3".
// Neither survives being reused as a filename, and neither matches the id
// yt-dlp resolves for itself once it downloads the track individually — so
// fetchMp3 must never hand a raw id to yt-dlp's own %(id)s output template.
export function stripMediaExtension(id: string): string {
  return id.replace(/\.(mp3|m4a|wav|flac|ogg|opus|aac|webm)$/i, '')
}

export function sanitizeFilename(id: string): string {
  return stripMediaExtension(id).replace(/[^A-Za-z0-9._-]+/g, '_')
}

/** Version strings for the external tools, or null when one is not installed. */
export async function toolVersions(): Promise<{ ytDlp: string | null; ffmpeg: string | null }> {
  const probe = (command: string, args: string[]): Promise<string | null> =>
    new Promise((resolve) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        out += chunk
      })
      child.on('error', () => resolve(null))
      child.on('close', (code) => resolve(code === 0 ? out.split('\n')[0]?.trim() ?? null : null))
    })

  const [ytDlp, ffmpegLine] = await Promise.all([
    probe('yt-dlp', ['--version']),
    probe('ffmpeg', ['-version']),
  ])

  return {
    ytDlp,
    ffmpeg: ffmpegLine ? (/ffmpeg version (\S+)/.exec(ffmpegLine)?.[1] ?? ffmpegLine) : null,
  }
}

function cookieArgs(options: YtOptions): string[] {
  return options.cookiesFrom ? ['--cookies-from-browser', options.cookiesFrom] : []
}

function run(args: string[], onLine?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderrTail = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (onLine) for (const line of chunk.split(/[\r\n]+/)) if (line.trim()) onLine(line.trim())
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2000)
    })

    child.on('error', (error) => {
      reject(
        error.message.includes('ENOENT')
          ? new Error('yt-dlp is not on PATH. Install it with: brew install yt-dlp')
          : error,
      )
    })

    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`yt-dlp exited ${code}\n${stderrTail.trim()}`))
    })
  })
}

/** Enumerate a playlist (or a single video) without downloading anything. */
export async function listSource(url: string, options: YtOptions = {}): Promise<SourceListing> {
  const raw = await run([
    '--ignore-config',
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
    ...cookieArgs(options),
    ...(options.extraArgs ?? []),
    url,
  ])

  const parsed = JSON.parse(raw) as {
    _type?: string
    id?: string
    title?: string
    duration?: number
    uploader?: string
    channel?: string
    webpage_url?: string
    entries?: Array<{
      id?: string
      title?: string
      duration?: number | null
      uploader?: string
      channel?: string
      url?: string
    }>
  }

  if (!Array.isArray(parsed.entries)) {
    // A single video, not a playlist.
    if (!parsed.id) throw new Error(`Could not read any video from ${url}`)
    return {
      title: parsed.title ?? parsed.id,
      skipped: 0,
      tracks: [
        {
          id: parsed.id,
          title: parsed.title ?? parsed.id,
          duration: parsed.duration ?? null,
          uploader: parsed.uploader ?? parsed.channel ?? null,
          url: parsed.webpage_url ?? url,
        },
      ],
    }
  }

  const tracks: SourceTrack[] = []
  let skipped = 0

  for (const entry of parsed.entries) {
    const title = entry?.title?.trim()
    if (!entry?.id || !title || UNAVAILABLE.test(title)) {
      skipped++
      continue
    }
    tracks.push({
      id: entry.id,
      title,
      duration: entry.duration ?? null,
      uploader: entry.uploader ?? entry.channel ?? null,
      url: entry.url ?? `https://www.youtube.com/watch?v=${entry.id}`,
    })
  }

  if (tracks.length === 0) throw new Error(`No playable items found in ${url}`)
  if (skipped > 0) warn(`Skipped ${skipped} unavailable item(s) in the playlist.`)

  return { title: parsed.title ?? 'Playlist', tracks, skipped }
}

const PROGRESS = /\[download\]\s+(\d{1,3}(?:\.\d)?)%/

/**
 * Download one item and convert it to MP3. Returns the local file path.
 * Existing files are reused, so re-running after a failure is cheap.
 */
export async function fetchMp3(
  track: SourceTrack,
  workdir: string,
  options: YtOptions = {},
  attempts = 3,
): Promise<string> {
  // The quality settings go in the filename so switching bitrate does not
  // silently reuse a file encoded at the old one.
  const suffix = `${options.bitrate ? `-${options.bitrate}k` : ''}${options.mono ? '-mono' : ''}`
  const safeName = sanitizeFilename(track.id)
  const target = path.join(workdir, `${safeName}${suffix}.mp3`)

  if (existsSync(target) && (await stat(target)).size > 0) {
    status(`  cached  ${track.title}`)
    return target
  }

  const args = [
    '--ignore-config',
    '--no-playlist',
    '--extract-audio',
    '--audio-format',
    'mp3',
    // "0" is best VBR; a number with K forces that constant bitrate instead.
    '--audio-quality',
    options.bitrate ? `${options.bitrate}K` : '0',
    ...(options.mono ? ['--postprocessor-args', 'ExtractAudio:-ac 1'] : []),
    // ID3 tags feed Yoto's transcodedInfo.metadata.title.
    '--embed-metadata',
    '--newline',
    '--no-warnings',
    '--retries',
    '5',
    '--fragment-retries',
    '10',
    '--output',
    path.join(workdir, `${safeName}${suffix}.%(ext)s`),
    ...cookieArgs(options),
    ...(options.extraArgs ?? []),
    track.url,
  ]

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await run(args, (line) => {
        const match = PROGRESS.exec(line)
        if (match) status(`  ${match[1]!.padStart(5)}%  ${track.title}`)
      })

      if (!existsSync(target)) {
        throw new Error(`yt-dlp finished but ${path.basename(target)} is missing`)
      }
      return target
    } catch (error) {
      lastError = error as Error
      if (attempt < attempts) {
        status(`  retry ${attempt}/${attempts - 1}  ${track.title}`)
      }
    }
  }

  throw new Error(`Could not fetch "${track.title}": ${lastError?.message ?? 'unknown error'}`)
}
