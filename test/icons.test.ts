import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { matchIconFiles, readIconCache, resolveChapterIcons, writeIconCache } from '../src/icons.ts'
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

test('uploads one icon per track in filename order and caches by content hash', { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'leia-test-'))
  const cacheFile = path.join(directory, 'icon-cache.json')
  const iconsDir = path.join(directory, 'icons')
  await writeFile(path.join(directory, '.keep'), '')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(iconsDir)
  await writeFile(path.join(iconsDir, '02-second.png'), 'second-bytes')
  await writeFile(path.join(iconsDir, '01-first.png'), 'first-bytes')

  const originalFetch = globalThis.fetch
  const uploadedBodies: string[] = []
  let uploadCount = 0

  globalThis.fetch = async (_input, init) => {
    uploadCount++
    uploadedBodies.push(Buffer.from(init?.body as Uint8Array).toString())
    return new Response(JSON.stringify({ displayIcon: { mediaId: `media-${uploadCount}` } }))
  }

  try {
    const client = new YotoClient(async () => 'token-1')
    const refs = await resolveChapterIcons(client, iconsDir, 2, 'account-1', cacheFile)

    assert.deepEqual(refs, ['yoto:#media-1', 'yoto:#media-2'])
    assert.deepEqual(uploadedBodies, ['first-bytes', 'second-bytes'])
    assert.equal(uploadCount, 2)

    // A second resolve for the same directory and account should hit the cache, not re-upload.
    const refsAgain = await resolveChapterIcons(client, iconsDir, 2, 'account-1', cacheFile)
    assert.deepEqual(refsAgain, refs)
    assert.equal(uploadCount, 2)
  } finally {
    globalThis.fetch = originalFetch
    await rm(directory, { recursive: true, force: true })
  }
})

test('icon cache round-trips through disk and tolerates a missing file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'leia-test-'))
  const cacheFile = path.join(directory, 'nested', 'icon-cache.json')

  try {
    assert.deepEqual(await readIconCache(cacheFile), {})

    await writeIconCache({ 'account-1:hash': 'yoto:#abc' }, cacheFile)
    assert.deepEqual(await readIconCache(cacheFile), { 'account-1:hash': 'yoto:#abc' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
