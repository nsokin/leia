import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

/** Run tasks with a ceiling on how many are in flight at once. */
export function pLimit(concurrency: number) {
  let active = 0
  const waiting: Array<() => void> = []

  const release = () => {
    active--
    waiting.shift()?.()
  }

  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active++
        task().then(resolve, reject).finally(release)
      }
      if (active < concurrency) start()
      else waiting.push(start)
    })
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'card'
}

/** Yoto chapter and track keys are zero-padded two-digit strings. */
export function chapterKey(index1: number): string {
  return String(index1).padStart(2, '0')
}

/**
 * Parse a selection spec like "1-5,8,11-13" into zero-based indices.
 * Returns null for an empty spec, meaning "everything".
 *
 * The order written is the order returned, so "9,3,7" puts track 9 first. That
 * matters for playlists uploaded out of sequence: writing the positions in
 * episode order is the only way to get a card whose chapters run in that order.
 * Ranges still expand ascending, and a position repeated across the spec keeps
 * its first place rather than moving.
 */
export function parseSelection(spec: string, count: number): number[] | null {
  const trimmed = spec.trim()
  if (!trimmed || trimmed === 'all') return null

  const picked = new Set<number>()
  for (const part of trimmed.split(',')) {
    const chunk = part.trim()
    if (!chunk) continue
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(chunk)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (from < 1 || to > count || from > to) {
        throw new Error(`Selection "${chunk}" is out of range (1-${count})`)
      }
      for (let i = from; i <= to; i++) picked.add(i - 1)
      continue
    }
    const single = /^(\d+)$/.exec(chunk)
    if (!single) throw new Error(`Cannot parse selection "${chunk}"`)
    const n = Number(single[1])
    if (n < 1 || n > count) {
      throw new Error(`Selection "${chunk}" is out of range (1-${count})`)
    }
    picked.add(n - 1)
  }
  return [...picked]
}

/**
 * Strip channel boilerplate out of a title and tidy up what it leaves behind.
 * Chapter names are what you actually see in the Yoto app, so
 * "Show Name | Thing Happens - Full Episode | Kids Cartoon Shows" wants to
 * become "Thing Happens". Falls back to the original if stripping empties it.
 */
export function cleanTitle(title: string, pattern?: RegExp): string {
  const stripped = pattern ? title.replace(pattern, ' ') : title

  const cleaned = stripped
    .split('|')
    .map((part) =>
      part
        .replace(/\s+/g, ' ')
        // Collapse separator runs the strip left stranded mid-title.
        .replace(/\s*-\s*(?=[([])/g, ' ')
        .replace(/(\s*-\s*){2,}/g, ' - ')
        // Leading and trailing separators left behind by the strip.
        .replace(/^[\s\-!?,.:;]+|[\s\-!?,.:;]+$/g, '')
        .trim(),
    )
    .filter((part) => part.length > 0)
    .join(' | ')
    .trim()

  return cleaned || title.trim()
}

/**
 * Comparison key for spotting the same episode re-uploaded under a different
 * title. Run the title through cleanTitle first when a --strip pattern exists:
 * removing channel boilerplate is what makes near-identical uploads collapse.
 */
export function dedupeKey(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Rough transcoded size. Yoto's opus lands near the bitrate we upload at. */
export function estimateBytes(seconds: number, bitrateKbps: number): number {
  return Math.round(seconds * bitrateKbps * 125)
}

const isTty = process.stdout.isTTY === true

export function status(line: string): void {
  if (isTty) {
    process.stdout.write(`\r\x1b[2K${line}`)
  }
}

export function clearStatus(): void {
  if (isTty) process.stdout.write('\r\x1b[2K')
}

export function info(line: string): void {
  clearStatus()
  console.log(line)
}

export function warn(line: string): void {
  clearStatus()
  console.warn(`\x1b[33m!\x1b[0m ${line}`)
}

export function fail(line: string): void {
  clearStatus()
  console.error(`\x1b[31mx\x1b[0m ${line}`)
}
