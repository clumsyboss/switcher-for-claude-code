require('./fake-security')
const fs = require('fs')
const os = require('os')
const path = require('path')

const LIB = path.join(__dirname, '..', 'lib')
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hub-contract-'))

let pass = 0, fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  <- ' + extra : '')) }
}

async function main() {
  console.log('-- the files and functions the hub calls --')
  const files = ['switch', 'kickoff', 'tracker', 'store', 'preferences']
  check('the hub finds them by these names in lib/', files.every((f) => fs.existsSync(path.join(LIB, f + '.js'))))
  const lib = Object.fromEntries(files.map((f) => [f, require(path.join(LIB, f + '.js'))]))
  const wanted = {
    switch: ['switchAccount'],
    kickoff: ['startSession'],
    tracker: ['renew', 'poll', 'tick'],
    store: ['setDisplay', 'setKeepAlive', 'setAutoContinue'],
    preferences: ['setRemoteFor', 'setArtifactsFor'],
  }
  for (const [f, names] of Object.entries(wanted)) {
    const missing = names.filter((n) => typeof lib[f][n] !== 'function')
    check(f + '.js: ' + names.join(', '), missing.length === 0, 'missing ' + missing.join(', '))
  }

  console.log('\n-- what a failed switch tells the hub --')
  let err = null
  try { await lib.switch.switchAccount(ROOT, 'Nobody', {}) } catch (e) { err = e }
  check('an unknown account fails with the code NOTSAVED', err && err.code === 'NOTSAVED', err && (err.code || err.message))
  const src = fs.readFileSync(path.join(LIB, 'switch.js'), 'utf8')
  const codes = ['UNSAVED', 'BUSY', 'MOVING', 'CAPTURE', 'NOTSAVED']
  check('the other codes the hub words for the phone still exist: ' + codes.join(', '),
    codes.every((c) => src.includes("'" + c + "'")), codes.filter((c) => !src.includes("'" + c + "'")).join(', '))

  console.log('\n-- registry.json, as the hub reads it --')
  lib.store.setDisplay(ROOT, 'Work', { label: 'Work account', color: 'teal' })
  lib.store.setKeepAlive(ROOT, 'Work', true)
  lib.store.setAutoContinue(ROOT, { mode: 'switch', pick: 'room', early: 80 })
  lib.store.setRemote(ROOT, 'Work', 'off')
  lib.store.setArtifacts(ROOT, 'Work', 'off')
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'registry.json'), 'utf8'))
  const disp = (reg.accounts || []).find((a) => a.name === 'Work') || (reg.display || {}).Work || {}
  check('an account\'s name and colour', disp.label === 'Work account' && disp.color === 'teal', JSON.stringify(disp))
  check('Keep alive as "on" under keepAlive', reg.keepAlive && reg.keepAlive.Work === 'on')
  check('Remote Control and Artifacts off as "off" under remote and artifacts', reg.remote && reg.remote.Work === 'off' && reg.artifacts && reg.artifacts.Work === 'off')
  const ac = reg.autoContinue || {}
  check('autoContinue with mode, pick, order and early', ac.mode === 'switch' && ac.pick === 'room' && Array.isArray(ac.order) && ac.early === 80, JSON.stringify(ac))
  lib.store.setPin(ROOT, 'Z:\\code\\shop', 'Work')
  const pins = JSON.parse(fs.readFileSync(path.join(ROOT, 'registry.json'), 'utf8')).pins
  check('pins as folder → account name', pins && Object.values(pins).includes('Work'), JSON.stringify(pins))

  console.log('\n-- the profile sidecar, as the hub reads it --')
  const profiles = require(path.join(LIB, 'profiles.js'))
  check('profiles/<name>.meta.json beside each saved login', typeof profiles.profilesDir === 'function' &&
    profiles.profilesDir(ROOT) === path.join(ROOT, 'profiles'))

  console.log('\n-- 1.4: logins, sign-in and pins on the phone --')
  const more = {
    logins: ['info', 'dueReminders', 'adoptNewLogin', 'daysLeft', 'stateOf'],
    signin: ['start'],
    chatpins: ['read'],
    store: ['getPins'],
    profiles: ['activeProfile', 'readMeta'],
    claude: ['resolveBin', 'bundled'],
  }
  for (const [f, names] of Object.entries(more)) {
    const m = require(path.join(LIB, f + '.js'))
    const missing = names.filter((n) => typeof m[n] !== 'function')
    check(f + '.js: ' + names.join(', '), missing.length === 0, 'missing ' + missing.join(', '))
  }
  check('credstore.js: remove (optional)', typeof require(path.join(LIB, 'credstore.js')).remove === 'function')
  const logins = require(path.join(LIB, 'logins.js'))
  check('logins.info has no pinning login yet: null', logins.info(ROOT, 'Work') === null)
  const t0 = Date.now()
  check('logins.stateOf words the hub shows', ['ok', 'soon', 'last-day', 'expired'].includes(logins.stateOf(t0 + 10 * 86400e3, t0)))
  check('logins.daysLeft counts whole days (it takes now)', logins.daysLeft(t0 + 10.5 * 86400e3, t0) === 10)

  fs.rmSync(ROOT, { recursive: true, force: true })
  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  if (fail) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
