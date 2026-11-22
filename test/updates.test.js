require('./fake-security')

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const https = require('https')

let realRequests = 0
https.request = () => { realRequests++; throw new Error('tests must not reach the network') }
https.get = https.request
const localHttp = http.request
http.request = (o, cb) => {
  if (!o || o.hostname !== '127.0.0.1') { realRequests++; throw new Error('tests must not reach the network') }
  return localHttp(o, cb)
}

const up = require('../lib/updates.js')

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}

const DAY = 86400000
const T0 = Date.parse('2026-11-20T12:00:00Z')
const made = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-upd-')); made.push(d); return d }

function release(tag, o) {
  return Object.assign({ tag_name: tag, published_at: new Date(T0 - 2 * DAY).toISOString(), draft: false, prerelease: false,
    html_url: 'https://example.invalid/elsewhere', body: 'A short line about it.\n\n## Details\n\n- **One.** Two.' }, o || {})
}
function fakeOf(answers) {
  const f = async (opts) => {
    f.calls.push(opts)
    const a = answers.length > 1 ? answers.shift() : answers[0]
    if (a instanceof Error) throw a
    return a
  }
  f.calls = []
  return f
}
const ok200 = (body, etag) => ({ status: 200, headers: etag ? { etag } : {}, body: typeof body === 'string' ? body : JSON.stringify(body) })

