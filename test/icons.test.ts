import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  matchIconFiles,
  parseIconMap,
  planChapterIcons,
  uploadChapterIcons,
} from '../src/icons.ts'
import { YotoClient } from '../src/yoto.ts'

test('matches PNGs to tracks in sorted filename order', () => {
  assert.deepEqual(
    matchIconFiles(['02-tom-kitten.png', '01-peter-rabbit.png', 'notes.txt'], 2, '/icons'),
    ['01-peter-rabbit.png', '02-tom-kitten.png'],
  )
})

test('rejects a directory whose PNG count does not match the track count', () => {
  assert.throws(
    () => matchIconFiles(['01.png', '02.png'], 3, '/icons'),
    /--icons \/icons has 2 PNG\(s\) but 3 track\(s\)/,
  )
})

test('ignores non-PNG files when counting', () => {
  assert.deepEqual(matchIconFiles(['01.png', 'readme.md', '.DS_Store'], 1, '/icons'), ['01.png'])
})

test('rejects an icon map that is not an object of strings', () => {
  assert.throws(() => parseIconMap(['a.png'], 'f.json'), /must be a JSON object/)
  assert.throws(() => parseIconMap({ abc: '' }, 'f.json'), /must be a non-empty string/)
  assert.deepEqual(parseIconMap({ abc: ' art.png ' }, 'f.json'), { abc: 'art.png' })
})

test('plans a directory positionally against the selection', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'leia-icons-'))
  const icons = path.join(dir, 'icons')
  await mkdir(icons)
  await writeFile(path.join(icons, '02-second.png'), 'second')
  await writeFile(path.join(icons, '01-first.png'), 'first')

  const plan = await planChapterIcons(icons, ['track-a', 'track-b'])
  assert.equal(plan['track-a'], path.join(icons, '01-first.png'))
  assert.equal(plan['track-b'], path.join(icons, '02-second.png'))
})

test('plans a JSON file by source id, so reordering cannot shift the art', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'leia-icons-'))
  const art = path.join(dir, 'cow.png')
  await writeFile(art, 'cow')
  const mapFile = path.join(dir, 'icons.json')
  await writeFile(mapFile, JSON.stringify({ 'track-b': art, 'track-a': 'yoto:#already' }))

  const plan = await planChapterIcons(mapFile, ['track-a', 'track-b'])
  assert.equal(plan['track-a'], 'yoto:#already')
  assert.equal(plan['track-b'], art)
})

test('rejects a JSON entry pointing at a file that is not there', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'leia-icons-'))
  const mapFile = path.join(dir, 'icons.json')
  await writeFile(mapFile, JSON.stringify({ 'track-a': path.join(dir, 'nope.png') }))

  await assert.rejects(() => planChapterIcons(mapFile, ['track-a']), /is not there/)
})

test('uploads each icon once, caches by content hash, and skips untouched tracks', { concurrency: false }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'leia-icons-'))
  const cacheFile = path.join(dir, 'icon-cache.json')
  const first = path.join(dir, 'first.png')
  const second = path.join(dir, 'second.png')
  await writeFile(first, 'first-bytes')
  await writeFile(second, 'second-bytes')

  const originalFetch = globalThis.fetch
  let uploads = 0
  globalThis.fetch = async () => {
    uploads++
    return new Response(JSON.stringify({ displayIcon: { mediaId: `media-${uploads}` } }))
  }

  try {
    const client = new YotoClient(async () => 'token-1')
    const plan = { a: first, b: second, c: 'yoto:#preexisting' }

    // "c" is already a Yoto ref and never uploads; "b" is not in this run.
    const run1 = await uploadChapterIcons(client, plan, ['a', 'c'], 'account-1', cacheFile)
    assert.deepEqual(run1, { a: 'yoto:#media-1', c: 'yoto:#preexisting' })
    assert.equal(uploads, 1)

    // Second run over the same art hits the cache rather than re-uploading.
    const run2 = await uploadChapterIcons(client, plan, ['a', 'b'], 'account-1', cacheFile)
    assert.equal(run2['a'], 'yoto:#media-1')
    assert.equal(run2['b'], 'yoto:#media-2')
    assert.equal(uploads, 2)

    // A different account must not reuse media it does not own.
    await uploadChapterIcons(client, plan, ['a'], 'account-2', cacheFile)
    assert.equal(uploads, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
})
