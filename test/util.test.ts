import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanTitle, dedupeKey, estimateBytes, formatDuration, pLimit, parseSelection, slugify } from '../src/util.ts'

test('formats and normalises display values', () => {
  assert.equal(formatDuration(null), '--:--')
  assert.equal(formatDuration(65), '1:05')
  assert.equal(formatDuration(3_661), '1:01:01')
  assert.equal(slugify("Ben & Holly's Little Kingdom!"), 'ben-hollys-little-kingdom')
  assert.equal(slugify('---'), 'card')
  assert.equal(estimateBytes(60, 64), 480_000)
})

test('parses selections and rejects invalid positions', () => {
  assert.deepEqual(parseSelection('1-3, 5, 3', 5), [0, 1, 2, 4])
  assert.equal(parseSelection('all', 5), null)
  assert.equal(parseSelection('  ', 5), null)
  assert.throws(() => parseSelection('0', 5), /out of range/)
  assert.throws(() => parseSelection('4-2', 5), /out of range/)
  assert.throws(() => parseSelection('wat', 5), /Cannot parse/)
})

test('keeps the selection in the order it was written', () => {
  // Playlists uploaded out of sequence need this: the spec is the running order.
  assert.deepEqual(parseSelection('9,3,7', 10), [8, 2, 6])
  assert.deepEqual(parseSelection('5,1-3', 5), [4, 0, 1, 2])
  // A repeat keeps its first position rather than jumping to the later one.
  assert.deepEqual(parseSelection('4,2,4', 5), [3, 1])
})

test('cleans titles before creating duplicate keys', () => {
  const strip = /show name|full episode|kids cartoon/gi
  assert.equal(cleanTitle('Show Name | The Big Day - Full Episode | Kids Cartoon', strip), 'The Big Day')
  assert.equal(cleanTitle('Show Name', /show name/i), 'Show Name')
  assert.equal(dedupeKey('The Big Day!'), dedupeKey('the-big day'))
})

test('limits concurrent work', async () => {
  const limit = pLimit(2)
  let active = 0
  let peak = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  const jobs = Array.from({ length: 4 }, () =>
    limit(async () => {
      active++
      peak = Math.max(peak, active)
      await gate
      active--
    }),
  )

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(active, 2)
  release?.()
  await Promise.all(jobs)
  assert.equal(peak, 2)
})