async function main() {
  console.log('\n-- versions --')
  check('1.10.0 is newer than 1.9.0', up.compare('1.10.0', '1.9.0') === 1 && up.compare('v1.9.0', '1.10.0') === -1)
  check('same is same, with or without the v', up.compare('v1.5.1', '1.5.1') === 0)
  check('pre-release and odd tags are not versions', !up.parseVersion('v1.6.0-beta.1') && !up.parseVersion('1.6') &&
    !up.parseVersion('latest') && !up.parseVersion('1.5.1.2') && !up.parseVersion(null))
  check('the release page is built from the version, not taken from the answer',
    up.releaseUrl('1.5.2') === 'https://github.com/clumsyboss/switcher-for-claude-code/releases/tag/v1.5.2')

  console.log('\n-- the answer --')
  const r1 = up.interpret(ok200(release('v1.5.2'), 'W/"abc"'))
  check('a release: version, time and a plain summary', r1.release && r1.release.version === '1.5.2' &&
    r1.release.publishedAt === T0 - 2 * DAY && r1.release.notes === 'A short line about it.' && r1.etag === 'W/"abc"', JSON.stringify(r1))
  check('the answer\'s own page address is not kept', !JSON.stringify(r1).includes('example.invalid'))
  check('a pre-release is no news', up.interpret(ok200(release('v1.6.0', { prerelease: true }))).release === null)
  check('a draft is no news', up.interpret(ok200(release('v1.6.0', { draft: true }))).release === null)
  check('a pre-release tag is no news', up.interpret(ok200(release('v1.6.0-rc.1'))).release === null)
  check('an odd tag is no news', up.interpret(ok200(release('nightly'))).release === null)
  check('no publish time is no news', up.interpret(ok200(release('v1.6.0', { published_at: 'soon' }))).release === null)
  check('broken JSON is no news', up.interpret(ok200('{"tag_name": "v9.9.9"')).release === null)
  check('a list or a string is no news', up.interpret(ok200('[1,2]')).release === null && up.interpret(ok200('"v9.9.9"')).release === null)
  check('a 304 keeps the saved answer', up.interpret({ status: 304, headers: {} }).notModified === true)
  check('a 403 or 500 is a failed ask', !!up.interpret({ status: 403, body: 'rate limited' }).error && !!up.interpret({ status: 500 }).error)
  check('a network error is a failed ask', up.interpret({ status: 0, error: 'ENOTFOUND' }).error === 'ENOTFOUND')

  console.log('\n-- release text is plain text --')
  const evil = '<img src=x onerror=alert(1)> **Big** news: see [our site](https://evil.example/x) and ![p](https://evil.example/p.png) ' +
    '<script>alert(2)</script>`code` &lt;b&gt;bold&lt;/b&gt; javascript:alert(3) command:workbench.action.reloadWindow'
  const t = up.plainText(evil)
  check('no tags, no marks, no addresses', !/[<>*`]/.test(t) && !/https?:|javascript:|command:|evil\.example|alert/.test(t), t)
  check('the words stay', /Big news: see our site and code bold/.test(t), t)
  check('control and direction characters go', up.plainText('a‮b\u0007c​d') === 'a b c d')
  const long = up.notesSummary('# Title\n\n' + 'This sentence is about the update. '.repeat(20))
  check('a long first paragraph is cut cleanly, at a sentence', long.length <= 220 && /update\.$/.test(long), long)
  const words = up.notesSummary('word '.repeat(100))
  check('or at a word, with an ellipsis', words.length <= 221 && /word…$/.test(words), words)
  check('a list gives its first two points', up.notesSummary('## What\'s new\n\n- **One.** First.\n- **Two.** Second.\n- Three.') === 'One. First. Two. Second.')
  const big = up.interpret(ok200(release('v1.5.2', { body: 'x'.repeat(200000) })))
  check('a huge body is cut', big.release && big.release.notes.length <= 221)

  console.log('\n-- once a day, for the whole PC --')
  const dir = tmp()
  const fake = fakeOf([ok200(release('v1.5.2'), 'W/"e1"')])
  const a = await up.check(dir, true, { request: fake, now: T0 })
  check('the first window asks', a.asked && fake.calls.length === 1 && a.state.latest.version === '1.5.2')
  check('with no ETag the first time', fake.calls[0].etag === null)
  const b = await up.check(dir, true, { request: fake, now: T0 + 60000 })
  check('a second window reads the saved answer and asks nothing', !b.asked && fake.calls.length === 1 && b.state.latest.version === '1.5.2')
  const fake2 = fakeOf([{ status: 304, headers: {} }])
  const c = await up.check(dir, true, { request: fake2, now: T0 + DAY + 1 })
  check('a day later it asks again, with the ETag', c.asked && fake2.calls.length === 1 && fake2.calls[0].etag === 'W/"e1"')
  check('a 304 keeps what was saved', c.state.latest.version === '1.5.2')
  check('the saved state is in the given folder', fs.existsSync(path.join(dir, 'updates.json')))
  const dir2 = tmp()
  const slow = fakeOf([ok200(release('v1.5.2'))])
  const [w1, w2] = await Promise.all([up.check(dir2, true, { request: slow, now: T0 }), up.check(dir2, true, { request: slow, now: T0 })])
  check('two windows at once ask once', slow.calls.length === 1 && (w1.asked !== w2.asked), slow.calls.length + ' ' + w1.asked + ' ' + w2.asked)

  console.log('\n-- a failed ask --')
  const dir3 = tmp()
  const logs = []
  const bad = fakeOf([new Error('ECONNRESET')])
  const f1 = await up.check(dir3, true, { request: bad, now: T0, log: (m) => logs.push(m) })
  check('is logged in one line', f1.asked && logs.length === 1 && !/\n/.test(logs[0]) && /ECONNRESET/.test(logs[0]), logs.join('|'))
  const f2 = await up.check(dir3, true, { request: bad, now: T0 + 3600000 })
  check('and not tried again the same day', !f2.asked && bad.calls.length === 1)
  const good = fakeOf([ok200(release('v1.5.2'))])
  const f3 = await up.check(dir3, true, { request: good, now: T0 + DAY })
  check('but the next day', f3.asked && f3.state.latest.version === '1.5.2' && f3.state.error === null)
  const f4 = await up.check(dir3, true, { request: fakeOf([{ status: 500 }]), now: T0 + 2 * DAY })
  check('a later failure keeps the last good answer', f4.error && f4.state.latest.version === '1.5.2')
  const huge = await up.check(tmp(), true, { request: fakeOf([{ status: 0, error: 'answer too large' }]), now: T0 })
  check('a too-large answer is a failed ask', huge.error === 'answer too large' && huge.state.latest === null)
  const broken = await up.check(tmp(), true, { request: fakeOf([ok200('<html>oops')]), now: T0 })
  check('a broken answer is no news', broken.asked && broken.state.latest === null)

  console.log('\n-- the setting off --')
  const off = fakeOf([ok200(release('v9.9.9'))])
  const o1 = await up.check(tmp(), false, { request: off, now: T0 })
  check('makes no request at all', !o1.asked && off.calls.length === 0)
  check('and shows nothing', up.noticeFor({ latest: { version: '9.9.9', publishedAt: 0, notes: '' } }, '1.5.1', { enabled: false, now: T0 }) === null)

  console.log('\n-- when to tell --')
  const st = (v, at, later) => ({ latest: { version: v, publishedAt: at, notes: 'n' }, later: later || null })
  const on = { enabled: true, now: T0 }
  check('newer, out for a day: told', !!up.noticeFor(st('1.5.2', T0 - DAY), '1.5.1', on))
  check('the notice', JSON.stringify(up.noticeFor(st('1.5.2', T0 - DAY), '1.5.1', on)) ===
    JSON.stringify({ version: '1.5.2', current: '1.5.1', notes: 'n', url: 'https://github.com/clumsyboss/switcher-for-claude-code/releases/tag/v1.5.2' }))
  check('same version: nothing', up.noticeFor(st('1.5.1', T0 - DAY), '1.5.1', on) === null)
  check('older: nothing', up.noticeFor(st('1.4.2', T0 - DAY), '1.5.1', on) === null)
  check('1.10.0 over 1.9.0: told', !!up.noticeFor(st('1.10.0', T0 - DAY), '1.9.0', on))
  check('newer but out under a day: not yet', up.noticeFor(st('1.5.2', T0 - DAY + 60000), '1.5.1', on) === null)
  check('unless this copy won\'t update by itself', !!up.noticeFor(st('1.5.2', T0 - 60000), '1.5.1', { ...on, wontUpdateItself: true }))
  check('auto updates off counts', up.autoUpdateOff(false) && up.autoUpdateOff('off') && up.autoUpdateOff('onlySelectedExtensions') &&
    !up.autoUpdateOff(true) && !up.autoUpdateOff(undefined) && !up.autoUpdateOff('onlyEnabledExtensions'))
  const ej = JSON.stringify([{ identifier: { id: 'Clumsyboss.Account-Switcher-Claude-Code' }, version: '1.5.1', metadata: { source: 'vsix', pinned: true } },
    { identifier: { id: 'other.ext' }, version: '2.0.0', metadata: { source: 'gallery' } }])
  const ii = up.installInfo(ej, 'clumsyboss.account-switcher-claude-code')
  check('a .vsix copy pinned at its version is read from the editor\'s list', ii.found && ii.pinned && ii.source === 'vsix' && ii.version === '1.5.1')
  check('a broken or missing list says nothing', !up.installInfo('{', 'x').found && !up.installInfo(ej, 'nobody.here').found)

  console.log('\n-- already on disk: restart, not "available" --')
  const rn = up.noticeFor(st('1.5.2', T0 - DAY), '1.5.1', { ...on, installed: '1.5.2' })
  check('the editor already has the newer version: a quiet restart line, nothing to install', rn && rn.restart === true &&
    rn.version === '1.5.2' && !rn.url && !rn.notes, JSON.stringify(rn))
  check('even within the first day', !!up.noticeFor(st('1.5.2', T0 - 60000), '1.5.1', { ...on, installed: '1.5.2' }).restart)
  check('an older copy on disk: "available" as before', !up.noticeFor(st('1.5.2', T0 - DAY), '1.5.1', { ...on, installed: '1.5.1' }).restart)
  check('the list unreadable: "available" as before', !up.noticeFor(st('1.5.2', T0 - DAY), '1.5.1', { ...on, installed: null }).restart)
  check('nothing newer saved: the list need not be read', !up.newerSaved(st('1.5.1', T0), '1.5.1') && up.newerSaved(st('1.5.2', T0), '1.5.1'))
  const P = path.join('C:', 'Users', 'someone', 'AppData', 'Roaming', 'Code', 'User')
  check('a named profile reads its own list of extensions',
    up.extensionsListFile(path.join('X', 'exts', 'pub.ext-1.5.1'), path.join(P, 'profiles', 'abc', 'globalStorage', 'pub.ext')) ===
      path.join(P, 'profiles', 'abc', 'extensions.json'))
  check('the default profile reads the list next to the extensions',
    up.extensionsListFile(path.join('X', 'exts', 'pub.ext-1.5.1'), path.join(P, 'globalStorage', 'pub.ext')) === path.join('X', 'exts', 'extensions.json'))

  console.log('\n-- a mistaken huge version --')
  const jump = { latest: { version: '9.0.0', publishedAt: T0 - 2 * DAY, notes: '', seenAt: T0 - 1000 }, checkedAt: T0 - 1000, later: null }
  check('more than one major ahead, seen by one check only: ignored', up.noticeFor(jump, '1.5.1', on) === null)
  check('still there a day later: told', !!up.noticeFor({ ...jump, checkedAt: T0 - 1000 + DAY }, '1.5.1', { ...on, now: T0 + DAY }))
  check('one major ahead: told at once', !!up.noticeFor({ ...jump, latest: { ...jump.latest, version: '2.0.0' } }, '1.5.1', on))
  const dirJ = tmp()
  await up.check(dirJ, true, { request: fakeOf([ok200(release('v9.0.0'))]), now: T0 })
  check('a check records when the version was first seen', up.readState(dirJ).latest.seenAt === T0 && up.noticeFor(up.readState(dirJ), '1.5.1', on) === null)
  await up.check(dirJ, true, { request: fakeOf([ok200(release('v9.0.0'))]), now: T0 + DAY })
  check('and the next day\'s check, finding it again, confirms it', up.readState(dirJ).latest.seenAt === T0 &&
    !!up.noticeFor(up.readState(dirJ), '1.5.1', { ...on, now: T0 + DAY }))

  console.log('\n-- Later --')
  const dir4 = tmp()
  up.writeState(dir4, { latest: { version: '1.5.2', publishedAt: T0 - 2 * DAY, notes: '' } })
  check('before Later: told', !!up.noticeFor(up.readState(dir4), '1.5.1', on))
  up.later(dir4, '1.5.2', T0)
  check('Later keeps that version quiet, in every window (it is saved)', up.noticeFor(up.readState(dir4), '1.5.1', on) === null)
  check('for 6 days', up.noticeFor(up.readState(dir4), '1.5.1', { ...on, now: T0 + 6 * DAY }) === null)
  check('and after 7 days it comes back', !!up.noticeFor(up.readState(dir4), '1.5.1', { ...on, now: T0 + 7 * DAY }))
  up.writeState(dir4, { latest: { version: '1.5.3', publishedAt: T0 - 2 * DAY, notes: '' } })
  check('a newer version shows at once', up.noticeFor(up.readState(dir4), '1.5.1', on).version === '1.5.3')
  up.later(dir4, '9.9.9', T0)
  check('Later on one (even huge) version never hides another', up.noticeFor(up.readState(dir4), '1.5.1', on).version === '1.5.3')
  fs.writeFileSync(up.stateFile(dir4), '{"latest":{"version":"<b>9</b>","publishedAt":"x"},"later":"1.5.2","seen":"v1.5.0"}')
  const rs = up.readState(dir4)
  check('a damaged saved file reads as nothing where it is wrong', rs.latest === null && rs.later === null && rs.seen === '1.5.0')

  console.log('\n-- odd saved times and an unwritable state file --')
  const dirF = tmp()
  up.writeState(dirF, { checkedAt: T0 + 3600000 })
  const fa = await up.check(dirF, true, { request: fakeOf([ok200(release('v1.5.2'))]), now: T0 })
  check('a saved check time an hour in the future: asks (the clock went back)', fa.asked && fa.state.checkedAt === T0)
  up.writeState(dirF, { checkedAt: T0 + 3 * DAY })
  check('three days in the future: asks', (await up.check(dirF, true, { request: fakeOf([ok200(release('v1.5.2'))]), now: T0 })).asked)
  const dirW = tmp()
  fs.mkdirSync(up.stateFile(dirW))
  const mem = {}
  const wlog = []
  const wf = fakeOf([ok200(release('v1.5.2'))])
  const uw1 = await up.check(dirW, true, { request: wf, now: T0, memory: mem, log: (m) => wlog.push(m) })
  check('the state file not writable: the ask still answers, and says so in the log', uw1.asked && uw1.state.latest.version === '1.5.2' &&
    wlog.some((m) => /could not save/.test(m)), wlog.join('|'))
  const uw2 = await up.check(dirW, true, { request: wf, now: T0 + 3600000, memory: mem })
  check('and the window asks no more that day (not hourly)', !uw2.asked && wf.calls.length === 1)
  const uw3 = await up.check(dirW, true, { request: wf, now: T0 + DAY, memory: mem })
  check('but again the next day', uw3.asked && wf.calls.length === 2)

  console.log('\n-- an ask that never ends --')
  const dirH = tmp()
  const never = () => new Promise(() => {})
  const h0 = Date.now()
  const awake = setInterval(() => {}, 1000)
  const hung = await up.check(dirH, true, { request: never, now: T0, timeoutMs: 200 })
  clearInterval(awake)
  check('gives up within the time limit', hung.asked && hung.error === 'timed out' && Date.now() - h0 < 3000, (Date.now() - h0) + ' ms')
  const lockAgain = require('../lib/locks').tryAcquire(dirH, 'update-check', 60000)
  check('and lets go of the shared lock', !!lockAgain)
  if (lockAgain) lockAgain()

  console.log('\n-- what\'s new, once --')
  const CL = '# Changelog\n\n## 1.5.1\n\n- **Tells you when a newer version is out.** Once a day.\n- **Says what\'s new after an update,** once.\n' +
    '- **Third.** x\n- **Fourth.** y\n\n## 1.5.0\n\n- **Older.** z\n'
  check('the bold lead-ins of this version\'s section', JSON.stringify(up.changelogHeadlines(CL, '1.5.1')) ===
    JSON.stringify(['Tells you when a newer version is out', 'Says what\'s new after an update', 'Third']))
  check('none for a version without a section', up.changelogHeadlines(CL, '1.6.0').length === 0)
  const dir5 = tmp()
  check('not on a first install', up.whatsNewFor(dir5, '1.5.1', { firstInstall: true, changelog: CL }) === null)
  check('and not later for that version', up.whatsNewFor(dir5, '1.5.1', { firstInstall: false, changelog: CL }) === null)
  const n2 = up.whatsNewFor(dir5, '1.5.2', { firstInstall: false, changelog: CL })
  check('the next update shows it', n2 && n2.version === '1.5.2')
  const dir6 = tmp()
  const n1 = up.whatsNewFor(dir6, '1.5.1', { firstInstall: false, changelog: CL })
  check('an update from a version that kept no record shows it', n1 && n1.items.length === 3, JSON.stringify(n1))
  check('until closed, in every window', !!up.whatsNewFor(dir6, '1.5.1', { firstInstall: false, changelog: CL }))
  up.seenWhatsNew(dir6, '1.5.1')
  check('closed: gone for good for that version', up.whatsNewFor(dir6, '1.5.1', { firstInstall: false, changelog: CL }) === null)
  up.seenWhatsNew(dir6, '1.5.0')
  check('an older editor closing its own does not bring it back', up.readState(dir6).seen === '1.5.1')

  console.log('\n-- Update --')
  const editor = (o) => {
    const e = { ran: [], opened: [], installed: o.installed === undefined ? '1.5.2' : o.installed }
    e.executeCommand = async (id, ...args) => {
      e.ran.push([id, ...args])
      if (id === up.UPDATE_COMMAND && o.noStore) throw new Error('Extension not found')
      if (id === up.OPEN_PAGE_COMMAND && o.noPage) throw new Error('command not found')
    }
    e.openExternal = async (u) => { e.opened.push(u); if (o.noBrowser) throw new Error('no') ; return true }
    e.installedVersion = () => e.installed
    return e
  }
  const run = (e) => up.runUpdate({ ...e, id: 'clumsyboss.account-switcher-claude-code', target: '1.5.2', current: '1.5.1' })
  const e1 = editor({})
  const u1 = await run(e1)
  check('store has it: the editor installs it, by id only (so no version gets pinned)', u1.done === 'installed' &&
    e1.ran.length === 1 && e1.ran[0][0] === 'workbench.extensions.installExtension' && e1.ran[0][1] === 'clumsyboss.account-switcher-claude-code' &&
    e1.ran[0].length === 2, JSON.stringify(e1.ran))
  check('and the user is told to expect the editor\'s restart question', /1\.5\.2 is installed/.test(u1.message) && /restart extensions/.test(u1.message))
  check('and that the store\'s build replaced the copy that was installed', /in place of the copy that was installed before/.test(u1.message), u1.message)
  const e2 = editor({ installed: '1.5.1' })
  const u2 = await run(e2)
  check('store does not have it yet: the extension\'s page opens', u2.done === 'page' && u2.reason === 'notInStore' &&
    e2.ran[1][0] === 'extension.open' && /doesn't have Switcher 1\.5\.2 yet/.test(u2.message), JSON.stringify(u2))
  const e3 = editor({ noStore: true })
  const u3 = await run(e3)
  check('no store: the extension\'s page opens', u3.done === 'page' && u3.reason === 'noStore' && /couldn't install/.test(u3.message))
  const e4 = editor({ noStore: true, noPage: true })
  const u4 = await run(e4)
  check('and failing that the release page in the browser', u4.done === 'browser' &&
    e4.opened[0] === 'https://github.com/clumsyboss/switcher-for-claude-code/releases/tag/v1.5.2' && /browser/.test(u4.message))
  const u5 = await run(editor({ noStore: true, noPage: true, noBrowser: true }))
  check('and if nothing works it says where to get it', u5.done === 'none' && /github\.com\/clumsyboss\/switcher-for-claude-code\/releases/.test(u5.message))
  const u6 = await run(editor({ installed: null }))
  check('when the editor\'s list can\'t be read, the install is taken as done', u6.done === 'installed')

  console.log('\n-- the real request --')
  const req = await up.defaultRequest({ etag: 'x' })
  check('the default request is blocked in tests and answers a failure', req.status === 0 && /network/.test(req.error))

  console.log('\n-- the real request, against a small server on 127.0.0.1 --')
  let mode = 'ok'
  const seen = []
  const server = http.createServer((rq, rs) => {
    seen.push({ path: rq.url, method: rq.method, headers: rq.headers })
    if (mode === 'ok') { rs.writeHead(200, { 'Content-Type': 'application/json', ETag: 'W/"s1"' }); rs.end(JSON.stringify(release('v1.5.2'))) }
    else if (mode === 'big') { rs.writeHead(200); rs.end(Buffer.alloc(MB11, 'x')) }
    else if (mode === 'drip') { rs.writeHead(200); const t = setInterval(() => { if (!rs.destroyed) rs.write('x') }, 50); rs.on('close', () => clearInterval(t)) }
    else if (mode === 'redirect') { rs.writeHead(301, { Location: 'http://127.0.0.1:' + port + '/elsewhere' }); rs.end() }
    else if (mode === 'cut') { rs.writeHead(200); rs.write('{"tag_'); setTimeout(() => rs.socket.destroy(), 20) }
    else if (mode === 'garbage') { rs.writeHead(200); rs.end('<html>not json') }
    else { rs.writeHead(Number(mode)); rs.end('{"message":"no"}') }
  })
  const MB11 = Math.round(1.1 * 1024 * 1024)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const ask = (etag, timeoutMs) => up.defaultRequest({ etag, local: { port }, timeoutMs })
  const okr = await ask('W/"e0"')
  const hd = seen[0].headers
  check('one GET to the releases address', seen.length === 1 && seen[0].method === 'GET' && seen[0].path === up.API_PATH)
  check('headers: only the plain ones (no token, no cookie, no id)', hd['user-agent'] === 'switcher-for-claude-code' &&
    hd.accept === 'application/vnd.github+json' && hd['if-none-match'] === 'W/"e0"' && !hd.authorization && !hd.cookie &&
    Object.keys(hd).every((k) => ['user-agent', 'accept', 'if-none-match', 'host', 'connection'].includes(k)), JSON.stringify(hd))
  check('a good answer reads as a release', up.interpret(okr).release && up.interpret(okr).release.version === '1.5.2' && up.interpret(okr).etag === 'W/"s1"')
  check('no ETag header when there is none to send', !('if-none-match' in (await ask(null), seen[1].headers)))
  mode = 'big'
  check('an answer over 1 MB is refused', (await ask()).error === 'answer too large')
  mode = 'drip'
  const d0 = Date.now()
  const dr = await ask(null, 600)
  check('an answer that drips slowly stops at the limit on the whole ask', dr.error === 'timed out' && Date.now() - d0 < 3000, (Date.now() - d0) + ' ms')
  mode = 'redirect'
  const before = seen.length
  const rd = await ask()
  check('a redirect is not followed (a failed ask)', seen.length === before + 1 && !!up.interpret(rd).error && rd.status === 301)
  for (const code of ['403', '404', '500']) {
    mode = code
    const e = up.interpret(await ask())
    check('a ' + code + ' is a failed ask', e.error === 'HTTP ' + code)
  }
  mode = 'garbage'
  check('a garbage answer is no news', up.interpret(await ask()).release === null)
  mode = 'cut'
  check('a connection cut halfway is a failed ask', (await ask(null, 2000)).status === 0)
  if (server.closeAllConnections) server.closeAllConnections()
  server.close()

  check('no test reached the network (only the one blocked try above)', realRequests === 1)

  for (const d of made) fs.rmSync(d, { recursive: true, force: true })
  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  if (failed) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
