import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { YotoChapter } from './yoto.ts'
import { chapterKey } from './util.ts'

export type ManifestItem = {
  sourceId: string
  title: string
  sha256: string
  duration: number
  fileSize: number
  channels: string
  format: string
  icon?: string
}

export type Manifest = {
  title: string
  cardId: string | null
  /** Yoto account the cardId and media belong to. */
  account?: string
  updatedAt: string | null
  items: ManifestItem[]
}

export async function readManifest(file: string): Promise<Manifest | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Manifest
    return { ...parsed, items: parsed.items ?? [] }
  } catch {
    return null
  }
}

export async function writeManifest(file: string, manifest: Manifest): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * One chapter per item, so the player's back and forward buttons step between
 * tracks. Keys and overlay labels are renumbered from the final ordering.
 */
export function toChapters(items: ManifestItem[], fallbackIcon?: string): YotoChapter[] {
  return items.map((item, index) => {
    const key = chapterKey(index + 1)
    const label = String(index + 1)
    const icon = item.icon ?? fallbackIcon
    const display = icon ? { display: { icon16x16: icon } } : {}

    return {
      key,
      title: item.title,
      overlayLabel: label,
      ...display,
      tracks: [
        {
          key: '01',
          title: item.title,
          trackUrl: `yoto:#${item.sha256}`,
          duration: item.duration,
          fileSize: item.fileSize,
          channels: item.channels,
          format: item.format,
          type: 'audio' as const,
          overlayLabel: label,
          ...display,
        },
      ],
    }
  })
}

/**
 * Merge new items into existing ones, matched by source id, keeping order.
 * A matched item is overlaid onto the existing one field by field, not
 * replaced wholesale, so a re-run that does not resolve an icon (or any other
 * optional field) never wipes one that was set on an earlier run.
 */
export function mergeItems(existing: ManifestItem[], incoming: ManifestItem[]): ManifestItem[] {
  const merged = [...existing]
  for (const item of incoming) {
    const at = merged.findIndex((candidate) => candidate.sourceId === item.sourceId)
    if (at >= 0) merged[at] = { ...merged[at], ...item }
    else merged.push(item)
  }
  return merged
}
