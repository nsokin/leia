import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sanitizeFilename, stripMediaExtension } from '../src/source.ts'

test('strips a trailing media extension', () => {
  assert.equal(stripMediaExtension('adventuresoftomsawyer_00_twain_128kb.mp3'), 'adventuresoftomsawyer_00_twain_128kb')
  assert.equal(stripMediaExtension('track.M4A'), 'track')
  assert.equal(stripMediaExtension('no-extension-here'), 'no-extension-here')
})

test('sanitizes archive.org style ids into safe filenames', () => {
  assert.equal(
    sanitizeFilename('adventures_of_tom_sawyer_1402_librivox/adventuresoftomsawyer_00_twain_128kb.mp3'),
    'adventures_of_tom_sawyer_1402_librivox_adventuresoftomsawyer_00_twain_128kb',
  )
})

test('leaves an ordinary yt-dlp video id untouched', () => {
  assert.equal(sanitizeFilename('dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
})
