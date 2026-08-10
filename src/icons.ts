import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { info, sha256File, status } from './util.ts'
import type { YotoClient } from './yoto.ts'

export type IconCache = Record<string, string>

/** Local PNG path, or an existing Yoto ref, per source id. Resolved, not uploaded. */
export type IconPlan = Record<string, string>

export const ICON_CACHE_FILE = path.join(homedir(), '.leia', 'icon-cache.json')

export async function readIconCache(file: string = ICON_CACHE_FILE): Promise<IconCache> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as IconCache
  } catch {
    return {}
  }
}

export async function writeIconCache(cache: IconCache, file: string = ICON_CACHE_FILE): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(cache, null, 2)}\n`)
  } catch {
    // The cache is only an optimisation; losing it costs a re-upload, nothing more.
  }
}

/**
 * Pick the PNGs in a directory that will supply chapter icons, in the order
 * they will be matched against tracks. Throws when the count does not match
 * the number of selected tracks, rather than guessing which icon belongs to
 * which chapter.
 */
export function matchIconFiles(files: string[], trackCount: number, dir: string): string[] {
  const pngs = files.filter((name) => /\.png$/i.test(name)).sort()

  if (pngs.length !== trackCount) {
    throw new Error(
      `--icons ${dir} has ${pngs.length} PNG(s) but ${trackCount} track(s) were selected; they must match 1:1.`,
    )
  }

  return pngs
}

/** Validate a JSON icon map and return it keyed by source id. */
export function parseIconMap(parsed: unknown, file: string): IconPlan {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`--icons ${file} must be a JSON object of {"<source id>": "<png path or yoto:#id>"}`)
  }

  const plan: IconPlan = {}
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`--icons entry "${id}" must be a non-empty string`)
    }
    plan[id] = value.trim()
  }
  return plan
}

/**
 * Work out which artwork belongs to which chapter, without uploading anything.
 *
 * Two forms, because they suit different jobs. A **directory** of PNGs is
 * matched to the selection by sorted filename, which is the quick way to dress
 * a card you are building in one go. A **JSON file** of
 * `{"<source id>": "<png path or yoto:#id>"}` binds art to the track itself, so
 * it survives the selection being reordered or added to later, and it can name
 * icons already uploaded to Yoto.
 *
 * Runs before the download so a miscount or a bad path costs a second rather
 * than an hour of fetching.
 */
export async function planChapterIcons(spec: string, selectedIds: string[]): Promise<IconPlan> {
  const full = path.resolve(spec)

  let isDirectory = false
  try {
    isDirectory = (await stat(full)).isDirectory()
  } catch {
    throw new Error(`--icons path does not exist: ${spec}`)
  }

  if (isDirectory) {
    const files = matchIconFiles(await readdir(full), selectedIds.length, spec)
    const plan: IconPlan = {}
    for (const [index, id] of selectedIds.entries()) plan[id] = path.join(full, files[index]!)
    return plan
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(full, 'utf8'))
  } catch (error) {
    throw new Error(`Could not read --icons file ${spec}: ${(error as Error).message}`)
  }

  const plan = parseIconMap(parsed, spec)
  for (const [id, value] of Object.entries(plan)) {
    if (value.startsWith('yoto:#')) continue
    try {
      await stat(path.resolve(value))
    } catch {
      throw new Error(`--icons entry "${id}" points at a file that is not there: ${value}`)
    }
  }
  return plan
}

/**
 * Upload the planned artwork and map every source id onto a Yoto ref.
 *
 * Cached by account and file hash, like the audio cache, so re-running a build
 * does not re-upload unchanged art and two runs over one card share the work.
 * Scoped to `wanted`, the tracks in this run, because an icon file usually
 * covers a whole card and a partial rebuild should not upload art for chapters
 * it is not touching.
 */
export async function uploadChapterIcons(
  client: YotoClient,
  plan: IconPlan,
  wanted: Iterable<string>,
  account: string,
  cacheFile: string = ICON_CACHE_FILE,
): Promise<Record<string, string>> {
  const needed = new Set(wanted)
  const cache = await readIconCache(cacheFile)
  const resolved: Record<string, string> = {}
  let uploaded = 0

  for (const [id, value] of Object.entries(plan)) {
    if (!needed.has(id)) continue

    if (value.startsWith('yoto:#')) {
      resolved[id] = value
      continue
    }

    const cacheKey = `${account}:${await sha256File(value)}`
    let ref = cache[cacheKey]

    if (!ref) {
      status(`  uploading icon ${path.basename(value)} ...`)
      ref = `yoto:#${await client.uploadIcon(await readFile(value))}`
      cache[cacheKey] = ref
      await writeIconCache(cache, cacheFile)
      uploaded++
    }

    resolved[id] = ref
  }

  if (uploaded > 0) info(`Uploaded ${uploaded} icon(s), the rest were already on Yoto.`)
  return resolved
}
