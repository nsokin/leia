import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { mergeItems, readManifest, toChapters, writeManifest, type ManifestItem } from '../src/manifest.ts'

const first: ManifestItem = {
  sourceId: 'first',
  title: 'First chapter',
  sha256: 'a'.repeat(64),
  duration: 61,
  fileSize: 123,
  channels: 'stereo',
  format: 'mp3',
}

const second: ManifestItem = {
  ...first,
  sourceId: 'second',
  title: 'Second chapter',
  sha256: 'b'.repeat(64),
}

test('creates one labelled Yoto chapter per manifest item', () => {
  const [chapter] = toChapters([first], 'yoto:#fallback')
  assert.deepEqual(chapter, {
    key: '01',
    title: 'First chapter',
    overlayLabel: '1',
    display: { icon16x16: 'yoto:#fallback' },
    tracks: [
      {
        key: '01',
        title: 'First chapter',
        trackUrl: `yoto:#${first.sha256}`,
        duration: 61,
        fileSize: 123,
        channels: 'stereo',
        format: 'mp3',
        type: 'audio',
        overlayLabel: '1',
        display: { icon16x16: 'yoto:#fallback' },
      },
    ],
  })
})

test('replaces matching manifest items without changing their order', () => {
  const replacement = { ...first, title: 'Updated chapter' }
  assert.deepEqual(mergeItems([first, second], [replacement]), [replacement, second])
})

test('preserves an existing icon when a re-run does not resolve one', () => {
  const withIcon: ManifestItem = { ...first, icon: 'yoto:#existing' }
  const freshlyBuilt = { ...first, title: 'Re-fetched title' }

  const [merged] = mergeItems([withIcon], [freshlyBuilt])
  assert.equal(merged!.icon, 'yoto:#existing')
  assert.equal(merged!.title, 'Re-fetched title')
})

test('overwrites an existing icon when the incoming item sets a new one', () => {
  const withIcon: ManifestItem = { ...first, icon: 'yoto:#old' }
  const withNewIcon: ManifestItem = { ...first, icon: 'yoto:#new' }

  const [merged] = mergeItems([withIcon], [withNewIcon])
  assert.equal(merged!.icon, 'yoto:#new')
})

test('round-trips a manifest through disk', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'leia-test-'))
  const file = path.join(directory, 'cards', 'example.json')
  const manifest = { title: 'Example', cardId: 'card-1', account: 'account-1', updatedAt: null, items: [first] }

  try {
    await writeManifest(file, manifest)
    assert.deepEqual(await readManifest(file), manifest)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
