import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { info, sha256File } from './util.ts'
import type { YotoClient } from './yoto.ts'

export type IconCache = Record<string, string>

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

/**
 * Upload one 16x16 PNG per track, matched by sorted filename order against
 * the same order the tracks were listed and selected in.
 */
export async function resolveChapterIcons(
  client: YotoClient,
  dir: string,
  trackCount: number,
  account: string,
  cacheFile: string = ICON_CACHE_FILE,
): Promise<string[]> {
  const files = matchIconFiles(await readdir(dir), trackCount, dir)
  const cache = await readIconCache(cacheFile)
  const refs: string[] = []

  for (const file of files) {
    const full = path.join(dir, file)
    const cacheKey = `${account}:${await sha256File(full)}`
    let ref = cache[cacheKey]

    if (!ref) {
      const mediaId = await client.uploadIcon(await readFile(full))
      ref = `yoto:#${mediaId}`
      cache[cacheKey] = ref
      await writeIconCache(cache, cacheFile)
    }

    info(`  icon  ${file}  ->  ${ref}`)
    refs.push(ref)
  }

  return refs
}
