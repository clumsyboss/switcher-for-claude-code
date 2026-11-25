require('./fake-security')
const fs = require('fs')
const os = require('os')
const path = require('path')

const requests = require('../lib/requests.js')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-requests-'))
const CHAT = '6b8cbf67-1111-4222-8333-944455556666'
const DAY = 86400000

let pass = 0, fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  <- ' + extra : '')) }
}

function account(name, days) {
  fs.mkdirSync(path.join(ROOT, 'profiles'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'profiles', name + '.enc'), 'x')
  if (days !== undefined) {
    fs.mkdirSync(path.join(ROOT, 'pinning'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, 'pinning', name + '.json'), JSON.stringify({ v: 1, expiresAt: Date.now() + days * DAY }))
  }
}
const files = () => { try { return fs.readdirSync(requests.dir(ROOT)).sort() } catch { return [] } }

account('Work', 20)
account('Home')
account('Old', 0.01)

console.log('-- submit checks before writing anything --')
const bad = [
  [{ kind: 'deleteChat', sessionId: CHAT }, 'bad-kind', 'an unknown kind'],
  [{ kind: 'pinChat', sessionId: '../../etc', account: 'Work' }, 'bad-session', 'a chat id that is not uuid-like'],
  [{ kind: 'pinChat', sessionId: CHAT, account: 'Nobody' }, 'no-account', 'an account that is not saved'],
  [{ kind: 'pinChat', sessionId: CHAT, account: '../Work' }, 'no-account', 'a name the store would refuse'],
  [{ kind: 'pinChat', sessionId: CHAT, account: 'Home' }, 'no-pinning-login', 'an account with no pinning login'],
  [{ kind: 'pinChat', sessionId: CHAT, account: 'Old' }, 'login-ended', 'a pinning login with under an hour left'],
  [null, 'bad-request', 'nothing at all'],
]
for (const [req, reason, label] of bad) {
  const r = requests.submit(ROOT, req)
  check(label + ': ' + reason, r && r.ok === false && r.reason === reason && typeof r.text === 'string' && r.text.length > 0, JSON.stringify(r))
}
check('and nothing was written', files().length === 0, files().join(','))

console.log('\n-- a good request --')
const t0 = Date.now()
const a = requests.submit(ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'Work', device: 'Pixel\nphone', now: t0 })
check('is accepted with a random id', a.ok === true && requests.validId(a.id), JSON.stringify(a))
const onDisk = JSON.parse(fs.readFileSync(requests.requestFile(ROOT, a.id), 'utf8'))
check('written as <id>.json with the contract\'s fields', onDisk.v === 1 && onDisk.id === a.id && onDisk.kind === 'pinChat' &&
  onDisk.sessionId === CHAT && onDisk.account === 'Work' && onDisk.from === 'hub' && onDisk.at === t0 && onDisk.device === 'Pixel phone', JSON.stringify(onDisk))
check('no temp file is left behind (written atomically)', files().length === 1, files().join(','))
const b = requests.submit(ROOT, { kind: 'unpinChat', sessionId: CHAT, now: t0 + 1 })
check('an unpin needs no account', b.ok === true && b.id !== a.id && !('account' in JSON.parse(fs.readFileSync(requests.requestFile(ROOT, b.id), 'utf8'))))
check('result is null until a window answers', requests.result(ROOT, a.id) === null)
check('result of an id that is not one is null', requests.result(ROOT, '../x') === null)
const p = requests.pending(ROOT, t0 + 5000)
check('pending lists both, oldest first, with their age', p.length === 2 && p[0].id === a.id && p[0].ageMs === 5000, JSON.stringify(p.map((x) => [x.id, x.ageMs])))

console.log('\n-- two windows race to claim it --')
const first = requests.claim(ROOT, a.id, 1111)
const second = requests.claim(ROOT, a.id, 2222)
check('only one gets it', first && first.id === a.id && second === null)
check('it is renamed <id>.claimed-<pid>', fs.existsSync(requests.claimFile(ROOT, a.id, 1111)) && !fs.existsSync(requests.requestFile(ROOT, a.id)))
check('a claimed request is no longer pending', !requests.pending(ROOT).some((x) => x.id === a.id))
requests.finish(ROOT, a.id, { ok: true, state: 'reopened', text: 'done' }, 1111)
const ra = requests.result(ROOT, a.id)
check('finish writes the result and drops the claim', ra && ra.ok === true && ra.state === 'reopened' && ra.text === 'done' && typeof ra.at === 'number' &&
  !fs.existsSync(requests.claimFile(ROOT, a.id, 1111)), JSON.stringify(ra))

