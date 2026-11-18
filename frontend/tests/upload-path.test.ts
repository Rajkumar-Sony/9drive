import assert from 'node:assert/strict'
import test from 'node:test'
import { folderSegments } from '../src/lib/upload-path.ts'

test('preserves nested folder names and rejects unsafe paths', () => {
  assert.deepEqual(folderSegments('album/photos/photo.jpg'), ['album', 'photos'])
  for (const path of ['/file', 'album/../file', 'album/./file', 'album\\file', 'album//file', 'album/\u0000file', `${'a/'.repeat(33)}file`]) {
    assert.throws(() => folderSegments(path))
  }
})
