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

test('keeps an existing icon when a re-run does not resolve one', () => {
  // A plain re-run builds items without an icon field. Overlaying rather than
  // replacing is what stops that wiping art set on an earlier run.
  const withIcon: ManifestItem = { ...first, icon: 'yoto:#keep-me' }
  const [merged] = mergeItems([withIcon], [first])
  assert.equal(merged?.icon, 'yoto:#keep-me')

  // An incoming icon still wins when there is one.
  const [replaced] = mergeItems([withIcon], [{ ...first, icon: 'yoto:#newer' }])
  assert.equal(replaced?.icon, 'yoto:#newer')
})

test('numbers chapter titles by final position, padded to the track count', () => {
  const chapters = toChapters([first, second], undefined, true)
  assert.deepEqual(
    chapters.map((chapter) => chapter.title),
    ['1. First chapter', '2. Second chapter'],
  )

  // The track inside keeps the clean title, so nothing renders "01. 01. ...".
  assert.equal(chapters[0]?.tracks[0]?.title, 'First chapter')

  // Padding follows the count, so a 10 plus item card sorts correctly by name.
  const many = Array.from({ length: 12 }, (_, i) => ({ ...first, sourceId: `s${i}` }))
  const padded = toChapters(many, undefined, true)
  assert.equal(padded[0]?.title, '01. First chapter')
  assert.equal(padded[11]?.title, '12. First chapter')
})

test('leaves titles alone unless numbering is asked for', () => {
  assert.equal(toChapters([first])[0]?.title, 'First chapter')
  assert.equal(toChapters([first], undefined, false)[0]?.title, 'First chapter')
})

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