console.log('\n-- sweep --')
const alive = (pid) => pid === process.pid
let s = requests.sweep(ROOT, { now: Date.now() + 60000, pidAlive: alive })
check('a request under 2 minutes old is left for the windows', s.expired === 0 && requests.result(ROOT, b.id) === null, JSON.stringify(s))
s = requests.sweep(ROOT, { now: Date.now() + requests.EXPIRE_MS + 1000, pidAlive: alive })
const rb = requests.result(ROOT, b.id)
check('one nobody took in 2 minutes is answered "expired"', s.expired === 1 && rb && rb.ok === false && rb.state === 'expired' &&
  rb.text === 'No VS Code window picked this up. Is VS Code open?', JSON.stringify(rb))
check('and its request file is gone', !fs.existsSync(requests.requestFile(ROOT, b.id)) && !files().some((f) => f.startsWith(b.id + '.claimed')))
const c = requests.submit(ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'Work' })
requests.claim(ROOT, c.id, 999999)
s = requests.sweep(ROOT, { pidAlive: alive })
const rc = requests.result(ROOT, c.id)
check('a claim whose window has gone, with no pin written, is answered "failed"', s.failed === 1 && rc && rc.ok === false && rc.state === 'failed', JSON.stringify(rc))
check('and the claim is dropped', !fs.existsSync(requests.claimFile(ROOT, c.id, 999999)))
const chatPins = require('../lib/chatpins.js')
const c2 = requests.submit(ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'Work' })
requests.claim(ROOT, c2.id, 999999)
chatPins.set(ROOT, CHAT, 'Work', 'Fix the made-up widget')
s = requests.sweep(ROOT, { pidAlive: alive })
const rc2 = requests.result(ROOT, c2.id)
check('a pin written before its window closed is answered "pinned", not "failed"', s.done === 1 && rc2 && rc2.ok === true && rc2.state === 'pinned' &&
  rc2.text.includes('"Fix the made-up widget" is pinned to Work'), JSON.stringify(rc2))
const c3 = requests.submit(ROOT, { kind: 'unpinChat', sessionId: CHAT })
requests.claim(ROOT, c3.id, 999999)
s = requests.sweep(ROOT, { pidAlive: alive })
check('an unpin whose window closed while the pin is still there is "failed"', requests.result(ROOT, c3.id).state === 'failed')
const c4 = requests.submit(ROOT, { kind: 'unpinChat', sessionId: CHAT })
requests.claim(ROOT, c4.id, 999999)
chatPins.remove(ROOT, CHAT)
s = requests.sweep(ROOT, { pidAlive: alive })
const rc4 = requests.result(ROOT, c4.id)
check('and one whose pin is gone is "unpinned"', rc4 && rc4.ok === true && rc4.state === 'unpinned', JSON.stringify(rc4))
const d = requests.submit(ROOT, { kind: 'unpinChat', sessionId: CHAT })
requests.claim(ROOT, d.id, process.pid)
s = requests.sweep(ROOT, { pidAlive: alive })
check('a claim by a window still running is left alone', fs.existsSync(requests.claimFile(ROOT, d.id, process.pid)) && requests.result(ROOT, d.id) === null)
requests.finish(ROOT, d.id, { ok: true, state: 'unpinned', text: 'x' })
s = requests.sweep(ROOT, { now: Date.now() + requests.KEEP_MS + 60000, pidAlive: alive })
check('everything older than an hour is deleted', files().length === 0 && s.removed >= 3, JSON.stringify(s) + ' ' + files().join(','))
check('sweep of a root with no requests folder does nothing', JSON.stringify(requests.sweep(path.join(ROOT, 'none'))) === '{"expired":0,"failed":0,"done":0,"removed":0}')

