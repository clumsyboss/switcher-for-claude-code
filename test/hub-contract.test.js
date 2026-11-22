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

  console.log('\n-- 1.5: pinning logins, auto-continue and requests from the phone --')
  const more15 = {
    logins: ['wrapperLogin', 'hasLogin', 'listInUse', 'adoptNewLogin'],
    autocontinue: ['readState', 'updateState', 'limitStop'],
    health: ['liveNotes'],
    requests: ['submit', 'result', 'sweep', 'alive'],
  }
  for (const [f, names] of Object.entries(more15)) {
    const m = require(path.join(LIB, f + '.js'))
    const missing = names.filter((n) => typeof m[n] !== 'function')
    check(f + '.js: ' + names.join(', '), missing.length === 0, 'missing ' + missing.join(', '))
  }
  check('logins.wrapperLogin with no pinning login: null', logins.wrapperLogin(ROOT, 'Work') === null)
  check('logins.hasLogin with no pinning login: false', logins.hasLogin(ROOT, 'Work') === false)
  const adoptSrc = fs.readFileSync(path.join(LIB, 'logins.js'), 'utf8')
  const reasons = ['different-account', 'no-login', 'no-identity', 'held-in-use', 'locked']
  check('the adopt failure reasons the hub words for the phone: ' + reasons.join(', '),
    reasons.every((r) => adoptSrc.includes("reason: '" + r + "'")), reasons.filter((r) => !adoptSrc.includes("reason: '" + r + "'")).join(', '))
  const inuse = path.join(ROOT, 'pinning', '.inuse')
  fs.mkdirSync(inuse, { recursive: true })
  const SID = '6b8cbf67-1111-4222-8333-944455556666'
  fs.writeFileSync(path.join(inuse, process.pid + '.json'), JSON.stringify({ v: 1, name: 'Work', pid: process.pid, sessionId: SID, cwd: ROOT, startedAt: Date.now(), by: 'claude-hub' }))
  const used = logins.listInUse(ROOT, 'Work')
  check('listInUse accepts the hub\'s marker with its "by" key', used.length === 1 && used[0].pid === process.pid && used[0].sessionId === SID, JSON.stringify(used))
  const notes = require(path.join(LIB, 'health.js')).liveNotes(ROOT)
  check('and so does health.liveNotes', notes.length === 1 && notes[0].by === 'claude-hub', JSON.stringify(notes))
  fs.rmSync(inuse, { recursive: true, force: true })
  const autoc = require(path.join(LIB, 'autocontinue.js'))
  check('autocontinue.updateState writes what fn changes, under its lock', autoc.updateState(ROOT, (s) => { s.early.Work = { at: 1 }; return 'done' }) === 'done' && autoc.readState(ROOT).early.Work.at === 1)
  const st = autoc.readState(ROOT)
  check('autocontinue.readState gives stops, keepAlive and early', st && typeof st.stops === 'object' && typeof st.keepAlive === 'object' && typeof st.early === 'object', JSON.stringify(st))
  check('autocontinue.limitStop of a missing file: nothing', !autoc.limitStop(path.join(ROOT, 'none.jsonl')))
  const requests = require(path.join(LIB, 'requests.js'))
  const nope = requests.submit(ROOT, { kind: 'pinChat', sessionId: SID, account: 'Work' })
  check('requests.submit refuses an account that is not saved, with a reason and words', nope.ok === false && nope.reason === 'no-account' && !!nope.text, JSON.stringify(nope))
  const unpin = requests.submit(ROOT, { kind: 'unpinChat', sessionId: SID, device: 'Phone' })
  check('requests.submit takes an unpin and gives its id', unpin.ok === true && typeof unpin.id === 'string', JSON.stringify(unpin))
  check('requests.result is null until a window answers', requests.result(ROOT, unpin.id) === null)
  const sw = requests.sweep(ROOT, { now: Date.now() + 3 * 60000 })
  const res = requests.result(ROOT, unpin.id)
  check('requests.sweep answers one nobody took with {ok:false, state:"expired", text}', sw && res && res.ok === false && res.state === 'expired' && !!res.text, JSON.stringify(res))
  const states = ['pinned', 'waiting', 'reopened', 'unpinned', 'needs-reopen', 'failed', 'expired']
  check('requests.STATES, the states the hub words: ' + states.join(', '),
    !!requests.STATES && JSON.stringify(Object.values(requests.STATES).slice().sort()) === JSON.stringify(states.slice().sort()), JSON.stringify(requests.STATES))
  check('and the expired answer is one of them', res && res.state === requests.STATES.EXPIRED)

  const DAY = 86400000
  const fixture = (name, days) => {
    fs.mkdirSync(path.join(ROOT, 'profiles'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, 'profiles', name + '.enc'), 'x')
    if (days !== undefined) {
      fs.mkdirSync(path.join(ROOT, 'pinning'), { recursive: true })
      fs.writeFileSync(path.join(ROOT, 'pinning', name + '.json'), JSON.stringify({ v: 1, expiresAt: Date.now() + days * DAY }))
    }
  }
  fixture('Madeup-Pin', 20)
  fixture('Madeup-Plain')
  fixture('Madeup-Ending', 0.01)
  const refusals = [
    ['bad-request', null],
    ['bad-kind', { kind: 'deleteChat', sessionId: SID }],
    ['bad-session', { kind: 'pinChat', sessionId: '../../x', account: 'Madeup-Pin' }],
    ['no-account', { kind: 'pinChat', sessionId: SID, account: 'Nobody-Made-Up' }],
    ['no-pinning-login', { kind: 'pinChat', sessionId: SID, account: 'Madeup-Plain' }],
    ['login-ended', { kind: 'pinChat', sessionId: SID, account: 'Madeup-Ending' }],
  ]
  for (const [code, req] of refusals) {
    const r = requests.submit(ROOT, req)
    check('requests.submit refusal "' + code + '": {ok:false, reason, text}', r.ok === false && r.reason === code && typeof r.text === 'string' && r.text.length > 0, JSON.stringify(r))
  }
  check('requests.REASONS lists those six (and too-many)', !!requests.REASONS &&
    refusals.every(([code]) => Object.values(requests.REASONS).includes(code)) && Object.values(requests.REASONS).includes('too-many'), JSON.stringify(requests.REASONS))

  const at = Date.now()
  const hubReq = { kind: 'pinChat', sessionId: SID, account: 'Madeup-Pin', from: 'hub', device: 'Made-up phone', at, extra: 'ignored' }
  const ok = requests.submit(ROOT, hubReq)
  check('requests.submit takes the hub\'s exact pin request: {ok:true, id}', ok.ok === true && /^[0-9a-f]{32}$/.test(ok.id), JSON.stringify(ok))
  const written = JSON.parse(fs.readFileSync(requests.requestFile(ROOT, ok.id), 'utf8'))
  check('the file holds {v, id, kind, sessionId, from, at, account, device}, nothing more',
    JSON.stringify(Object.keys(written).sort()) === JSON.stringify(['account', 'at', 'device', 'from', 'id', 'kind', 'sessionId', 'v']) &&
    written.kind === 'pinChat' && written.sessionId === SID && written.account === 'Madeup-Pin' && written.device === 'Made-up phone' && written.from === 'hub',
    JSON.stringify(written))
  check('a window taking it gets the request back', (requests.claim(ROOT, ok.id) || {}).account === 'Madeup-Pin')
  requests.finish(ROOT, ok.id, { ok: true, state: requests.STATES.REOPENED, text: '"Made-up chat" is pinned to Madeup-Pin and reopened on it.' })
  const got = requests.result(ROOT, ok.id)
  check('requests.result is {ok, state, text, at}', got && JSON.stringify(Object.keys(got).sort()) === JSON.stringify(['at', 'ok', 'state', 'text']) &&
    got.ok === true && got.state === 'reopened' && typeof got.text === 'string' && typeof got.at === 'number', JSON.stringify(got))

  check('requests.alive with no window: []', Array.isArray(requests.alive(ROOT)) && requests.alive(ROOT).length === 0)
  requests.beat(ROOT, { version: '1.5.0' })
  const win = requests.alive(ROOT)
  check('requests.alive lists a running window: [{pid, at, version}]', win.length === 1 && win[0].pid === process.pid && typeof win[0].at === 'number' && win[0].version === '1.5.0', JSON.stringify(win))
  requests.unbeat(ROOT)

  fs.rmSync(ROOT, { recursive: true, force: true })
  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  if (fail) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
