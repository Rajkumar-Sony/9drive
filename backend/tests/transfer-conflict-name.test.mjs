import assert from 'node:assert/strict'
import test from 'node:test'
import { keepBothName } from '../dist/modules/transfers/conflict-name.js'

test('keep-both names preserve extensions and skip existing suffixes deterministically', () => {
  assert.equal(keepBothName('report.pdf', new Set()), 'report.pdf')
  assert.equal(keepBothName('report.pdf', new Set(['report.pdf'])), 'report (2).pdf')
  assert.equal(keepBothName('report.pdf', new Set(['report.pdf', 'report (2).pdf'])), 'report (3).pdf')
})

test('keep-both names handle dotfiles, extensionless names, and long unicode filenames', () => {
  assert.equal(keepBothName('.env', new Set(['.env'])), '.env (2)')
  assert.equal(keepBothName('archive', new Set(['archive'])), 'archive (2)')
  const name = keepBothName(`${'語'.repeat(250)}.zip`, new Set([`${'語'.repeat(250)}.zip`]))
  assert.ok(name.length <= 255)
  assert.ok(name.endsWith(' (2).zip'))
})
