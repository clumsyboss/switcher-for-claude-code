require('./fake-security')

const assert = require('assert')
const cp = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

delete process.env.CLAUDE_CONFIG_DIR
const act = require('../lib/activity.js')

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-activity-'))
let n = 0
const fresh = () => { const r = path.join(TMP, 'root-' + (++n)); fs.mkdirSync(r, { recursive: true }); return r }
const MIN = 60e3
const H = 3600e3
const D = 24 * H
const T = Date.now()

async function main() {
  console.log('-- an entry is kept in the shape the page reads --')
  {
    const R = fresh()
    const id = act.record(R, { kind: 'switch', by: 'autocontinue', from: 'work', fromLabel: 'Day Job', to: 'pro', toLabel: 'Weekend Me', chat: 'Fix the login page',
      limit: 'session', resetAt: T + 2 * H, toUsed: 8, pick: 'room', waited: false, asked: false, secret: 'not a field' }, { key: 'k1' })
    const got = act.list(R).entries[0]
    check('it is written and listed, newest first', !!id && got.kind === 'switch' && got.by === 'autocontinue' && got.chat === 'Fix the login page')
    check('with the facts the page words', got.fromLabel === 'Day Job' && got.toUsed === 8 && got.pick === 'room' && got.limit === 'session' && got.resetAt === T + 2 * H)
    check('a field that is not on the list is dropped', !('secret' in got))
    check('the log\'s own bookkeeping (key, chat id) is not sent to the page', !('k' in got) && !('c' in got) && typeof got.id === 'string' && typeof got.at === 'number')
    check('a switch with no account or no "by" is not an entry', act.record(R, { kind: 'switch', by: 'page' }) === null && act.record(R, { kind: 'switch', to: 'pro' }) === null)
    check('an unknown kind is not an entry', act.record(R, { kind: 'whatever', at: T }) === null)
    check('a value of the wrong kind is dropped, not stored', (() => {
      act.record(R, { kind: 'stop', chat: 'x', limit: 'daily', resetAt: 'tomorrow', lateMs: -5, asked: 'yes' })
      const s = act.list(R).entries[0]
      return s.kind === 'stop' && !('limit' in s) && !('resetAt' in s) && !('lateMs' in s) && !('asked' in s)
    })())
    check('a chat entry keeps its chat id (for Open chat), and an id that is not one is dropped', (() => {
      act.record(R, { kind: 'stop', chat: 'Fix', chatId: '4f6c1d52-9a1b-4e0e-8c1d-1234567890ab', limit: 'session' })
      act.record(R, { kind: 'stop', chat: 'Bad', chatId: 'C:\\x\\y z', limit: 'session' })
      const l = act.list(R).entries
      return l.find((x) => x.chat === 'Fix').chatId === '4f6c1d52-9a1b-4e0e-8c1d-1234567890ab' && !('chatId' in l.find((x) => x.chat === 'Bad'))
    })())
    check('the file is private to the person (0600)', process.platform === 'win32' || (fs.statSync(act.filePath(R)).mode & 0o777) === 0o600)
  }

  console.log('\n-- one entry, however many windows see the event --')
  {
    const R = fresh()
    check('the same key twice writes once', act.record(R, { kind: 'roomagain', accountLabel: 'Day Job' }, { key: 'roomagain:work:1' }) !== null &&
      act.record(R, { kind: 'roomagain', accountLabel: 'Day Job' }, { key: 'roomagain:work:1' }) === null && act.list(R).entries.length === 1)
    const lib = JSON.stringify(path.join(__dirname, '..', 'lib', 'activity.js'))
    const kids = [0, 1, 2].map((id) => cp.spawn(process.execPath, ['-e',
      'const a = require(' + lib + ');' +
      'for (let i = 0; i < 30; i++) a.record(' + JSON.stringify(R) + ', { kind: "keepalive", accountLabel: "A", ok: true }, { key: "shared:" + i });' +
      'for (let i = 0; i < 10; i++) a.record(' + JSON.stringify(R) + ', { kind: "lastday", accountLabel: "B" + ' + id + ' }, { key: "own:' + id + ':" + i })'],
    { stdio: ['ignore', 'ignore', 'pipe'] }))
    const errs = []
    kids.forEach((k) => k.stderr.on('data', (d) => errs.push(String(d))))
    await Promise.all(kids.map((k) => new Promise((res) => k.on('exit', res))))
    const all = act.list(R, { limit: 500 }).entries
    check('three programs at once: each shared event once, none lost', all.filter((e) => e.kind === 'keepalive').length === 30 && all.filter((e) => e.kind === 'lastday').length === 30,
      all.length + ' ' + errs.join('').slice(0, 200))
    check('ids are all different', new Set(all.map((e) => e.id)).size === all.length)
    check('the file is still whole', (() => { try { JSON.parse(fs.readFileSync(act.filePath(R), 'utf8')); return true } catch { return false } })())
  }

  console.log('\n-- a switch noticed from outside, and the switch itself --')
  {
    const R = fresh()
    act.record(R, { kind: 'switch', by: 'seen', from: 'work', to: 'pro', at: T }, { key: 's1' })
    act.record(R, { kind: 'switch', by: 'early', from: 'work', to: 'pro', at: T + 5000, fromUsed: 80 }, { key: 's2' })
    const sw = act.list(R).entries.filter((e) => e.kind === 'switch')
    check('a window that noticed it a moment before the maker wrote it is replaced by the maker\'s own entry', sw.length === 1 && sw[0].by === 'early')
    act.record(R, { kind: 'switch', by: 'seen', from: 'work', to: 'pro', at: T + 9000 }, { key: 's3' })
    check('and one that notices it a moment after is not written', act.list(R).entries.filter((e) => e.kind === 'switch').length === 1)
    act.record(R, { kind: 'switch', by: 'page', from: 'pro', to: 'work', at: T + 10000 }, { key: 's3a' })
    act.record(R, { kind: 'switch', by: 'seen', from: 'work', to: 'pro', at: T + 20000 }, { key: 's3b' })
    check('a change noticed to the account the Switcher switched to just before, after a switch away, is a new event and is kept',
      act.list(R).entries.filter((e) => e.kind === 'switch' && e.by === 'seen' && e.to === 'pro').length === 1)
    act.record(R, { kind: 'switch', by: 'seen', from: 'pro', to: 'side', at: T + 5 * MIN }, { key: 's4' })
    check('a real outside change, to another account, is kept', act.list(R).entries.filter((e) => e.kind === 'switch' && e.by === 'seen' && e.to === 'side').length === 1)
  }

  console.log('\n-- retention: 30 days, at most 2,000 --')
  {
    const R = fresh()
    act.record(R, { kind: 'keepalive', accountLabel: 'A', ok: true, at: T - 31 * D })
    act.record(R, { kind: 'keepalive', accountLabel: 'B', ok: true, at: T - 29 * D })
    act.record(R, { kind: 'keepalive', accountLabel: 'C', ok: true, at: T })
    check('an entry older than 30 days drops off', act.list(R).entries.map((e) => e.accountLabel).join() === 'C,B')
    const R2 = fresh()
    const entries = []
    for (let i = 1; i <= 2050; i++) entries.push({ id: String(i), at: T - (2050 - i) * MIN, kind: 'keepalive', accountLabel: 'n' + i, ok: true })
    fs.writeFileSync(act.filePath(R2), JSON.stringify({ v: 1, seq: 2050, seenAt: T, keys: {}, entries }))
    act.record(R2, { kind: 'lastday', accountLabel: 'newest', at: T + MIN })
    const got = act.list(R2, { limit: 5000 }).entries
    check('more than 2,000 entries: the oldest drop off', got.length === act.MAX_ENTRIES && got[0].accountLabel === 'newest' && !got.some((e) => e.accountLabel === 'n1'))
    check('the cap and the days are the constants the owner chose', act.MAX_ENTRIES === 2000 && act.KEEP_MS === 30 * D)
  }

  console.log('\n-- paging, unseen, clear --')
  {
    const R = fresh()
    for (let i = 0; i < 400; i++) act.record(R, { kind: 'keepalive', accountLabel: 'n' + i, ok: true, at: T - (400 - i) * MIN })
    const p1 = act.list(R)
    check('the first page is the 150 newest, with more behind it', p1.entries.length === 150 && p1.more === true && p1.entries[0].accountLabel === 'n399')
    const p2 = act.list(R, { before: p1.entries[149].id })
    check('"before" gives the next older ones, continuing where the page stopped', p2.entries.length === 150 && p2.entries[0].accountLabel === 'n249' && p2.more === true)
    const p3 = act.list(R, { before: p2.entries[149].id })
    check('and the last page says there is no more', p3.entries.length === 100 && p3.more === false)
    check('an id that is gone gives nothing', act.list(R, { before: 'nope' }).entries.length === 0)
    check('a new log has nothing unseen, and what happens after is unseen', (() => {
      const R2 = fresh()
      act.clear(R2, T - H)
      act.record(R2, { kind: 'keepalive', accountLabel: 'A', ok: true, at: T - 2 * H })
      act.record(R2, { kind: 'keepalive', accountLabel: 'B', ok: true, at: T - 10 * MIN })
      act.record(R2, { kind: 'keepalive', accountLabel: 'C', ok: true, at: T })
      return act.unseen(R2) === 2
    })())
    act.markSeen(R, T + MIN)
    check('opening the log marks everything up to now as looked at', act.unseen(R) === 0)
    act.clear(R)
    check('clearing empties the list and nothing else', act.list(R).entries.length === 0 && act.unseen(R) === 0)
  }

  console.log('\n-- nothing secret, and no file path, ever reaches the file --')
  {
    const R = fresh()
    const hostile = 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUv fix mail alex.smith@example.com C:\\Users\\alex\\secret.txt /home/alex/keys.pem ~/ssh/id token=abcdef0123456789 ' +
      'Bearer abc.def-ghi eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd'
    act.record(R, { kind: 'stop', chat: hostile, accountLabel: hostile, limit: 'session', resetAt: T })
    act.record(R, { kind: 'switch', by: 'page', from: 'work', to: 'pro', fromLabel: 'me@corp.example', toLabel: 'Pro', chat: hostile })
    act.record(R, { kind: 'continue', chat: hostile, how: 'reset', accountLabel: hostile, outcome: 'sent', accessToken: 'AT-1', refreshToken: 'RT-1', file: 'C:\\x\\chat.jsonl' })
    act.record(R, { kind: 'keepalive', accountLabel: 'Day Job', ok: true, email: 'a@b.example', token: 'sk-ant-abcdefghijklmnop' })
    act.recordPhone(R, { chatId: 'c1', chat: hostile, at: T, key: 'u1', words: hostile })
    const raw = fs.readFileSync(act.filePath(R), 'utf8')
    const bad = [/sk-ant/i, /@example\.com|@corp\.example|@b\.example/, /C:\\\\Users|C:\/Users|\\\\secret|keys\.pem|\/home\/alex|~\/ssh/, /token=abcdef/i, /Bearer/i, /eyJhbGci/,
      /ABCDEFGHIJKLMNOPQRSTUVWXYZ0123/, /AT-1|RT-1|accessToken|refreshToken/, /chat\.jsonl/]
    check('no token, key, email address or path in the file after hostile input', bad.every((re) => !re.test(raw)), bad.filter((re) => re.test(raw)).join(' '))
    check('what a person can still read is kept ("fix", the label, the chat title words)', /fix/.test(raw) && /Day Job/.test(raw))
    check('a chat title and label the person saw are kept as they were', (() => {
      const R2 = fresh()
      act.record(R2, { kind: 'stop', chat: 'Fix the login page (v2)', accountLabel: 'Side Hustle', limit: 'weekly' })
      const e = act.list(R2).entries[0]
      return e.chat === 'Fix the login page (v2)' && e.accountLabel === 'Side Hustle'
    })())
  }

  console.log('\n-- messages from the phone --')
  {
    const body = (words, name) => words + '\n\n(' + 'Typed by the user on their phone and sent through ' + (name || 'Awaydesk') + ', their own app on this PC.)'
    const peerUser = (text, name, ts, extra) => Object.assign({ type: 'user', isMeta: true, uuid: 'u-' + ts, timestamp: new Date(ts).toISOString(), origin: { kind: 'peer', name: name || 'Awaydesk', body: text } }, extra)
    const queued = (text, name, ts) => ({ type: 'attachment', uuid: 'q-' + ts, timestamp: new Date(ts).toISOString(), attachment: { type: 'queued_command', origin: { kind: 'peer', name: name || 'Awaydesk', body: text } } })
    check('a message into a chat is found, with the user\'s own words', (() => { const p = act.phoneIn(peerUser(body('Did the tests pass?'), 'Awaydesk', T)); return p && p.words === 'Did the tests pass?' && p.at === T })())
    check('one sent while Claude was busy (a queued command) is found too', (() => { const p = act.phoneIn(queued(body('Skip the slow ones'), 'Awaydesk', T)); return p && p.words === 'Skip the slow ones' })())
    check('the earlier names are still recognised (Remote CC Hub, Claude Hub)', ['Remote CC Hub', 'Claude Hub'].every((nm) => { const p = act.phoneIn(peerUser(body('hi', nm), nm, T)); return p && p.words === 'hi' }))
    check('a message scheduled earlier is found', (() => {
      const m = 'Run it\n\n(Scheduled earlier by the user on their phone, and sent at the time they picked by Awaydesk, their own app on this PC.)'
      const p = act.phoneIn(peerUser(m, 'Awaydesk', T)); return p && p.words === 'Run it'
    })())
    check('the oldest form, the mark at the start, is found', (() => {
      const p = act.phoneIn(peerUser('Typed by the user on their phone, sent through Claude Hub (their own app on this PC): old words', 'Claude Hub', T)); return p && p.words === 'old words'
    })())
    check('the Switcher\'s own notice is not a phone message', act.phoneIn(peerUser('Automatic notice from Switcher for Claude Code: it has reset', 'Switcher for Claude Code', T)) === null)
    check('another session\'s message, or a person\'s own prompt, is not one', act.phoneIn(peerUser('please run the tests', 'agent-7', T)) === null &&
      act.phoneIn({ type: 'user', timestamp: new Date(T).toISOString(), message: { content: 'hello' } }) === null)
    check('a message from the phone side with no mark still counts when the sender is the phone side', (() => { const p = act.phoneIn(peerUser('plain words', 'Awaydesk', T)); return p && p.words === 'plain words' })())
    check('an agent\'s own side conversation is left out', act.phoneIn(peerUser(body('x'), 'Awaydesk', T, { isSidechain: true })) === null)

    const R = fresh()
    const rec = (chatId, at, words, key) => act.recordPhone(R, { chatId, chat: 'Fix the login page', at, key: key || 'k' + at, words })
    rec('c1', T - 50 * MIN, 'Did the tests pass after your last change? Please also run the linter, then the slow suite, and tell me about anything that fails')
    rec('c1', T - 40 * MIN, 'second')
    rec('c1', T - 30 * MIN, 'third')
    const ph = act.list(R).entries.filter((e) => e.kind === 'phone')
    check('messages to one chat close together are one entry, counted', ph.length === 1 && ph[0].count === 3 && ph[0].until === T - 30 * MIN && ph[0].at === T - 50 * MIN)
    check('the words shown are the first message\'s, cut short (about 80 characters)', ph[0].preview.startsWith('Did the tests pass') && ph[0].preview.length <= act.PREVIEW_MAX)
    rec('c1', T - 30 * MIN, 'third', 'k' + (T - 30 * MIN))
    check('the same message read again (by another window) is not counted twice', act.list(R).entries.filter((e) => e.kind === 'phone')[0].count === 3)
    rec('c1', T + 15 * MIN, 'much later')
    rec('c2', T - 4 * MIN, 'another chat')
    check('a later message, or another chat, is an entry of its own', act.list(R).entries.filter((e) => e.kind === 'phone').length === 3)
    check('the chat\'s id is not sent to the page', act.list(R).entries.every((e) => !('c' in e)))
    check('the key is the chat and the record, so every window gives the same one', act.hasKey(R, act.phoneKey('c1', 'k' + (T - 50 * MIN))) === true && act.hasKey(R, act.phoneKey('c9', 'k')) === false)
  }

  console.log('\n-- While you were away --')
  {
    const R = fresh()
    check('the first time ever there is nobody to welcome back', act.comeBack(R, T) === null)
    check('and a window coming back a minute later is not an absence', act.comeBack(R, T + MIN) === null)
    check('30 minutes is the rule, kept in one constant', act.AWAY_AFTER_MS === 30 * MIN)
    check('29 minutes is not away', act.comeBack(R, T + MIN + 29 * MIN) === null)
    const back = act.comeBack(R, T + MIN + 29 * MIN + 31 * MIN)
    check('31 minutes with no window in front is, from when the last one was in front', back && back.from === T + MIN + 29 * MIN && back.to === T + MIN + 29 * MIN + 31 * MIN)
    check('only the first window back is told: the other windows find the stamp fresh', act.comeBack(R, back.to + 5000) === null)
    check('and the next absence is told again', (() => { const b = act.comeBack(R, back.to + 5000 + 40 * MIN); return !!b && b.from === back.to + 5000 })())
    check('the editor opened again after a night (the stamp from last evening) is an absence', (() => {
      const R2 = fresh()
      act.comeBack(R2, T - 10 * H)
      const b = act.comeBack(R2, T)
      return !!b && b.from === T - 10 * H
    })())
    const R3 = fresh()
    act.comeBack(R3, T - 3 * H)
    const lib = JSON.stringify(path.join(__dirname, '..', 'lib', 'activity.js'))
    const outs = []
    const kids = [0, 1, 2].map(() => cp.spawn(process.execPath, ['-e',
      'const a = require(' + lib + '); process.stdout.write(JSON.stringify(a.comeBack(' + JSON.stringify(R3) + ', ' + T + ')))'], { stdio: ['ignore', 'pipe', 'pipe'] }))
    kids.forEach((k) => k.stdout.on('data', (d) => outs.push(String(d))))
    await Promise.all(kids.map((k) => new Promise((res) => k.on('exit', res))))
    check('three windows coming back together: one is told, the PC hears it once', outs.filter((o) => o !== 'null').length === 1 && outs.length === 3, outs.join(' '))
    const stamp = JSON.parse(fs.readFileSync(path.join(R3, act.AWAY_FILE), 'utf8'))
    check('the stamp is a small file beside the log, with no account or chat in it', Object.keys(stamp).sort().join() === 'lastFocused,told')
  }

  console.log('\n-- what the summary says, and leaves out --')
  {
    const e = (kind, f, at) => Object.assign({ id: String(Math.random()), at: at || T, kind }, f)
    const clock = (t) => 'a time'
    const list = [
      e('keepalive', { accountLabel: 'A', ok: true }), e('roomagain', { accountLabel: 'B' }), e('switch', { by: 'seen', from: 'a', to: 'b', toLabel: 'B' }),
      e('stop', { chat: 'Fix the login page', accountLabel: 'A', limit: 'session' }),
      e('switch', { by: 'autocontinue', from: 'a', to: 'b', toLabel: 'B', fromLabel: 'A', chat: 'Fix the login page' }),
      e('continue', { chat: 'Fix the login page', how: 'switched', accountLabel: 'B', outcome: 'continued' }),
      e('phone', { chat: 'Make the tests pass', count: 3, until: T }),
    ]
    const kept = act.awayEntries(list)
    check('keep alive, "has room again" and a change noticed from outside are left out of the summary', kept.length === 4 && !kept.some((x) => x.kind === 'keepalive' || x.kind === 'roomagain' || x.by === 'seen'))
    const text = act.awayText(kept, T - 3 * H, T, clock)
    check('the rest is said in one paragraph, with the span', /^While you were away \(3 h\): /.test(text) && /1 chat stopped at limits/.test(text) && /Auto-continue switched to B and continued 1 chat/.test(text) && /3 messages came from your phone/.test(text), text)
    check('and says nothing of the small things', !/Keep alive|room again|outside/.test(text), text)
    check('only small things happening means nothing is worth saying', act.awayLines(act.awayEntries([list[0], list[1], list[2]]), clock).length === 0 && act.awayText(act.awayEntries([list[0]]), T - H, T, clock) === '')
    const needy = act.awayLines([e('continue', { chat: 'Tidy the invoices script', how: 'reset', accountLabel: 'A', outcome: 'replied' })], clock)
    check('a chat that needs the person comes first', needy[0] === '“Tidy the invoices script” still needs you.', needy.join('|'))
    const many = []
    for (let i = 0; i < 9; i++) many.push(e('lastday', { accountLabel: 'X' + i }), e('stop', { chat: 'c' + i, limit: 'session', accountLabel: 'A' }), e('phone', { chat: 'p' + i, count: 1, until: T }),
      e('continue', { chat: 'n' + i, how: 'reset', accountLabel: 'A', outcome: 'replied' }), e('switch', { by: 'early', from: 'a', to: 'b', fromLabel: 'A', toLabel: 'B' }),
      e('switch', { by: 'autocontinue', from: 'a', to: 'b', toLabel: 'B' }), e('wait', { chat: 'w' + i, accountLabel: 'A', resetAt: T + H }))
    check('at most six lines, then "And N more things in the log."', (() => { const l = act.awayLines(many, clock); return l.length === 6 && /^And \d+ more things? in the log\.$/.test(l[5]) })())
    const R = fresh()
    act.record(R, { kind: 'stop', chat: 'Old', accountLabel: 'A', limit: 'session', at: T - 5 * H })
    act.record(R, { kind: 'stop', chat: 'New', accountLabel: 'A', limit: 'session', at: T - H })
    act.record(R, { kind: 'phone', chat: 'Fix', count: 2, until: T - 20 * MIN, at: T - 4 * H })
    check('the entries since the absence began, newest first (a phone run that reaches into it counts, and one that ended before does not)', act.since(R, T - 2 * H, T).map((x) => x.chat).join() === 'New,Fix')
    check('a phone entry that began before but went on after is included, and Old is not', act.since(R, T - 3 * H, T).some((x) => x.kind === 'phone') && !act.since(R, T - 3 * H, T).some((x) => x.chat === 'Old') &&
      !act.since(R, T - 10 * MIN, T).some((x) => x.kind === 'phone'))
  }

  console.log('\n-- a log write never holds anything up (1.5.4 fix round) --')
  {
    const locks = require('../lib/locks.js')
    const fsx = require('../lib/fsx.js')
    const R = fresh()
    const child = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' })
    const lockFile = locks.lockPath(R, 'activity')
    fs.mkdirSync(path.dirname(lockFile), { recursive: true })
    fs.writeFileSync(lockFile, JSON.stringify({ pid: child.pid, token: 'x', at: Date.now() }))
    let t0 = Date.now()
    const first = act.record(R, { kind: 'lastday', accountLabel: 'Held one' }, { key: 'held-1' })
    const waited = Date.now() - t0
    check('with the log\'s lock held by another program, a write gives up after well under a second (not 3)', waited < 800, waited + ' ms')
    t0 = Date.now()
    act.record(R, { kind: 'lastday', accountLabel: 'Held two' }, { key: 'held-2' })
    check('and the next ones do not wait again for a while', Date.now() - t0 < 100, (Date.now() - t0) + ' ms')
    check('nothing was written yet (and nothing broke)', first === null && act.list(R).entries.length === 0)
    check('flush with the lock still held writes nothing and says so', act.flush(R) === false)
    fs.rmSync(lockFile, { force: true })
    child.kill()
    fsx.sleepSync(2100)
    check('when the lock is free again the held entries are written, not dropped', act.flush(R) === true && act.list(R).entries.map((e) => e.accountLabel).sort().join() === 'Held one,Held two')
    check('and once only: flushing again, or writing the same event again, adds nothing', act.flush(R) === false &&
      act.record(R, { kind: 'lastday', accountLabel: 'Held one' }, { key: 'held-1' }) === null && act.list(R).entries.length === 2)
    const child2 = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' })
    fs.writeFileSync(lockFile, JSON.stringify({ pid: child2.pid, token: 'x', at: Date.now() }))
    act.record(R, { kind: 'lastday', accountLabel: 'Held three', at: T - 5 * MIN }, { key: 'held-3' })
    fs.rmSync(lockFile, { force: true })
    child2.kill()
    fsx.sleepSync(2100)
    act.record(R, { kind: 'lastday', accountLabel: 'After' }, { key: 'after-1' })
    const names = act.list(R).entries.map((e) => e.accountLabel)
    check('a held entry is written by the next write, among the others by its own time', names.length === 4 && names.indexOf('Held three') > names.indexOf('After'), names.join())
  }

  console.log('\n-- a damaged or unreadable log file is never replaced silently --')
  {
    const R = fresh()
    for (let i = 0; i < 5; i++) act.record(R, { kind: 'keepalive', accountLabel: 'n' + i, ok: true, at: T - (5 - i) * MIN }, { key: 'd' + i })
    const f = act.filePath(R)
    const fsx = require('../lib/fsx.js')
    const realRead = fsx.readJsonForWrite
    let calls = 0
    fsx.readJsonForWrite = (file) => { if (++calls === 1) { const e = new Error('busy'); e.code = 'EBUSY'; throw e } return realRead(file) }
    act.record(R, { kind: 'keepalive', accountLabel: 'after-blip', ok: true }, { key: 'blip' })
    fsx.readJsonForWrite = realRead
    check('a read that fails once is tried again, and the history stays', act.list(R).entries.length === 6 && calls === 2)
    const before = fs.readFileSync(f)
    fsx.readJsonForWrite = () => { const e = new Error('too many open files'); e.code = 'EMFILE'; throw e }
    const r = act.record(R, { kind: 'keepalive', accountLabel: 'skipped', ok: true }, { key: 'skip' })
    fsx.readJsonForWrite = realRead
    check('a read that keeps failing leaves the file as it was, and nothing is written over it', r === null && Buffer.compare(fs.readFileSync(f), before) === 0)
    check('the skipped entry is held and written on a later try', act.flush(R) === true && act.list(R).entries.some((e) => e.accountLabel === 'skipped') && act.list(R).entries.length === 7)
    const raw = fs.readFileSync(f)
    const cut = raw.slice(0, raw.length - 3)
    fs.writeFileSync(f, cut)
    act.record(R, { kind: 'keepalive', accountLabel: 'fresh start', ok: true }, { key: 'fresh' })
    const dir = path.dirname(f)
    const aside = fs.readdirSync(dir).filter((n) => n.startsWith('activity.json.bad-'))
    check('a damaged file is moved aside, not deleted: one copy, with the date in its name', aside.length === 1 && aside[0] === 'activity.json.bad-' + new Date().toISOString().slice(0, 10), aside.join())
    check('the copy is the damaged file as it was', aside.length === 1 && Buffer.compare(fs.readFileSync(path.join(dir, aside[0])), cut) === 0)
    check('and a new log starts with the new entry', act.list(R).entries.length === 1 && act.list(R).entries[0].accountLabel === 'fresh start')
    fs.writeFileSync(f, '{"v":1,"entries":[')
    act.record(R, { kind: 'keepalive', accountLabel: 'again', ok: true }, { key: 'again' })
    check('damaged a second time: still only one copy kept beside', fs.readdirSync(dir).filter((n) => n.startsWith('activity.json.bad-')).length === 1)
  }

  console.log('\n-- clearing keeps what was written once (1.5.4 fix round) --')
  {
    const R = fresh()
    const msg = { chatId: 'c1', chat: 'Fix', at: T - 5 * MIN, key: 'rec-1', words: 'Did it pass?' }
    act.recordPhone(R, msg)
    act.clear(R)
    check('after Clear the log, the same phone message found again in the chat file is not written back', act.recordPhone(R, msg) === null && act.list(R).entries.length === 0 && act.hasKey(R, act.phoneKey('c1', 'rec-1')))
    check('a new message still is', act.recordPhone(R, { ...msg, at: T - MIN, key: 'rec-2', words: 'again' }) !== null && act.list(R).entries.length === 1)
    act.record(R, { kind: 'roomagain', accountLabel: 'A' }, { key: 'ra-1' })
    act.clear(R)
    check('and any other event written before Clear is not written again either', act.record(R, { kind: 'roomagain', accountLabel: 'A' }, { key: 'ra-1' }) === null)
  }

  console.log('\n-- more of what the filter takes out, and what it leaves (1.5.4 fix round) --')
  {
    const B = String.fromCharCode(92)
    const gone = ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'DB_PASSWORD=hunter2hunter2', '{"api_key": "Zx9-short-but-real-123"}', '{"password": "hunter2hunter2"}',
      '{"password": "my pass phrase"}', 'Authorization: Basic YWRtaW46aHVudGVyMg==', 'Basic YWRtaW46aHVudGVyMg==', 'ab12Cd34+Ef56Gh78/Ij90Kl12+Mn34Op56/Qr78St90==',
      'deadbeefdeadbeefdeadbeef0123', 'accessToken: abc123', 'apiKey=abc123', 'PWD=letmein1', 'C:' + B + 'Users' + B + 'John Smith' + B + 'Documents' + B + 'notes.txt',
      B + B + 'srv' + B + 'share name' + B + 'f.txt']
    const around = (s) => act.clean('x ' + s + ' y', 120)
    const left = gone.filter((s) => !/^x [{}\s]*y$/.test(around(s)))
    check('password and key formats the first filter missed are gone', left.length === 0, left.map((s) => JSON.stringify(around(s))).join(' | '))
    const stay = ['Fix the monkey: plan', 'Keyboard shortcuts for the turkey', 'Basic setup for the app', 'Add a key feature to the password reset email flow', 'Fix https://github.com/acme/repo/issues/12 now',
      'Secret santa: draft the list', 'Implement the-new-authentication-flow', 'Fix the login page (v2)', 'Review PR 12: token refresh', 'Rename the keys in config', 'Write a long internationalization guide soon']
    check('ordinary chat titles stay whole (monkey, Basic setup, a web link, "password reset", a hyphenated name)', stay.every((s) => act.clean(s, 120) === s), stay.filter((s) => act.clean(s, 120) !== s).join(' | '))
    check('a very long odd title is cleaned quickly', (() => { const t0 = Date.now(); act.clean('a_'.repeat(5000), 100); act.clean('a-b '.repeat(3000) + 'key', 100); return Date.now() - t0 < 2000 })())
    const R = fresh()
    act.record(R, { kind: 'switch', by: 'page', from: 'sk-personal1', to: 'a'.repeat(32), toLabel: 'Long' })
    act.record(R, { kind: 'switch', by: 'page', from: 'work', to: 'work.max' })
    const sw = act.list(R).entries
    check('an account name the store accepts is logged, whatever it looks like (32 characters, "sk-" first)', sw.length === 2 && sw[1].from === 'sk-personal1' && sw[1].to === 'a'.repeat(32), JSON.stringify(sw))
  }

  console.log('\n-- a photo or a file from the phone (1.5.4 fix round) --')
  {
    const B = String.fromCharCode(92)
    const mark = '(Typed by the user on their phone and sent through Awaydesk, their own app on this PC.)'
    const id = '0a1b2c3d-1111-2222-3333-444455556666'
    const line = (user, name) => '- ' + ['C:', 'Users', user, '.claude-hub', 'uploads', id, name].join(B)
    const note = (user, name) => act.FILES_HEAD + '\n' + line(user, name)
    const words = (body) => (act.phoneIn({ type: 'user', isMeta: true, uuid: 'u', timestamp: new Date().toISOString(), origin: { kind: 'peer', name: 'Awaydesk', body } }) || {}).words
    check('a photo with no words reads "a photo from your phone", whoever the Windows user is', ['jsmith', 'John Smith'].every((u) => words(note(u, 'IMG_2041.png') + '\n\n' + mark) === 'a photo from your phone'))
    check('a file that is not a picture reads "a file from your phone"', words(note('jsmith', 'report.pdf') + '\n\n' + mark) === 'a file from your phone')
    check('with words, the words alone are kept, with nothing of the note or the path', ['jsmith', 'John Smith'].every((u) => words('See this\n\n' + note(u, 'IMG_1.jpg') + '\n\n' + mark) === 'See this'))
    check('several pictures and no words are still "a photo"; a picture and a file are "a file"',
      words(note('a', 'x.png') + '\n' + line('a', 'y.jpg') + '\n\n' + mark) === 'a photo from your phone' && words(note('a', 'x.png') + '\n' + line('a', 'y.zip') + '\n\n' + mark) === 'a file from your phone')
    check('words that only mention attachments are left as they are', words('Attached from the phone (saved on this PC): see below\n\n' + mark) !== 'a photo from your phone')
    const R = fresh()
    act.recordPhone(R, { chatId: 'c1', chat: 'Fix', at: T, key: 'p1', words: 'a photo from your phone' })
    check('and it reaches the log in those words', act.list(R).entries[0].preview === 'a photo from your phone')
  }

  console.log('\n-- smaller fixes (1.5.4 fix round) --')
  {
    const R = fresh()
    const f = act.filePath(R)
    act.record(R, { kind: 'lastday', accountLabel: 'Fresh' }, { key: 'f1' })
    const s = JSON.parse(fs.readFileSync(f, 'utf8'))
    s.entries.unshift({ id: '900', at: T - 40 * D, kind: 'lastday', accountLabel: 'Ancient' })
    fs.writeFileSync(f, JSON.stringify(s))
    check('an entry older than 30 days is not listed, though nothing has been written since', act.list(R).entries.map((e) => e.accountLabel).join() === 'Fresh' && act.since(R, T - 60 * D, T + H).length === 1)
  }

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  assert.strictEqual(failed, 0, 'activity log tests failed')
}

main().catch((e) => { console.error(e); process.exit(1) })