console.log('\n-- limits: size, count, age --')
const big = 'abcdef0123456789abcdef0123456789'
fs.mkdirSync(requests.dir(ROOT), { recursive: true })
fs.writeFileSync(requests.requestFile(ROOT, big), JSON.stringify({ v: 1, id: big, kind: 'unpinChat', sessionId: CHAT, at: Date.now(), pad: 'x'.repeat(5000) }))
check('a request file over 4 KB is never read', requests.pending(ROOT).length === 0 && requests.claim(ROOT, big) === null && requests.result(ROOT, big).state === 'failed')
fs.writeFileSync(requests.requestFile(ROOT, 'abcdef0123456788'), 'x'.repeat(5000))
s = requests.sweep(ROOT)
check('and sweep answers and drops one', s.failed === 1 && !fs.existsSync(requests.requestFile(ROOT, 'abcdef0123456788')) && requests.result(ROOT, 'abcdef0123456788').state === 'failed', JSON.stringify(s))
fs.rmSync(requests.dir(ROOT), { recursive: true, force: true })
const many = []
for (let i = 0; i < requests.MAX_PENDING; i++) many.push(requests.submit(ROOT, { kind: 'unpinChat', sessionId: CHAT }))
const tooMany = requests.submit(ROOT, { kind: 'unpinChat', sessionId: CHAT })
check('50 waiting requests at most: the 51st is refused with "too-many" and words', many.every((r) => r.ok) && tooMany.ok === false && tooMany.reason === 'too-many' && !!tooMany.text, JSON.stringify(tooMany))
fs.rmSync(requests.dir(ROOT), { recursive: true, force: true })
const fut = requests.submit(ROOT, { kind: 'unpinChat', sessionId: CHAT })
const futFile = requests.requestFile(ROOT, fut.id)
const fj = JSON.parse(fs.readFileSync(futFile, 'utf8')); fj.at = Date.now() + 10 * DAY; fs.writeFileSync(futFile, JSON.stringify(fj))
const past = (Date.now() - 3 * 60000) / 1000
fs.utimesSync(futFile, past, past)
check('a request\'s age runs from its file when its "at" is in the future', requests.pending(ROOT)[0].ageMs > requests.EXPIRE_MS)
s = requests.sweep(ROOT)
check('so a future "at" can\'t keep it alive: it expires', s.expired === 1 && requests.result(ROOT, fut.id).state === 'expired')
const odd = requests.submit(ROOT, { kind: 'unpinChat', sessionId: CHAT })
const oj = JSON.parse(fs.readFileSync(requests.requestFile(ROOT, odd.id), 'utf8')); oj.at = 'soon'; fs.writeFileSync(requests.requestFile(ROOT, odd.id), JSON.stringify(oj))
fs.utimesSync(requests.requestFile(ROOT, odd.id), past, past)
check('and one whose "at" is not a number ages from its file', requests.pending(ROOT)[0].ageMs > requests.EXPIRE_MS)
fs.rmSync(requests.dir(ROOT), { recursive: true, force: true })

console.log('\n-- heartbeats: which windows take requests --')
check('no windows: alive() is empty', requests.alive(ROOT).length === 0)
requests.beat(ROOT, { version: '1.5.0' })
let al = requests.alive(ROOT)
check('a window\'s beat makes it alive, with its pid, time and version', al.length === 1 && al[0].pid === process.pid && al[0].version === '1.5.0' && typeof al[0].at === 'number', JSON.stringify(al))
check('the file is .alive-<pid>.json in requests/', fs.existsSync(path.join(requests.dir(ROOT), '.alive-' + process.pid + '.json')))
check('a beat over 30 seconds old does not count', requests.alive(ROOT, { now: Date.now() + requests.ALIVE_MS + 1000 }).length === 0)
check('nor one whose process has ended', requests.alive(ROOT, { pidAlive: () => false }).length === 0)
requests.beat(ROOT, { pid: 999999, now: Date.now() + 10 * DAY })
const pst = (Date.now() - 60000) / 1000
fs.utimesSync(path.join(requests.dir(ROOT), '.alive-999999.json'), pst, pst)
check('a beat dated in the future counts from its file\'s time: a minute old, not alive', requests.alive(ROOT, { pidAlive: () => true }).length === 1)
check('beats are not requests', requests.pending(ROOT).length === 0)
s = requests.sweep(ROOT, { pidAlive: (p) => p === process.pid })
check('sweep drops the beat of a window that has gone, and keeps a live one', !fs.existsSync(path.join(requests.dir(ROOT), '.alive-999999.json')) && requests.alive(ROOT).length === 1)
requests.unbeat(ROOT)
check('unbeat (the window closing) removes it', requests.alive(ROOT).length === 0 && !fs.existsSync(path.join(requests.dir(ROOT), '.alive-' + process.pid + '.json')))

console.log('\n-- constants the hub words --')
check('STATES: pinned, waiting, reopened, unpinned, needs-reopen, failed, expired',
  JSON.stringify(Object.values(requests.STATES)) === JSON.stringify(['pinned', 'waiting', 'reopened', 'unpinned', 'needs-reopen', 'failed', 'expired']))
check('REASONS: the six checks and too-many',
  JSON.stringify(Object.values(requests.REASONS)) === JSON.stringify(['bad-request', 'bad-kind', 'bad-session', 'no-account', 'no-pinning-login', 'login-ended', 'too-many']))

console.log('\n-- what a window checks again --')
check('check passes a good pin', requests.check(ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'Work' }).ok === true)
check('check fails a pin whose account lost its pinning login since', (() => {
  fs.rmSync(path.join(ROOT, 'pinning', 'Work.json'))
  const r = requests.check(ROOT, { kind: 'pinChat', sessionId: CHAT, account: 'Work' })
  return r.ok === false && r.reason === 'no-pinning-login'
})())
fs.writeFileSync(path.join(requests.dir(ROOT), 'abcdef12.json'), '{not json')
check('a request that cannot be read (mid-write) is skipped', requests.pending(ROOT).length === 0)

fs.rmSync(ROOT, { recursive: true, force: true })
console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
