require('./fake-security')
const assert = require('assert')
const cp = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const health = require('../lib/health')

let pass = 0
let fail = 0
function check(name, ok) {
  if (ok) { pass++; console.log('  PASS  ' + name) } else { fail++; console.log('  FAIL  ' + name) }
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'health-')))
const root = path.join(tmp, 'root')
fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
const DAY = 86400e3
const NOW = Date.UTC(2026, 10, 18, 12)
const ID = '6b8cbf67-1111-4222-8333-944455556666'

function script(name, body) {
  const f = path.join(tmp, name)
  fs.writeFileSync(f, '#!/bin/sh\n' + body + '\n')
  fs.chmodSync(f, 0o755)
  return f
}
const hasSh = cp.spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout === 'ok\n'
const byState = (rows, area, name) => rows.find((r) => r.area === area && r.name === name)

;(async () => {
  console.log('-- self-test --')
  const missing = await health.selfTest(path.join(tmp, 'nope.exe'))
  check('no wrapper there: not ok, "missing"', !missing.ok && missing.reason === 'missing' && missing.version === null)
  check('no path at all: the same', (await health.selfTest(null)).reason === 'missing')
  const exe = path.join(__dirname, '..', 'wrapper', 'claude-wrapper.exe')
  if (process.platform === 'win32') {
    const r = await health.selfTest(exe)
    check('the real Windows wrapper answers with its version', r.ok && /^\d+\.\d+\.\d+$/.test(r.version) && r.reason === null)
  }
  if (hasSh) {
    const r = await health.selfTest(path.join(__dirname, '..', 'wrapper', 'claude-wrapper.sh'))
    check('the real macOS/Linux wrapper answers with its version', r.ok && /^\d+\.\d+\.\d+$/.test(r.version))
    const wrong = await health.selfTest(script('wrong.sh', 'echo "something else"'))
    check('a program that answers something else: not ours', !wrong.ok && wrong.reason === 'unexpected answer')
    const failing = await health.selfTest(script('fails.sh', 'exit 3'))
    check('one that fails: its exit code', !failing.ok && failing.reason === 'exit 3')
    const t0 = Date.now()
    const slow = await health.selfTest(script('slow.sh', 'exec sleep 8'), { timeoutMs: 400 })
    check('one that never answers is stopped quickly, and reported', !slow.ok && slow.reason === 'timed out' && Date.now() - t0 < 5000)
    const chatty = await health.selfTest(script('chatty.sh', 'exec yes'), { timeoutMs: 3000 })
    check('one that floods its output is stopped too', !chatty.ok && chatty.reason === 'unexpected answer')
  } else console.log('  (no sh here: fake wrappers are checked where there is one)')

  console.log('-- the report --')
  const wrapperPath = path.join(root, 'bin', 'claude-wrapper.exe')
  const okTest = { ok: true, version: '1.4.0', reason: null }
  const accounts = [
    { name: 'Work', main: { expiresAt: NOW + 20 * DAY }, pinning: { expiresAt: NOW + 25 * DAY, dir: path.join(root, 'pinning', 'Work') } },
    { name: 'Home', main: { expiresAt: NOW + 3 * DAY }, pinning: { expiresAt: NOW + 30 * 60e3, dir: path.join(root, 'pinning', 'Home') } },
    { name: 'Old', main: { expiresAt: NOW - DAY }, pinning: null },
    { name: 'Moved', main: { expiresAt: NOW + 10 * DAY }, pinning: { expiresAt: NOW + 10 * DAY, dir: path.join(tmp, 'elsewhere', 'Moved') } },
  ]

  let rows = await health.report({ root, wrapperPath, wrapperSetting: '', logins: accounts, pins: [], claudeVersion: '2.1.326', now: NOW })
  check('every row has an area, a name, a state and some text', rows.length > 0 && rows.every((r) => r.area && r.name && ['ok', 'warn', 'bad'].includes(r.state) && r.text))
  check('nothing pinned and no wrapper: a warning, not an error', byState(rows, 'wrapper', 'Installed').state === 'warn' &&
    byState(rows, 'wrapper', 'Claude Code setting').state === 'ok')
  check('Claude Code\'s version is shown', /2\.1\.326/.test(byState(rows, 'claude', 'Claude Code').text))
  check('logins: plenty of time is ok, under 5 days a warning, ended is bad', byState(rows, 'login', 'Work').state === 'ok' &&
    byState(rows, 'login', 'Home').state === 'warn' && /3 days left/.test(byState(rows, 'login', 'Home').text) && byState(rows, 'login', 'Old').state === 'bad')
  check('the last day says so in hours', byState(rows, 'pinning', 'Home').state === 'warn' && /ends today \(1 hour left\)|ends today \(\d+ hours? left\)/.test(byState(rows, 'pinning', 'Home').text))
  check('a pinning login outside its own folder is bad', byState(rows, 'pinning', 'Moved').state === 'bad')
  check('accounts without a pinning login get no pinning row', !byState(rows, 'pinning', 'Old'))

  fs.writeFileSync(wrapperPath, 'fake')
  const pins = [{ kind: 'chat', name: 'Work' }, { kind: 'folder', name: 'Work' }, { kind: 'folder', name: 'Home' }, { kind: 'chat', name: 'Old' }, { kind: 'chat', name: 'Gone' }]
  rows = await health.report({ root, wrapperPath, wrapperSetting: wrapperPath, logins: accounts, pins, claudeVersion: null, selfTest: okTest, now: NOW })
  check('pins, wrapper installed, answering and switched on: all ok', byState(rows, 'wrapper', 'Installed').state === 'ok' &&
    byState(rows, 'wrapper', 'Self-test').state === 'ok' && /1\.4\.0/.test(byState(rows, 'wrapper', 'Self-test').text) &&
    byState(rows, 'wrapper', 'Claude Code setting').state === 'ok')
  check('an unknown Claude Code version is a warning', byState(rows, 'claude', 'Claude Code').state === 'warn')
  check('a pinned account on a good pinning login: ok, with its pin count', byState(rows, 'pins', 'Work').state === 'ok' && /^2 pins/.test(byState(rows, 'pins', 'Work').text))
  check('a pinning login ending within the hour: its pins fall back, bad', byState(rows, 'pins', 'Home').state === 'bad')
  check('pinned with no pinning login, or no longer saved: bad', byState(rows, 'pins', 'Old').state === 'bad' && byState(rows, 'pins', 'Gone').state === 'bad')

  rows = await health.report({ root, wrapperPath, wrapperSetting: '', logins: accounts, pins, claudeVersion: '2.1.326', selfTest: { ok: false, version: null, reason: 'timed out' }, now: NOW })
  check('pins but the setting is off: bad', byState(rows, 'wrapper', 'Claude Code setting').state === 'bad')
  check('pins but the wrapper doesn\'t answer: bad, with the reason', byState(rows, 'wrapper', 'Self-test').state === 'bad' && /timed out/.test(byState(rows, 'wrapper', 'Self-test').text))
  rows = await health.report({ root, wrapperPath, wrapperSetting: path.join(tmp, 'mine.exe'), logins: accounts, pins, claudeVersion: '2.1.326', selfTest: okTest, now: NOW })
  check('someone else\'s wrapper with pins: bad, and named', byState(rows, 'wrapper', 'Claude Code setting').state === 'bad' && /mine\.exe/.test(byState(rows, 'wrapper', 'Claude Code setting').text))
  rows = await health.report({ root, wrapperPath, wrapperSetting: wrapperPath, logins: accounts, pins: [], claudeVersion: '2.1.326', selfTest: okTest, now: NOW })
  check('ours still on with nothing pinned: a warning', byState(rows, 'wrapper', 'Claude Code setting').state === 'warn')

  console.log('-- read from the switcher\'s own files --')
  fs.writeFileSync(path.join(root, 'pins.tsv'), ['login\tWork\t' + (NOW + 25 * DAY) + '\t' + path.join(root, 'pinning', 'Work'),
    'chat\t' + ID + '\tWork', 'folder\t' + path.join(tmp, 'site') + '\tWork', 'garbage'].join('\n') + '\n')
  check('pins come from pins.tsv when not given', JSON.stringify(health.readPins(root)) === JSON.stringify([{ kind: 'chat', name: 'Work' }, { kind: 'folder', name: 'Work' }]))
  const inuse = path.join(root, 'pinning', '.inuse')
  fs.mkdirSync(inuse, { recursive: true })
  const note = (pid) => JSON.stringify({ v: 1, name: 'Work', pid, sessionId: null, cwd: tmp, startedAt: NOW })
  fs.writeFileSync(path.join(inuse, process.pid + '.json'), note(process.pid))
  const dead = cp.spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim()
  fs.writeFileSync(path.join(inuse, dead + '.json'), note(Number(dead)))
  fs.writeFileSync(path.join(inuse, '123.json'), 'half')
  check('running chats are the in-use notes whose pid is alive', health.liveNotes(root).length === 1 && health.liveNotes(root)[0].pid === process.pid)
  rows = await health.report({ root, wrapperPath, wrapperSetting: wrapperPath, logins: accounts, claudeVersion: '2.1.326', selfTest: okTest, now: NOW })
  check('and the report says so, and uses pins.tsv', /1 chat is running/.test(byState(rows, 'pins', 'Running now').text) && byState(rows, 'pins', 'Work').state === 'ok')
  check('reading changes nothing (notes stay, even dead ones)', fs.readdirSync(inuse).length === 3)
  rows = await health.report({})
  check('no input at all: still rows, never a throw', Array.isArray(rows) && rows.length > 0)

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(pass + ' passed, ' + fail + ' failed')
  assert.strictEqual(fail, 0, 'health tests failed')
})().catch((e) => { console.error(e); process.exit(1) })
