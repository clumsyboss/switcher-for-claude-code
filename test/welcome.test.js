require('./fake-security')
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { welcomeFor, compare, WHATS_NEW } = require('../lib/welcome')

let pass = 0
let fail = 0
function check(name, ok) {
  if (ok) { pass++; console.log('  PASS  ' + name) } else { fail++; console.log('  FAIL  ' + name) }
}

console.log('-- the first-open welcome --')
check('versions compare number by number', compare('1.10.0', '1.9.9') === 1 && compare('1.4', '1.4.0') === 0 && compare('1.3.1', '1.4.0') === -1)
check('a new install, nothing seen and no accounts: the welcome', JSON.stringify(welcomeFor(undefined, '1.4.0', false)) === '{"kind":"install","version":"1.4.0"}')
const old = welcomeFor(undefined, '1.4.0', true)
check('nothing seen but accounts saved: someone updating from before, so what\'s new', old && old.kind === 'update' && old.items.length === WHATS_NEW['1.4.0'].length)
check('already seen this version: nothing', welcomeFor('1.4.0', '1.4.0', true) === null && welcomeFor('1.5.0', '1.4.0', true) === null)
const table = { '1.4.0': [{ title: 'a' }], '1.5.0': [{ title: 'b' }], '1.6.0': [{ title: 'c' }] }
const skipped = welcomeFor('1.4.0', '1.6.0', true, table)
check('skipping versions: everything since the last one seen, newest first', skipped && skipped.items.map((i) => i.title).join('') === 'cb')
check('an update with nothing listed for it: nothing shown', welcomeFor('1.6.0', '1.6.1', true, table) === null)
check('every what\'s-new item has an icon, a tour step, a title and a line', Object.values(WHATS_NEW).flat()
  .every((i) => i.icon && i.step && i.title && i.text))
const tourSteps = [...fs.readFileSync(path.join(__dirname, '..', 'media', 'accounts.js'), 'utf8').matchAll(/\{ id: '([\w-]+)', sel:/g)].map((m) => m[1])
check('and each item\'s step is a stop on the page\'s tour', Object.values(WHATS_NEW).flat().every((i) => tourSteps.includes(i.step)))

console.log(pass + ' passed, ' + fail + ' failed')
assert.strictEqual(fail, 0, 'welcome tests failed')
