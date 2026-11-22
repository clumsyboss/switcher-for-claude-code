require('./fake-security')

const assert = require('assert')
const cards = require('../lib/cards.js')

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}
const J = JSON.stringify

console.log('-- order --')
const names = ['ann', 'bob', 'cat']
check('keeps saved names once, in order', J(cards.cleanOrder(['cat', 'x', 'cat', 3, 'ann'], names)) === J(['cat', 'ann']))
check('not a list: null', cards.cleanOrder('ann', names) === null && cards.cleanOrder({}, names) === null)
check('capped', cards.cleanOrder(new Array(10000).fill('ann'), names).length === 1)
const list = [{ name: 'cat' }, { name: 'ann' }, { name: 'bob' }, { name: 'new' }]
const az = (a, b) => a.name.localeCompare(b.name)
check('ordered: saved first, the rest A to Z', J(cards.ordered(list, ['bob', 'cat'], az).map((x) => x.name)) === J(['bob', 'cat', 'ann', 'new']))
check('ordered: a name no longer saved is skipped', J(cards.ordered(list, ['gone', 'new'], az).map((x) => x.name)) === J(['new', 'ann', 'bob', 'cat']))
check('ordered: no order is A to Z', J(cards.ordered(list, undefined, az).map((x) => x.name)) === J(['ann', 'bob', 'cat', 'new']))
check('ordered: leaves the input alone', list[0].name === 'cat')

console.log('-- dismissed notes --')
const notes = cards.cleanNotes({ 'ann:hint': 'a', 'bob:extra': 'b', 'x:hint': 'c', 'ann:other': 'd', 'ann:extra': 7, 'cat:hint': 'z'.repeat(500), hint: 'e' }, names)
check('keeps saved accounts\' hint and extra only', J(notes) === J({ 'ann:hint': 'a', 'bob:extra': 'b' }), J(notes))
check('not a map: null', cards.cleanNotes(['ann:hint'], names) === null && cards.cleanNotes(null, names) === null)

console.log('-- extra usage --')
check('cents to whole money', J(cards.extraOf({ is_enabled: true, monthly_limit: 5000, used_credits: 1234, currency: 'usd', decimal_places: 2 })) === J({ used: 12.34, limit: 50, currency: '$' }))
check('decimal places default to 2', cards.extraOf({ is_enabled: true, monthly_limit: 2000, used_credits: 0 }).limit === 20)
check('euro', cards.extraOf({ is_enabled: true, monthly_limit: 100, used_credits: 0, currency: 'EUR' }).currency === '€')
check('unknown currency: its code', cards.extraOf({ is_enabled: true, monthly_limit: 100, used_credits: 0, currency: 'CHF' }).currency === 'CHF ')
check('yen and won have no minor unit when the API omits it', cards.extraOf({ is_enabled: true, monthly_limit: 50000, used_credits: 1234, currency: 'JPY' }).used === 1234 &&
  cards.extraOf({ is_enabled: true, monthly_limit: 50000, used_credits: 1234, currency: 'krw' }).limit === 50000)
check('but the API\'s decimal places win', cards.extraOf({ is_enabled: true, monthly_limit: 5000, used_credits: 100, currency: 'JPY', decimal_places: 2 }).used === 1)
const usageLib = require('../lib/usage.js')
const hover = (extra) => usageLib.extraText({ extra })
check('hover: dollars as before', hover({ monthly_limit: 12500, used_credits: 3670, decimal_places: 2 }) === '$36.70 of $125.00')
check('hover: euros and pounds', hover({ monthly_limit: 12500, used_credits: 3670, currency: 'EUR' }) === '€36.70 of €125.00' &&
  hover({ monthly_limit: 12500, used_credits: 3670, currency: 'GBP', decimal_places: 2 }) === '£36.70 of £125.00')
check('hover: yen in whole units', hover({ monthly_limit: 50000, used_credits: 1234, currency: 'JPY' }) === '¥1234 of ¥50000')
check('hover: an unknown currency by its code', hover({ monthly_limit: 100, used_credits: 50, currency: 'CHF' }) === 'CHF 0.50 of CHF 1.00')
check('off: null', cards.extraOf({ is_enabled: false, monthly_limit: 100, used_credits: 0 }) === null)
check('no limit: null', cards.extraOf({ is_enabled: true, monthly_limit: 0, used_credits: 0 }) === null)
check('missing: null', cards.extraOf(null) === null)

console.log('-- has room again --')
const NOW = Date.parse('2026-11-22T12:00:00Z')
const iso = (ms) => new Date(NOW + ms).toISOString()
const row = (o) => Object.assign({ name: 'ann', active: false, needsLogin: false, rawSession: null, rawWeekly: null, fetchedAtMs: NOW - 3600e3 }, o)
let waiting = {}
let r = cards.roomBack([row({ rawSession: { percent: 100, resets_at: iso(600e3) } })], waiting, {}, NOW)
check('used up, before reset: waits, nothing due', r.fire.length === 0 && r.due.length === 0 && waiting.ann === NOW + 600e3 && r.next === NOW + 600e3)
r = cards.roomBack([row({ rawSession: { percent: 100, resets_at: iso(600e3) } })], waiting, {}, NOW + 700e3)
check('after reset, old figures: due for a reading', r.due.includes('ann') && r.fire.length === 0)
r = cards.roomBack([row({ rawSession: { percent: 3, resets_at: iso(5 * 3600e3) }, fetchedAtMs: NOW + 800e3 })], waiting, {}, NOW + 800e3)
check('a reading after reset shows room: fires', r.fire.length === 1 && r.fire[0].name === 'ann' && r.fire[0].until === NOW + 600e3)
r = cards.roomBack([row({ rawSession: { percent: 3, resets_at: iso(5 * 3600e3) }, fetchedAtMs: NOW + 800e3 })], waiting, { ann: NOW + 600e3 }, NOW + 900e3)
check('once told (seen): not again', r.fire.length === 0 && !('ann' in waiting))
waiting = {}
r = cards.roomBack([row({ active: true, rawWeekly: { percent: 100, resets_at: iso(600e3) } })], waiting, {}, NOW)
check('never for the active account', r.fire.length === 0 && !('ann' in waiting))
waiting = { ann: NOW - 3 * 3600e3 }
r = cards.roomBack([row({ fetchedAtMs: NOW })], waiting, {}, NOW)
check('too long after the reset: not news', r.fire.length === 0 && !('ann' in waiting))
waiting = { gone: NOW }
cards.roomBack([row({})], waiting, {}, NOW)
check('a forgotten account is dropped', !('gone' in waiting))
waiting = {}
cards.roomBack([row({ rawWeekly: { percent: 100 } })], waiting, {}, NOW)
check('used up without a reset time: nothing to wait for', !('ann' in waiting))

console.log('\n' + passed + ' passed, ' + failed + ' failed')
assert.strictEqual(failed, 0, 'cards tests failed')
