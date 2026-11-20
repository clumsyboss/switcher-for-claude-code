require('./fake-security')

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const secrets = require('../lib/secrets.js')
const KEY = crypto.randomBytes(32)
const realProtect = secrets.protect
const realUnprotect = secrets.unprotect
secrets.protect = (buf) => realProtect(buf, { key: KEY })
secrets.unprotect = (blob) => realUnprotect(blob, { key: KEY })

const credstore = require('../lib/credstore.js')
const profiles = require('../lib/profiles.js')
const locks = require('../lib/locks.js')
const tracker = require('../lib/tracker.js')
const windows = require('../lib/windows.js')
const logins = require('../lib/logins.js')
const fakeSecurity = require('./fake-security')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-logins-'))
const HOME = path.join(TMP, 'home')
const ROOT = path.join(TMP, 'switcher')
const OPTS = { home: HOME, env: { USER: 'someone' } }
const X = { ...OPTS, verifyDelayMs: 0 }
const P = profiles.paths(OPTS)

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}

const H = 3600e3
const D = 24 * H
const NOW = Date.now()

function login(tag, endsIn) {
  return { claudeAiOauth: { accessToken: 'AT-' + tag, refreshToken: 'RT-' + tag, expiresAt: NOW + 8 * H,
    refreshTokenExpiresAt: NOW + endsIn, scopes: ['user:inference'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } }
}
function renewed(creds, tag) {
  return { claudeAiOauth: { ...creds.claudeAiOauth, accessToken: 'AT-' + tag, refreshToken: 'RT-' + tag } }
}
const rt = (c) => c && c.claudeAiOauth && c.claudeAiOauth.refreshToken
const account = (email) => ({ emailAddress: email, accountUuid: 'uuid-' + email, organizationName: 'Org', organizationUuid: 'org-' + email })

function signInLive(email, creds) {
  fs.mkdirSync(P.claudeDir, { recursive: true })
  credstore.write(null, creds, OPTS)
  const prev = fs.existsSync(P.claudeJson) ? JSON.parse(fs.readFileSync(P.claudeJson, 'utf8')) : {}
  fs.writeFileSync(P.claudeJson, JSON.stringify({ ...prev, oauthAccount: account(email), userID: 'uid-' + email,
    projects: { 'c:/work/repo': { history: ['chat-1'] } } }, null, 2))
}

let signIns = 0
function signInDir(email, creds, opts) {
  const dir = path.join(TMP, 'signin-' + (++signIns))
  fs.mkdirSync(dir, { recursive: true })
  credstore.write(dir, creds, opts || OPTS)
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: account(email), userID: 'x' }))
  return dir
}

function saveAccount(name, email, creds) {
  const before = fs.existsSync(P.claudeJson) ? fs.readFileSync(P.claudeJson) : null
  const live = credstore.read(null, OPTS)
  signInLive(email, creds)
  profiles.capture(ROOT, name, OPTS)
  if (before) fs.writeFileSync(P.claudeJson, before)
  if (live) credstore.write(null, live, OPTS)
}

const pinDir = (name) => logins.dirFor(ROOT, name)
const pinned = (name, o) => credstore.read(pinDir(name), o || OPTS)
const savedCreds = (name) => profiles.readPayload(ROOT, name).credentials
const liveCreds = () => credstore.read(null, OPTS)

async function main() {
  fs.mkdirSync(HOME, { recursive: true })
  fs.mkdirSync(ROOT, { recursive: true })
  console.log('temp root:', TMP)

  signInLive('h@example.com', login('H1', 20 * D))
  profiles.capture(ROOT, 'home', OPTS)
  saveAccount('work', 'w@example.com', login('W1', 10 * D))

  console.log('\n-- the layout every part agrees on --')
  check('the pinning folder is exactly <root>/pinning/<name>', logins.dirFor(ROOT, 'work') === path.join(ROOT, 'pinning', 'work'))
  check('its meta is <root>/pinning/<name>.json', logins.metaFile(ROOT, 'work') === path.join(ROOT, 'pinning', 'work.json'))
  check('in-use markers are in <root>/pinning/.inuse', logins.inUseDir(ROOT) === path.join(ROOT, 'pinning', '.inuse'))
  check('an account called "inuse" is fine: no name can start with a dot', logins.dirFor(ROOT, 'inuse') === path.join(ROOT, 'pinning', 'inuse'))
  let threw = false
  try { logins.dirFor(ROOT, '.inuse') } catch { threw = true }
  check('so no account\'s folder is the markers\' folder', threw)
  threw = false
  try { logins.dirFor(ROOT, '../evil') } catch { threw = true }
  check('nor can a name that leaves the folder', threw)
  check('no pinning login yet: info is null', logins.info(ROOT, 'work') === null)

  console.log('\n-- importing a pinning login --')
  let dir = signInDir('stranger@example.com', login('S1', 29 * D))
  let r = await logins.importPinning(ROOT, 'work', dir, OPTS)
  check('another account\'s sign-in is refused, and says who it was', !r.ok && r.reason === 'different-account' && r.who.email === 'stranger@example.com', JSON.stringify(r))
  check('and nothing moved', rt(credstore.read(dir, OPTS)) === 'RT-S1' && !logins.hasLogin(ROOT, 'work', OPTS) && !fs.existsSync(logins.metaFile(ROOT, 'work')))

  dir = signInDir('w@example.com', login('W2', 29 * D))
  r = await logins.importPinning(ROOT, 'work', dir, OPTS)
  check('the right account is moved in', r.ok && r.expiresAt === NOW + 29 * D, JSON.stringify(r))
  check('into the pinning folder\'s login, where Claude Code looks with CLAUDE_SECURESTORAGE_CONFIG_DIR',
    rt(credstore.read(pinDir('work'), OPTS)) === 'RT-W2' &&
    credstore.stat(pinDir('work'), OPTS).where === (process.platform === 'darwin' ? 'keychain' : 'file'))
  check('moved, not copied: the sign-in folder no longer has it', !credstore.exists(dir, OPTS))
  let meta = logins.readMeta(ROOT, 'work')
  check('meta: v1 with account, org, plan, sign-in and end', meta.v === 1 && meta.accountUuid === 'uuid-w@example.com' &&
    meta.email === 'w@example.com' && meta.orgUuid === 'org-w@example.com' && meta.orgName === 'Org' && meta.plan === 'Ultra' &&
    Number.isFinite(meta.signedInAt) && meta.expiresAt === NOW + 29 * D, JSON.stringify(meta))
  check('meta has no secrets', !/RT-|AT-/.test(fs.readFileSync(logins.metaFile(ROOT, 'work'), 'utf8')))
  check('main is untouched', rt(savedCreds('work')) === 'RT-W1')
  let inf = logins.info(ROOT, 'work', NOW)
  check('info: 29 days, ok', inf.daysLeft === 29 && inf.state === 'ok' && inf.email === 'w@example.com' && inf.accountUuid === 'uuid-w@example.com', JSON.stringify(inf))
  check('info: under 5 days is "soon"', logins.info(ROOT, 'work', NOW + 25 * D).state === 'soon')
  check('info: under 24 hours is "last-day"', logins.info(ROOT, 'work', NOW + 29 * D - 2 * H).state === 'last-day' && logins.info(ROOT, 'work', NOW + 29 * D - 2 * H).daysLeft === 0)
  check('info: past the end is "expired"', logins.info(ROOT, 'work', NOW + 30 * D).state === 'expired')
  check('the wrapper line: its end and its exact folder', JSON.stringify(logins.wrapperLogin(ROOT, 'work')) === JSON.stringify({ expiresAt: NOW + 29 * D, dir: pinDir('work') }))
  check('listed', JSON.stringify(logins.names(ROOT)) === '["work"]')
  fs.writeFileSync(path.join(ROOT, 'pinning', 'work.settings.json'), '{"disableRemoteControl":true}')
  fs.writeFileSync(path.join(ROOT, 'pinning', 'nobody.settings.json'), '{"enableArtifact":false}')
  check('the pinned chats\' settings files beside them are not logins', JSON.stringify(logins.names(ROOT)) === '["work"]', JSON.stringify(logins.names(ROOT)))
  for (const f of ['work.settings.json', 'nobody.settings.json']) fs.rmSync(path.join(ROOT, 'pinning', f))

  const emptyDir = path.join(TMP, 'empty'); fs.mkdirSync(emptyDir)
  r = await logins.importPinning(ROOT, 'work', emptyDir, OPTS)
  check('a folder with no login: no-login', !r.ok && r.reason === 'no-login')
  dir = signInDir('w@example.com', login('W9', 29 * D)); fs.rmSync(path.join(dir, '.claude.json'))
  r = await logins.importPinning(ROOT, 'work', dir, OPTS)
  check('a login with no identity yet: no-identity, and the pinning login is untouched', !r.ok && r.reason === 'no-identity' && rt(pinned('work')) === 'RT-W2')

  console.log('\n-- exchanging an account not in use --')
  r = await logins.exchange(ROOT, 'work', X)
  check('it exchanges', r.ok && r.main.expiresAt === NOW + 29 * D && r.pinning.expiresAt === NOW + 10 * D, JSON.stringify(r))
  check('main (the saved account) now holds the pinning login', rt(savedCreds('work')) === 'RT-W2')
  check('the pinning slot now holds the old main', rt(pinned('work')) === 'RT-W1')
  check('neither login is in two places', rt(savedCreds('work')) !== rt(pinned('work')))
  meta = logins.readMeta(ROOT, 'work')
  check('the pinning meta follows its login', meta.expiresAt === NOW + 10 * D && meta.email === 'w@example.com' && meta.accountUuid === 'uuid-w@example.com')
  check('the saved account\'s end date follows too', profiles.readMeta(ROOT, 'work').loginExpiresAt === NOW + 29 * D)
  check('the live login wasn\'t touched', rt(liveCreds()) === 'RT-H1')
  check('the lock is let go', !locks.isHeld(ROOT, tracker.accountLock('work')))
  r = await logins.exchange(ROOT, 'work', X)
  check('and back again', r.ok && rt(savedCreds('work')) === 'RT-W1' && rt(pinned('work')) === 'RT-W2' && logins.readMeta(ROOT, 'work').expiresAt === NOW + 29 * D)

  r = await logins.exchange(ROOT, 'home', X)
  check('no pinning login: no-pinning', !r.ok && r.reason === 'no-pinning', JSON.stringify(r))
  const release = locks.tryAcquire(ROOT, tracker.accountLock('work'), tracker.LOCK_STALE_MS)
  r = await logins.exchange(ROOT, 'work', { ...X, waitMs: 0 })
  release()
  check('a renewal or switch holding the account: locked, nothing changed', !r.ok && r.reason === 'locked' && rt(savedCreds('work')) === 'RT-W1' && rt(pinned('work')) === 'RT-W2')
  r = await logins.exchange(ROOT, 'work', { ...X, active: true })
  check('the caller thinks it is in use, but it isn\'t: conflict, nothing changed', !r.ok && r.reason === 'conflict' && rt(savedCreds('work')) === 'RT-W1')

  console.log('\n-- a pinned chat renews its login during the exchange --')
  r = await logins.exchange(ROOT, 'work', { ...X, sleep: async () => {
    credstore.write(pinDir('work'), renewed(login('W2', 29 * D), 'W2b'), OPTS)
  } })
  check('the exchange reports a conflict', !r.ok && r.reason === 'conflict', JSON.stringify(r))
  check('the renewed pinning login stays where its chat is', rt(pinned('work')) === 'RT-W2b')
  check('and main gets its own login back, not the one that just rotated away', rt(savedCreds('work')) === 'RT-W1')
  check('the meta matches what is there', logins.readMeta(ROOT, 'work').expiresAt === NOW + 29 * D && r.main.expiresAt === NOW + 10 * D && r.pinning.expiresAt === NOW + 29 * D)
  r = await logins.exchange(ROOT, 'work', { ...X, sleep: async () => {
    credstore.write(pinDir('work'), renewed(login('W1', 10 * D), 'W1b'), OPTS)
  } })
  check('a renewal of the login that moved in is no conflict', r.ok && rt(pinned('work')) === 'RT-W1b' && rt(savedCreds('work')) === 'RT-W2b')
  await logins.exchange(ROOT, 'work', X)

  console.log('\n-- exchanging the account in use --')
  fs.writeFileSync(P.claudeJson, JSON.stringify({ ...JSON.parse(fs.readFileSync(P.claudeJson, 'utf8')), numStartups: 7 }, null, 2))
  dir = signInDir('h@example.com', login('H2', 28 * D))
  r = await logins.importPinning(ROOT, 'home', dir, OPTS)
  credstore.write(null, renewed(login('H1', 20 * D), 'H1b'), OPTS)
  r = await logins.exchange(ROOT, 'home', { ...X, active: true })
  check('it exchanges', r.ok && r.main.expiresAt === NOW + 28 * D && r.pinning.expiresAt === NOW + 20 * D, JSON.stringify(r))
  check('the live login is the old pinning one', rt(liveCreds()) === 'RT-H2')
  check('the pinning slot has the newest main, renewed in place', rt(pinned('home')) === 'RT-H1b')
  check('the saved copy is refreshed from the live login, as a switch does', rt(savedCreds('home')) === 'RT-H2')
  const cfg = JSON.parse(fs.readFileSync(P.claudeJson, 'utf8'))
  check('identity and everything else in ~/.claude.json are untouched', cfg.oauthAccount.emailAddress === 'h@example.com' && cfg.numStartups === 7 && cfg.projects['c:/work/repo'].history[0] === 'chat-1')
  check('the lock is let go', !locks.isHeld(ROOT, tracker.accountLock('home')))

  r = await logins.exchange(ROOT, 'home', { ...X, sleep: async () => {
    credstore.write(null, renewed(login('H2', 28 * D), 'H2b'), OPTS)
  } })
  check('a chat writing the old main back: conflict', !r.ok && r.reason === 'conflict', JSON.stringify(r))
  check('the renewed main stays live', rt(liveCreds()) === 'RT-H2b')
  check('the pinning slot gets its own login back, not the dead one', rt(pinned('home')) === 'RT-H1b')
  check('and the saved copy holds the newest live login', rt(savedCreds('home')) === 'RT-H2b')
  r = await logins.exchange(ROOT, 'home', { ...X, active: false })
  check('the caller thinks it isn\'t in use, but it is: conflict, nothing changed', !r.ok && r.reason === 'conflict' && rt(liveCreds()) === 'RT-H2b')

  console.log('\n-- a new sign-in for a saved account --')
  dir = signInDir('stranger@example.com', login('S2', 29 * D))
  r = await logins.adoptNewLogin(ROOT, 'work', dir, { ...X, mode: 'main-keep-old-for-pinning' })
  check('another account: refused, nothing changed', !r.ok && r.reason === 'different-account' && rt(savedCreds('work')) === 'RT-W1b' && rt(pinned('work')) === 'RT-W2b')
  let threw2 = false
  try { await logins.adoptNewLogin(ROOT, 'work', dir, { ...X, mode: 'everything' }) } catch { threw2 = true }
  check('an unknown mode is a mistake', threw2)

  dir = signInDir('w@example.com', login('W3', 30 * D))
  r = await logins.adoptNewLogin(ROOT, 'work', dir, { ...X, mode: 'pinning' })
  check('"pinning": it becomes the pinning login', r.ok && r.mode === 'pinning' && rt(pinned('work')) === 'RT-W3' && rt(savedCreds('work')) === 'RT-W1b' &&
    r.pinning.expiresAt === NOW + 30 * D && r.main.expiresAt === NOW + 10 * D, JSON.stringify(r))
  check('moved out of the sign-in folder', !credstore.exists(dir, OPTS))

  dir = signInDir('w@example.com', login('W4', 30 * D))
  r = await logins.adoptNewLogin(ROOT, 'work', dir, { ...X, mode: 'main-only' })
  check('"main-only": it becomes main; the pinning login is left alone', r.ok && rt(savedCreds('work')) === 'RT-W4' && rt(pinned('work')) === 'RT-W3' && r.kept === null, JSON.stringify(r))
  check('moved out of the sign-in folder', !credstore.exists(dir, OPTS))

  await logins.remove(ROOT, 'work', OPTS)
  check('remove: the pinning login and its meta are gone', !logins.hasLogin(ROOT, 'work', OPTS) && logins.info(ROOT, 'work') === null)
  saveAccount('work', 'w@example.com', login('W5', 2 * D + H))
  dir = signInDir('w@example.com', login('W6', 30 * D))
  r = await logins.adoptNewLogin(ROOT, 'work', dir, { ...X, mode: 'main-keep-old-for-pinning' })
  check('"main-keep-old-for-pinning": new main, old main kept for pinning', r.ok && rt(savedCreds('work')) === 'RT-W6' && rt(pinned('work')) === 'RT-W5', JSON.stringify(r))
  check('even with under 3 days left, and says how many', r.kept === 'old-main' && r.oldDaysLeft === 2 && r.pinning.expiresAt === NOW + 2 * D + H && r.main.expiresAt === NOW + 30 * D)

  await logins.exchange(ROOT, 'work', X)
  dir = signInDir('w@example.com', login('W7', 30 * D + H))
  r = await logins.adoptNewLogin(ROOT, 'work', dir, { ...X, mode: 'main-keep-old-for-pinning' })
  check('an existing pinning login that lasts longer than the old main is kept instead', r.ok && r.kept === 'old-pinning' &&
    rt(savedCreds('work')) === 'RT-W7' && rt(pinned('work')) === 'RT-W6' && r.oldDaysLeft === 29, JSON.stringify(r))

  await logins.remove(ROOT, 'work', OPTS)
  saveAccount('work', 'w@example.com', login('W8', -H))
  dir = signInDir('w@example.com', login('W9', 30 * D))
  r = await logins.adoptNewLogin(ROOT, 'work', dir, { ...X, mode: 'main-keep-old-for-pinning' })
  check('an old main that has ended is dropped, not kept', r.ok && r.kept === null && r.oldDaysLeft === null && rt(savedCreds('work')) === 'RT-W9' && !logins.hasLogin(ROOT, 'work', OPTS), JSON.stringify(r))

  dir = signInDir('h@example.com', login('H3', 30 * D))
  r = await logins.adoptNewLogin(ROOT, 'home', dir, { ...X, mode: 'main-keep-old-for-pinning' })
  check('the account in use: the new login goes live, the old live one to pinning',
    r.ok && r.kept === 'old-main' && rt(liveCreds()) === 'RT-H3' && rt(pinned('home')) === 'RT-H2b' && rt(savedCreds('home')) === 'RT-H3', JSON.stringify(r))
  dir = signInDir('h@example.com', login('H4', 30 * D + 2 * H))
  r = await logins.adoptNewLogin(ROOT, 'home', dir, { ...X, mode: 'main-only' })
  check('"main-only" on the account in use: live now', r.ok && rt(liveCreds()) === 'RT-H4' && rt(savedCreds('home')) === 'RT-H4' && rt(pinned('home')) === 'RT-H2b')
  dir = signInDir('n@example.com', login('N1', 30 * D))
  r = await logins.adoptNewLogin(ROOT, 'newbie', dir, { ...X, mode: 'main-keep-old-for-pinning' })
  check('an account that isn\'t saved yet is saved', r.ok && r.kept === null && rt(savedCreds('newbie')) === 'RT-N1' && profiles.readMeta(ROOT, 'newbie').email === 'n@example.com')

  console.log('\n-- chats in use --')
  fs.mkdirSync(logins.inUseDir(ROOT), { recursive: true })
  const marker = (pid, name) => fs.writeFileSync(path.join(logins.inUseDir(ROOT), pid + '.json'),
    JSON.stringify({ v: 1, name, pid, sessionId: 'sess-' + pid, cwd: 'C:/work', startedAt: NOW }))
  marker(process.pid, 'work')
  marker(111111, 'work')
  marker(222222, 'home')
  fs.writeFileSync(path.join(logins.inUseDir(ROOT), 'notes.txt'), 'not a marker')
  const alive = (pid) => pid === process.pid || pid === 222222
  let used = logins.listInUse(ROOT, 'work', { pidAlive: alive })
  check('live chats on that account only', used.length === 1 && used[0].pid === process.pid && used[0].sessionId === 'sess-' + process.pid && used[0].cwd === 'C:/work' && used[0].startedAt === NOW, JSON.stringify(used))
  check('a dead chat\'s marker is pruned', !fs.existsSync(path.join(logins.inUseDir(ROOT), '111111.json')))
  check('other files are left alone', fs.existsSync(path.join(logins.inUseDir(ROOT), 'notes.txt')))
  check('another account\'s', logins.listInUse(ROOT, 'home', { pidAlive: alive }).length === 1)
  check('the real pid check: this process is alive', logins.listInUse(ROOT, 'work').some((u) => u.pid === process.pid))

  console.log('\n-- when to exchange --')
  const dx = (main, pinning, busy) => logins.decideExchange({ now: NOW, main: main === null ? null : { expiresAt: NOW + main }, pinning: pinning === null ? null : { expiresAt: NOW + pinning }, busy })
  check('main has days left: none', dx(3 * D, 20 * D, false) === 'none')
  check('main on its last day, pinning good: exchange', dx(10 * H, 20 * D, false) === 'exchange')
  check('main already ended: exchange', dx(-H, 20 * D, false) === 'exchange')
  check('a chat mid-reply: wait', dx(10 * H, 20 * D, true) === 'wait')
  check('no pinning login: none', dx(10 * H, null, false) === 'none')
  check('pinning ended: none', dx(10 * H, -H, false) === 'none')
  check('pinning within the wrapper\'s last hour: none', dx(10 * H, 30 * 60e3, false) === 'none')
  check('pinning ends before main: nothing to gain', dx(10 * H, 5 * H, false) === 'none')

  console.log('\n-- reminders --')
  const accounts = [
    { name: 'a', main: { expiresAt: NOW + 2 * D }, pinning: null },
    { name: 'b', main: { expiresAt: NOW + 5 * H }, pinning: { expiresAt: NOW - H } },
    { name: 'c', main: { expiresAt: NOW + 10 * D }, pinning: null },
  ]
  let state = logins.readReminderState(ROOT)
  let due = logins.dueReminders({ now: NOW, accounts, state })
  const kinds = due.map((d) => d.name + ':' + d.which + ':' + d.kind).sort().join(',')
  check('3 days, last day and ended, once each', kinds === 'a:main:3-days,b:main:last-day,b:pinning:expired', kinds)
  check('each has a key', due.every((d) => typeof d.key === 'string' && d.key.includes(d.kind)))
  state = logins.answerReminder(state, due.find((d) => d.name === 'a'), { now: NOW })
  state = logins.answerReminder(state, due.find((d) => d.which === 'pinning'), { now: NOW, notNow: true })
  logins.writeReminderState(ROOT, state)
  state = logins.readReminderState(ROOT)
  check('saved in <root>/reminders.json', fs.existsSync(path.join(ROOT, 'reminders.json')) && state.v === 1)
  due = logins.dueReminders({ now: NOW + H, accounts, state })
  check('an answered reminder doesn\'t come back', !due.some((d) => d.name === 'a'))
  check('"Not now" hides it for a day', !due.some((d) => d.which === 'pinning'))
  check('the others still show', due.some((d) => d.name === 'b' && d.which === 'main'))
  due = logins.dueReminders({ now: NOW + D + H, accounts, state })
  check('after a day it is back', due.some((d) => d.name === 'b' && d.which === 'pinning' && d.kind === 'expired'))
  due = logins.dueReminders({ now: NOW + D + 2 * H, accounts, state })
  check('the next kind for the same login still fires', due.some((d) => d.name === 'a' && d.kind === 'last-day'))
  const renewedAccounts = [{ name: 'a', main: { expiresAt: NOW + 2 * D }, pinning: null }]
  check('the same login renewed (same end date): still answered', !logins.dueReminders({ now: NOW + 2 * H, accounts: renewedAccounts, state }).length)
  const driftedAccounts = [{ name: 'a', main: { expiresAt: NOW + 2 * D + 37 }, pinning: null }]
  check('the same login renewed by Claude Code (end date a few ms later): still answered', !logins.dueReminders({ now: NOW + 2 * H, accounts: driftedAccounts, state }).length)
  const driftedB = [{ name: 'b', main: { expiresAt: NOW + 5 * H }, pinning: { expiresAt: NOW - H - 25 } }]
  check('and still snoozed after "Not now"', !logins.dueReminders({ now: NOW + H, accounts: driftedB, state }).some((d) => d.which === 'pinning'))
  const newLogin = [{ name: 'a', main: { expiresAt: NOW + 2 * D + logins.RENEWAL_SLACK_MS + 5000 }, pinning: null }]
  check('a new login (new end date) gets its own reminders', logins.dueReminders({ now: NOW + 2 * H, accounts: newLogin, state }).length === 1)
  const pruned = logins.answerReminder(state, { key: 'z|main|' + (NOW - 40 * D) + '|expired' }, { now: NOW })
  check('reminders for logins long gone are dropped', !Object.keys(pruned.done).some((k) => k.startsWith('z|')))
  fs.writeFileSync(path.join(ROOT, 'reminders.json'), '{broken')
  check('a broken state file reads as empty', JSON.stringify(logins.readReminderState(ROOT)) === JSON.stringify({ v: 1, done: {}, snoozed: {} }))

  const remind = (main, pinning, at) => logins.dueReminders({ now: at || NOW, state: {},
    accounts: [{ name: 'p', main: { expiresAt: NOW + main }, pinning: pinning === null ? null : { expiresAt: NOW + pinning } }] })
    .map((d) => d.which + ':' + d.kind).sort().join(',')
  check('covered: no "3 days" for main', remind(2 * D, 20 * D) === '', remind(2 * D, 20 * D))
  check('covered: no "last day" for main', remind(5 * H, 20 * D) === '')
  check('no pinning login: main\'s reminders fire', remind(2 * D, null) === 'main:3-days' && remind(5 * H, null) === 'main:last-day')
  check('a pinning login ending sooner than main doesn\'t cover it', remind(2 * D, D - H) === 'main:3-days,pinning:last-day', remind(2 * D, D - H))
  check('nor one ending within an hour of main\'s end', remind(5 * H, 5 * H + 30 * 60e3) === 'main:last-day,pinning:last-day', remind(5 * H, 5 * H + 30 * 60e3))
  check('nor one that has ended', remind(2 * D, -H) === 'main:3-days,pinning:expired')
  check('covered, but main ended anyway (no exchange happened): "expired" still fires', remind(-H, 20 * D) === 'main:expired')
  check('the pinning login\'s own reminders are unchanged', remind(30 * D, 2 * D) === 'pinning:3-days')

  console.log('\n-- 1.3 window logins become pinning logins --')
  const canary = path.join(P.claudeDir, 'projects', 'C--work-repo', 'precious-chat.jsonl')
  fs.mkdirSync(path.dirname(canary), { recursive: true })
  fs.writeFileSync(canary, 'do not lose me\n')
  saveAccount('mig', 'm@example.com', login('M1', 10 * D))
  saveAccount('old', 'o@example.com', login('O1', 10 * D))
  saveAccount('odd', 'odd@example.com', login('D1', 10 * D))
  const winLogin = (name, email, creds) => {
    const w = windows.prepare(ROOT, name, OPTS)
    credstore.write(w, creds, OPTS)
    fs.writeFileSync(path.join(w, '.claude.json'), JSON.stringify({ oauthAccount: account(email), projects: {} }))
    return w
  }
  winLogin('mig', 'm@example.com', login('MW', 12 * D))
  fs.writeFileSync(path.join(windows.windowDir(ROOT, 'mig'), 'CLAUDE.md'), 'my notes')
  const packDir = path.join(windows.windowDir(ROOT, 'mig'), 'plugins', 'marketplaces', 'some-plugin', '.git', 'objects', 'pack')
  fs.mkdirSync(packDir, { recursive: true })
  for (const f of ['pack-1.idx', 'pack-1.pack']) { fs.writeFileSync(path.join(packDir, f), 'x'); fs.chmodSync(path.join(packDir, f), 0o444) }
  winLogin('old', 'o@example.com', login('OW', -D))
  winLogin('home', 'h@example.com', login('HW', 12 * D))
  winLogin('odd', 'someone-else@example.com', login('XW', 12 * D))
  winLogin('busy', 'b@example.com', login('BW', 12 * D))
  const res = await logins.migrateWindowLogins(ROOT, NOW, { ...OPTS, skip: (n) => n === 'busy' })
  const by = Object.fromEntries(res.map((x) => [x.name, x]))
  check('a good window login is moved', by.mig && by.mig.moved && by.mig.removed && rt(pinned('mig')) === 'RT-MW', JSON.stringify(by.mig))
  const mm = logins.readMeta(ROOT, 'mig')
  check('with its meta', mm && mm.email === 'm@example.com' && mm.accountUuid === 'uuid-m@example.com' && mm.expiresAt === NOW + 12 * D && mm.orgName === 'Org', JSON.stringify(mm))
  check('its window folder is gone, the user\'s own files kept in backups', !fs.existsSync(windows.windowDir(ROOT, 'mig')) &&
    fs.readdirSync(path.join(ROOT, 'backups')).some((f) => f.startsWith('window-mig-') && fs.existsSync(path.join(ROOT, 'backups', f, 'CLAUDE.md'))))
  check('read-only files (a plugin\'s git clone) don\'t stop it', !by.mig.error && !fs.existsSync(windows.windowDir(ROOT, 'mig')), JSON.stringify(by.mig))
  {
    const tree = path.join(TMP, 'ro-tree')
    const outside = path.join(TMP, 'ro-outside')
    fs.mkdirSync(path.join(tree, 'a', '.git', 'pack'), { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    const files = [path.join(tree, 'top.txt'), path.join(tree, 'a', '.git', 'pack', 'p.pack')]
    for (const f of files) { fs.writeFileSync(f, 'x'); fs.chmodSync(f, 0o444) }
    fs.writeFileSync(path.join(outside, 'theirs.txt'), 'x'); fs.chmodSync(path.join(outside, 'theirs.txt'), 0o444)
    fs.symlinkSync(outside, path.join(tree, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    windows.makeWritable(tree)
    check('clearing read-only: every file in the folder becomes writable', files.every((f) => (fs.statSync(f).mode & 0o200) !== 0))
    check('and a link inside is not followed', (fs.statSync(path.join(outside, 'theirs.txt')).mode & 0o200) === 0)
    fs.chmodSync(path.join(outside, 'theirs.txt'), 0o666)
    windows.removeLink(path.join(tree, 'link'))
    fs.rmSync(tree, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true })
  }
  check('an ended one is just removed', by.old && !by.old.moved && by.old.removed && !logins.hasLogin(ROOT, 'old', OPTS) && !fs.existsSync(windows.windowDir(ROOT, 'old')))
  check('an account that already pins keeps its pinning login', by.home && !by.home.moved && by.home.removed && rt(pinned('home')) === 'RT-H2b')
  check('a window login of a different account isn\'t moved', by.odd && !by.odd.moved && by.odd.removed && by.odd.reason === 'different-account' && !logins.hasLogin(ROOT, 'odd', OPTS))
  check('a skipped one is left as it is', by.busy && !by.busy.removed && credstore.exists(windows.windowDir(ROOT, 'busy'), OPTS))
  check('the shared chat history survives', fs.readFileSync(canary, 'utf8') === 'do not lose me\n')
  const again = await logins.migrateWindowLogins(ROOT, NOW, { ...OPTS, skip: (n) => n === 'busy' })
  check('running it again changes nothing', again.length === 1 && again[0].name === 'busy' && rt(pinned('mig')) === 'RT-MW', JSON.stringify(again))
  check('no windows folder: nothing to do', (await logins.migrateWindowLogins(path.join(TMP, 'nowhere'), NOW, OPTS)).length === 0)
  winLogin('aaa-stuck', 'a@example.com', login('AW', -D))
  winLogin('zzz-next', 'z@example.com', login('ZW', -D))
  const realRemove = windows.remove
  windows.remove = (r, n, o) => { if (n === 'aaa-stuck') throw new Error('EPERM, Permission denied (test)'); return realRemove(r, n, o) }
  let stuck
  try { stuck = Object.fromEntries((await logins.migrateWindowLogins(ROOT, NOW, { ...OPTS, skip: (n) => n === 'busy' })).map((x) => [x.name, x])) } finally { windows.remove = realRemove }
  check('a folder that can\'t be removed is reported, not thrown', stuck['aaa-stuck'] && !stuck['aaa-stuck'].removed && stuck['aaa-stuck'].reason === 'remove-failed' && /EPERM/.test(stuck['aaa-stuck'].error), JSON.stringify(stuck['aaa-stuck']))
  check('and the ones after it are still done', stuck['zzz-next'] && stuck['zzz-next'].removed && !fs.existsSync(windows.windowDir(ROOT, 'zzz-next')), JSON.stringify(stuck['zzz-next']))
  const retry = Object.fromEntries((await logins.migrateWindowLogins(ROOT, NOW, { ...OPTS, skip: (n) => n === 'busy' })).map((x) => [x.name, x]))
  check('it\'s removed at the next start', retry['aaa-stuck'] && retry['aaa-stuck'].removed && !fs.existsSync(windows.windowDir(ROOT, 'aaa-stuck')), JSON.stringify(retry['aaa-stuck']))

  console.log('\n-- the background renewals never touch a pinning login --')
  saveAccount('work', 'w@example.com', { claudeAiOauth: { ...login('WR', 20 * D).claudeAiOauth, expiresAt: NOW - H } })
  credstore.write(pinDir('work'), { claudeAiOauth: { ...login('WP', 25 * D).claudeAiOauth, expiresAt: NOW - H } }, OPTS)
  const pinnedNow = () => JSON.stringify(credstore.read(pinDir('work'), OPTS))
  const before = pinnedNow()
  const sent = []
  tracker._test.transport.refresh = async (token) => { sent.push(token); return { status: 400, body: '{"error":"invalid_grant"}' } }
  tracker._test.transport.fetchUsage = async () => ({ ok: false, reason: 'offline' })
  await tracker.tick(ROOT, OPTS)
  check('the saved main login is what gets renewed', sent.includes('RT-WR'), JSON.stringify(sent))
  check('no pinning login is ever sent', !sent.some((t) => ['RT-WP', 'RT-MW', 'RT-H2b'].includes(t)))
  check('the pinning login is byte for byte the same', pinnedNow() === before)
  check('pinning logins aren\'t saved accounts to it', !profiles.list(ROOT).some((p) => p.name === 'inuse' || p.name.endsWith('.json')))

  console.log('\n-- a crash in the middle of an exchange, then recover() --')
  let crashes = 0
  async function crashCase(active, at, between, expect) {
    const tag = 'K' + (++crashes)
    const name = 'crash' + crashes
    const email = name + '@example.com'
    const A = login(tag + 'A', 10 * D)
    const B = login(tag + 'B', 25 * D)
    if (active) { signInLive(email, A); profiles.capture(ROOT, name, OPTS) } else saveAccount(name, email, A)
    const imp = await logins.importPinning(ROOT, name, signInDir(email, B), OPTS)
    const mainNow = () => (active ? liveCreds() : savedCreds(name))
    const label = (active ? 'in use' : 'not in use') + ', crash after "' + at + '"'
    let err = null
    try { await logins.exchange(ROOT, name, { ...X, crashAt: at }) } catch (e) { err = e }
    check(label + ': the crash happened, the journal is left', imp.ok && err && /simulated crash/.test(err.message) && fs.existsSync(logins._test.journalFile(ROOT, name)))
    check(label + ': the journal is sealed, no token in it', !/RT-|AT-/.test(fs.readFileSync(logins._test.journalFile(ROOT, name), 'latin1')))
    if (between) between({ name, A, B })
    const rec = await logins.recover(ROOT, OPTS)
    const mine = rec.find((x) => x.name === name)
    check(label + ': recover says ' + expect, mine && mine.action === expect, JSON.stringify(rec))
    check(label + ': and prints no token', !/RT-|AT-/.test(JSON.stringify(rec)))
    const m = rt(mainNow())
    const p = rt(pinned(name))
    const ends = [profiles.loginExpiresAt(mainNow()), profiles.loginExpiresAt(pinned(name))].sort()
    check(label + ': each login in exactly one slot, none lost', m && p && m !== p && ends[0] === NOW + 10 * D && ends[1] === NOW + 25 * D, m + ' / ' + p)
    check(label + ': the meta matches the pinning slot', logins.readMeta(ROOT, name).expiresAt === profiles.loginExpiresAt(pinned(name)))
    check(label + ': the journal is gone, the lock let go', !fs.existsSync(logins._test.journalFile(ROOT, name)) && !locks.isHeld(ROOT, tracker.accountLock(name)))
    check(label + ': running recover again does nothing', !(await logins.recover(ROOT, OPTS)).some((x) => x.name === name))
    return { name, m, p, tag }
  }
  for (const active of [false, true]) {
    let c = await crashCase(active, 'journal', null, 'rolled-back')
    check('nothing had moved yet: back as it was', c.m === 'RT-' + c.tag + 'A' && c.p === 'RT-' + c.tag + 'B')
    c = await crashCase(active, 'pin-written', null, 'rolled-back')
    check('the old main was in both slots: the pinning login is put back', c.m === 'RT-' + c.tag + 'A' && c.p === 'RT-' + c.tag + 'B')
    c = await crashCase(active, 'main-written', null, 'finished')
    check('both written: the exchange is finished', c.m === 'RT-' + c.tag + 'B' && c.p === 'RT-' + c.tag + 'A')
    c = await crashCase(active, 'settled', null, 'finished')
    check('settled but not tidied up: finished', c.m === 'RT-' + c.tag + 'B' && c.p === 'RT-' + c.tag + 'A')
  }
  let c = await crashCase(false, 'pin-written', ({ name, A }) => credstore.write(pinDir(name), renewed(A, 'K-renewed-pin'), OPTS), 'finished')
  check('a renewal in the pinning slot wins: exchange finished around it', c.p === 'RT-K-renewed-pin' && c.m === 'RT-' + c.tag + 'B')
  c = await crashCase(true, 'pin-written', ({ A }) => credstore.write(null, renewed(A, 'K-renewed-live'), OPTS), 'rolled-back')
  check('a renewal in the live slot wins: rolled back around it', c.m === 'RT-K-renewed-live' && c.p === 'RT-' + c.tag + 'B')

  saveAccount('crashL', 'crashL@example.com', login('LA', 10 * D))
  await logins.importPinning(ROOT, 'crashL', signInDir('crashL@example.com', login('LB', 25 * D)), OPTS)
  try { await logins.exchange(ROOT, 'crashL', { ...X, crashAt: 'pin-written' }) } catch {  }
  const held = locks.tryAcquire(ROOT, tracker.accountLock('crashL'), tracker.LOCK_STALE_MS)
  let rec = await logins.recover(ROOT, OPTS)
  held()
  check('a locked account is left to whoever holds it', rec.some((x) => x.name === 'crashL' && x.action === 'locked') && fs.existsSync(logins._test.journalFile(ROOT, 'crashL')))
  const r2 = await logins.exchange(ROOT, 'crashL', X)
  check('the next exchange settles the interrupted one first, then exchanges', r2.ok && rt(savedCreds('crashL')) === 'RT-LB' && rt(pinned('crashL')) === 'RT-LA' && !fs.existsSync(logins._test.journalFile(ROOT, 'crashL')), JSON.stringify(r2))

  const realUpdate = profiles.updateCredentials
  profiles.updateCredentials = () => { throw new Error('disk full') }
  const r3 = await logins.exchange(ROOT, 'crashL', X)
  profiles.updateCredentials = realUpdate
  check('a failed main write: error, the pinning login put back, no journal', !r3.ok && r3.reason === 'error' && rt(savedCreds('crashL')) === 'RT-LB' &&
    rt(pinned('crashL')) === 'RT-LA' && !fs.existsSync(logins._test.journalFile(ROOT, 'crashL')), JSON.stringify(r3))
  check('recover with nothing interrupted: nothing to do', (await logins.recover(ROOT, OPTS)).length === 0)

  saveAccount('crashK', 'crashK@example.com', login('KA', 5 * D))
  let err2 = null
  try { await logins.adoptNewLogin(ROOT, 'crashK', signInDir('crashK@example.com', login('KN', 30 * D)), { ...X, mode: 'main-keep-old-for-pinning', crashAt: 'pin-written' }) } catch (e) { err2 = e }
  rec = await logins.recover(ROOT, OPTS)
  check('a new login kept-old crash: recovered with each login in one slot', err2 && rec.some((x) => x.name === 'crashK') &&
    rt(savedCreds('crashK')) !== rt(pinned('crashK')) && [rt(savedCreds('crashK')), rt(pinned('crashK'))].sort().join() === 'RT-KA,RT-KN', JSON.stringify(rec))

  console.log('\n-- macOS: the Keychain item Claude Code reads for that folder --')
  const MAC = { home: HOME, platform: 'darwin', env: { USER: 'someone' } }
  const sha8 = (s) => crypto.createHash('sha256').update(s.normalize('NFC')).digest('hex').slice(0, 8)
  saveAccount('mac', 'mac@example.com', login('C1', 9 * D))
  dir = signInDir('mac@example.com', login('C2', 29 * D), MAC)
  r = await logins.importPinning(ROOT, 'mac', dir, MAC)
  const svc = 'Claude Code-credentials-' + sha8(pinDir('mac'))
  check('moved in', r.ok, JSON.stringify(r))
  check('into the Keychain, under the service hashed from the exact folder', fakeSecurity.items.has(svc + '\0someone') &&
    JSON.parse(fakeSecurity.items.get(svc + '\0someone')).claudeAiOauth.refreshToken === 'RT-C2' && credstore.service(pinDir('mac'), MAC) === svc)
  check('no file beside it', !fs.existsSync(path.join(pinDir('mac'), '.credentials.json')))
  check('and out of the sign-in folder\'s Keychain item', !credstore.exists(dir, MAC))
  r = await logins.exchange(ROOT, 'mac', { ...MAC, verifyDelayMs: 0 })
  check('exchanged through the Keychain', r.ok && rt(savedCreds('mac')) === 'RT-C2' && JSON.parse(fakeSecurity.items.get(svc + '\0someone')).claudeAiOauth.refreshToken === 'RT-C1', JSON.stringify(r))
  r = await logins.remove(ROOT, 'mac', MAC)
  check('removed from the Keychain', r.ok && r.removed && !fakeSecurity.items.has(svc + '\0someone'))

  console.log('\n-- setPinningLogin: a login the switcher already holds becomes the pinning login --')
  const keptDir = logins.dirFor(ROOT, 'kept')
  const old = login('K1', 20 * D)
  r = await logins.setPinningLogin(ROOT, 'kept', old, account('kept@example.com'), OPTS)
  check('it is written to the pinning folder', r.ok && r.expiresAt === NOW + 20 * D && rt(credstore.read(keptDir, OPTS)) === 'RT-K1', JSON.stringify(r))
  let km = logins.readMeta(ROOT, 'kept')
  check('with its meta: end date and who it is', km && km.expiresAt === NOW + 20 * D && km.email === 'kept@example.com' && km.accountUuid === 'uuid-kept@example.com')
  credstore.write(keptDir, renewed(old, 'K1b'), OPTS)
  r = await logins.setPinningLogin(ROOT, 'kept', old, account('kept@example.com'), OPTS)
  check('a renewal in the folder is never written over with older tokens', r.ok && rt(credstore.read(keptDir, OPTS)) === 'RT-K1b')
  const fresh = login('K2', 30 * D)
  r = await logins.setPinningLogin(ROOT, 'kept', fresh, account('kept@example.com'), OPTS)
  km = logins.readMeta(ROOT, 'kept')
  check('a different login replaces it', r.ok && rt(credstore.read(keptDir, OPTS)) === 'RT-K2' && km.expiresAt === NOW + 30 * D)
  r = await logins.setPinningLogin(ROOT, 'kept', login('K3', -H), account('kept@example.com'), OPTS)
  check('an ended login is not kept', !r.ok && r.reason === 'ended' && rt(credstore.read(keptDir, OPTS)) === 'RT-K2')
  r = await logins.setPinningLogin(ROOT, 'kept', { claudeAiOauth: { accessToken: 'x' } }, null, OPTS)
  check('nor one without a refresh token', !r.ok && r.reason === 'no-login')
  r = await logins.setPinningLogin(ROOT, 'kept', fresh, null, { ...OPTS, lock: async () => null })
  check('a lock it can\'t get changes nothing', !r.ok && r.reason === 'locked')
  await logins.remove(ROOT, 'kept', OPTS)

  console.log('\n-- a chat renews main during an exchange: it stops, nothing is lost --')
  for (const at of ['journal', 'pin-written']) {
    const name = 'renew' + (at === 'journal' ? 'J' : 'P')
    const email = name + '@example.com'
    const A = login(name + 'A', 10 * H)
    const B = login(name + 'B', 25 * D)
    signInLive(email, A); profiles.capture(ROOT, name, OPTS)
    await logins.importPinning(ROOT, name, signInDir(email, B), OPTS)
    r = await logins.exchange(ROOT, name, { ...X, onStep: (s) => { if (s === at) credstore.write(null, renewed(A, name + '-renewed'), OPTS) } })
    check('renewed before the ' + (at === 'journal' ? 'first' : 'second') + ' write: a conflict, to try again later', !r.ok && r.reason === 'conflict', JSON.stringify(r))
    check('the renewal stays in main, the pinning login is its own', rt(liveCreds()) === 'RT-' + name + '-renewed' && rt(pinned(name)) === 'RT-' + name + 'B')
    check('no journal is left', !fs.existsSync(logins._test.journalFile(ROOT, name)))
    r = await logins.exchange(ROOT, name, X)
    check('the next try exchanges', r.ok && rt(liveCreds()) === 'RT-' + name + 'B' && rt(pinned(name)) === 'RT-' + name + '-renewed', JSON.stringify(r))
  }

  console.log('\n-- main has ended: the pinning login takes over through the exchange, the old main is retired --')
  saveAccount('ended', 'ended@example.com', login('EA', -H))
  await logins.importPinning(ROOT, 'ended', signInDir('ended@example.com', login('EB', 20 * D)), OPTS)
  r = await logins.exchange(ROOT, 'ended', { ...X, retire: true })
  check('main is the pinning login now', r.ok && r.main.expiresAt === NOW + 20 * D && rt(savedCreds('ended')) === 'RT-EB', JSON.stringify(r))
  check('the ended main is in the pinning slot (running pinned chats drop the promoted login)', rt(pinned('ended')) === 'RT-EA')
  check('marked retired in its meta', logins.readMeta(ROOT, 'ended').retired === true)
  check('a retired login is no pinning login: no info, no wrapper login', logins.info(ROOT, 'ended') === null && logins.wrapperLogin(ROOT, 'ended') === null)
  check('so no reminder can ask about it', logins.dueReminders({ now: NOW, accounts: [{ name: 'ended', main: { expiresAt: NOW + 20 * D }, pinning: logins.info(ROOT, 'ended') }], state: {} })
    .every((x) => x.which !== 'pinning'))
  check('nothing to take over the second time', (await logins.exchange(ROOT, 'ended', { ...X, retire: true })).reason === 'no-pinning')
  await logins.importPinning(ROOT, 'ended', signInDir('ended@example.com', login('EN', 30 * D)), OPTS)
  check('a new pinning sign-in is a pinning login again', !logins.readMeta(ROOT, 'ended').retired && logins.info(ROOT, 'ended').expiresAt === NOW + 30 * D)
  saveAccount('ended3', 'ended3@example.com', login('GA', -H))
  await logins.importPinning(ROOT, 'ended3', signInDir('ended3@example.com', login('GB', 20 * D)), OPTS)
  credstore.write(pinDir('ended3'), login('GB', -H / 2), OPTS)
  r = await logins.exchange(ROOT, 'ended3', { ...X, retire: true })
  check('an ended pinning login never takes over', !r.ok && r.reason === 'ended' && rt(savedCreds('ended3')) === 'RT-GA')
  saveAccount('ended2', 'ended2@example.com', login('FA', -H))
  const FB = login('FB', 20 * D)
  await logins.importPinning(ROOT, 'ended2', signInDir('ended2@example.com', FB), OPTS)
  r = await logins.exchange(ROOT, 'ended2', { ...X, retire: true, sleep: async () => credstore.write(pinDir('ended2'), renewed(FB, 'FB2'), OPTS) })
  check('a renewal while they swap: put back, nothing lost, not retired', !r.ok && r.reason === 'conflict' && rt(savedCreds('ended2')) === 'RT-FA' &&
    rt(pinned('ended2')) === 'RT-FB2' && !logins.readMeta(ROOT, 'ended2').retired, JSON.stringify(r))
  r = await logins.exchange(ROOT, 'ended2', { ...X, retire: true })
  check('the next try takes over with the renewal', r.ok && rt(savedCreds('ended2')) === 'RT-FB2' && logins.readMeta(ROOT, 'ended2').retired === true)
  for (const [at, expect] of [['pin-written', 'rolled-back'], ['main-written', 'finished']]) {
    const name = 'endcrash' + (at === 'pin-written' ? 'P' : 'M')
    saveAccount(name, name + '@example.com', login(name + 'A', -H))
    await logins.importPinning(ROOT, name, signInDir(name + '@example.com', login(name + 'B', 20 * D)), OPTS)
    let err = null
    try { await logins.exchange(ROOT, name, { ...X, retire: true, crashAt: at }) } catch (e) { err = e }
    const rec = (await logins.recover(ROOT, OPTS)).find((x) => x.name === name)
    check('crash after "' + at + '": recover says ' + expect, err && rec && rec.action === expect, JSON.stringify(rec))
    const m = rt(savedCreds(name))
    const p = rt(pinned(name))
    check('crash after "' + at + '": each login in one slot', m && p && m !== p && [m, p].sort().join() === ['RT-' + name + 'A', 'RT-' + name + 'B'].sort().join())
    if (expect === 'finished') check('finished: main is the pinning login, the old main retired', m === 'RT-' + name + 'B' && logins.readMeta(ROOT, name).retired === true && logins.info(ROOT, name) === null)
    else check('undone: still a pinning login, not retired, taken over on the next try', !logins.readMeta(ROOT, name).retired && (await logins.exchange(ROOT, name, { ...X, retire: true })).ok)
  }

  console.log('\n-- another account\'s login held in a pinning folder --')
  saveAccount('held', 'held@example.com', login('HA', 20 * D))
  await logins.importPinning(ROOT, 'held', signInDir('held@example.com', login('HB', 25 * D)), OPTS)
  const other = login('HX', 30 * D)
  credstore.write(pinDir('held'), other, OPTS)
  r = await logins.holdForeign(ROOT, 'held', { expiresAt: NOW + 30 * D, oauthAccount: account('x@example.com') }, OPTS)
  check('held: it stays in the folder', r.ok && rt(pinned('held')) === 'RT-HX')
  check('but is no pinning login: no info, no wrapper login', logins.info(ROOT, 'held') === null && logins.wrapperLogin(ROOT, 'held') === null)
  check('the meta knows whose it is', logins.foreignOf(ROOT, 'held').oauthAccount.emailAddress === 'x@example.com')
  credstore.write(pinDir('held'), renewed(other, 'HX2'), OPTS)
  const to = path.join(TMP, 'takeout')
  fs.mkdirSync(to, { recursive: true })
  r = await logins.takeOutForeign(ROOT, 'held', to, OPTS)
  check('taken out: moved with its renewal and who it is', r.ok && r.moved && rt(credstore.read(to, OPTS)) === 'RT-HX2' &&
    JSON.parse(fs.readFileSync(path.join(to, '.claude.json'), 'utf8')).oauthAccount.emailAddress === 'x@example.com')
  check('and gone from the pinning folder', !logins.hasLogin(ROOT, 'held', OPTS) && !logins.readMeta(ROOT, 'held'))
  credstore.write(pinDir('held'), other, OPTS)
  await logins.holdForeign(ROOT, 'held', { expiresAt: NOW + 30 * D, oauthAccount: account('x@example.com') }, OPTS)
  credstore.write(pinDir('held'), login('HN', 40 * D), OPTS)
  r = await logins.takeOutForeign(ROOT, 'held', null, OPTS)
  check('a new sign-in since is left alone', !r.ok && r.reason === 'changed' && rt(pinned('held')) === 'RT-HN')
  credstore.write(pinDir('held'), other, OPTS)
  r = await logins.takeOutForeign(ROOT, 'held', null, OPTS)
  check('discarded: deleted', r.ok && !r.moved && !logins.hasLogin(ROOT, 'held', OPTS))

  console.log('\n-- a new login never goes in while a chat runs on a held login --')
  credstore.write(pinDir('held'), other, OPTS)
  await logins.holdForeign(ROOT, 'held', { expiresAt: NOW + 30 * D, oauthAccount: account('x@example.com') }, OPTS)
  const heldMarker = path.join(ROOT, 'pinning', '.inuse', process.pid + '.json')
  fs.mkdirSync(path.dirname(heldMarker), { recursive: true })
  fs.writeFileSync(heldMarker, JSON.stringify({ pid: process.pid, name: 'held', sessionId: 'chat-on-x' }))
  for (const mode of ['pinning', 'main-keep-old-for-pinning']) {
    r = await logins.adoptNewLogin(ROOT, 'held', signInDir('held@example.com', login('HP', 35 * D)), { ...X, mode })
    check(mode + ': refused while the held login\'s chat runs, nothing changed', !r.ok && r.reason === 'held-in-use' && rt(pinned('held')) === 'RT-HX' &&
      !!logins.foreignOf(ROOT, 'held') && rt(savedCreds('held')) === 'RT-HA', JSON.stringify(r))
  }
  fs.rmSync(heldMarker, { force: true })
  r = await logins.adoptNewLogin(ROOT, 'held', signInDir('held@example.com', login('HP', 35 * D)), { ...X, mode: 'pinning' })
  check('once that chat has ended, the new login replaces it', r.ok && rt(pinned('held')) === 'RT-HP' && !logins.foreignOf(ROOT, 'held') && logins.info(ROOT, 'held').expiresAt === NOW + 35 * D)

  console.log('\n-- a renewal moves the end date by a few ms: still the same login --')
  const drift = (creds, tag, ms) => ({ claudeAiOauth: { ...creds.claudeAiOauth, accessToken: 'AT-' + tag, refreshToken: 'RT-' + tag,
    refreshTokenExpiresAt: creds.claudeAiOauth.refreshTokenExpiresAt + ms } })
  const E = NOW + 20 * D
  check('sameLoginEnd: equal, a few ms apart either way, and up to the slack', logins.sameLoginEnd(E, E) && logins.sameLoginEnd(E, E + 37) &&
    logins.sameLoginEnd(E + 37, E) && logins.sameLoginEnd(E, E - 5000) && logins.sameLoginEnd(E, E + logins.RENEWAL_SLACK_MS))
  check('sameLoginEnd: past the slack, days apart, or unknown: not the same', !logins.sameLoginEnd(E, E + logins.RENEWAL_SLACK_MS + 1) &&
    !logins.sameLoginEnd(E, E + D) && !logins.sameLoginEnd(E, null) && !logins.sameLoginEnd(null, E) && !logins.sameLoginEnd(E, 'x'))
  check("the slack: a minute or more, under the few minutes between an account's main and pinning sign-ins", logins.RENEWAL_SLACK_MS >= 60e3 && logins.RENEWAL_SLACK_MS <= 5 * 60e3)
  {
    const a = login('WA', 20 * D)
    const b = login('WB', 30 * D)
    check('whose: a slot renewed with a drifted end date is still told apart', logins._test.whose(drift(a, 'WA2', 41), a, b) === 'A' &&
      logins._test.whose(drift(b, 'WB2', -12), a, b) === 'B' && logins._test.whose(login('WC', 40 * D), a, b) === 'other')
    check('whose: two logins whose ends are within the slack can\'t be told apart by them', logins._test.whose(drift(a, 'WA3', 5), a, drift(a, 'WB3', 20)) === 'unknown')
    const a5 = login('WD', 20 * D)
    const b5 = login('WE', 20 * D + 5 * 60e3)
    check('whose: main and pinning signed in minutes apart are still told apart after a renewal',
      logins._test.whose(drift(a5, 'WD2', 30), a5, b5) === 'A' && logins._test.whose(drift(b5, 'WE2', -30), a5, b5) === 'B')
  }
  {
    const keep = login('KD1', 20 * D)
    await logins.setPinningLogin(ROOT, 'kept', keep, account('kept@example.com'), OPTS)
    credstore.write(keptDir, drift(keep, 'KD1b', 37), OPTS)
    r = await logins.setPinningLogin(ROOT, 'kept', keep, account('kept@example.com'), OPTS)
    check('setPinningLogin: a renewal with a drifted end date is never written over with older tokens',
      r.ok && rt(credstore.read(keptDir, OPTS)) === 'RT-KD1b' && r.expiresAt === NOW + 20 * D + 37, JSON.stringify(r))

    check('setPinningLogin: signed in now unless told otherwise', logins.readMeta(ROOT, 'kept').signedInAt >= NOW)
    r = await logins.setPinningLogin(ROOT, 'kept', keep, account('kept@example.com'), { ...OPTS, signedInAt: NOW - 9 * D })
    check('setPinningLogin: an older sign-in time is kept when given (a held login kept again)', r.ok && logins.readMeta(ROOT, 'kept').signedInAt === NOW - 9 * D)
    r = await logins.setPinningLogin(ROOT, 'kept', keep, account('kept@example.com'), { ...OPTS, signedInAt: null })
    check('setPinningLogin: an unknown sign-in time given as null stays unknown (not now)', r.ok && logins.readMeta(ROOT, 'kept').signedInAt === null)

    const before = logins.readMeta(ROOT, 'kept')
    r = await logins.followRenewal(ROOT, 'kept', before.expiresAt + 21, OPTS)
    const after = logins.readMeta(ROOT, 'kept')
    check('followRenewal: the end date follows, the rest is unchanged', r.ok && r.changed && after.expiresAt === before.expiresAt + 21 &&
      JSON.stringify({ ...after, expiresAt: 0 }) === JSON.stringify({ ...before, expiresAt: 0 }), JSON.stringify(after))
    r = await logins.followRenewal(ROOT, 'kept', after.expiresAt + D, OPTS)
    check('followRenewal: an end date days away is a new sign-in, not followed', !r.ok && r.reason === 'not-a-renewal' && logins.readMeta(ROOT, 'kept').expiresAt === after.expiresAt)
    r = await logins.followRenewal(ROOT, 'kept', after.expiresAt + 5, { ...OPTS, lock: async () => null })
    check('followRenewal: a lock it can\'t get changes nothing', !r.ok && r.reason === 'locked' && logins.readMeta(ROOT, 'kept').expiresAt === after.expiresAt)
    r = await logins.followRenewal(ROOT, 'nobody', NOW, OPTS)
    check('followRenewal: no meta, nothing to follow', !r.ok && r.reason === 'no-login')
    await logins.holdForeign(ROOT, 'kept', { expiresAt: NOW + 30 * D, oauthAccount: account('x@example.com'), activeWas: 'work' }, OPTS)
    const f0 = logins.foreignOf(ROOT, 'kept')
    check('holdForeign records which account was active then', f0.activeWas === 'work')
    r = await logins.followRenewal(ROOT, 'kept', NOW + 30 * D - 15, OPTS)
    const f1 = logins.foreignOf(ROOT, 'kept')
    check('followRenewal: a held login\'s end date follows, still held, still no pinning login',
      r.ok && f1.expiresAt === NOW + 30 * D - 15 && f1.since === f0.since && logins.info(ROOT, 'kept') === null)
    await logins.remove(ROOT, 'kept', OPTS)
  }
  {
    const other2 = login('HD', 30 * D)
    credstore.write(pinDir('held'), other2, OPTS)
    await logins.holdForeign(ROOT, 'held', { expiresAt: NOW + 30 * D, oauthAccount: account('x@example.com') }, OPTS)
    credstore.write(pinDir('held'), drift(other2, 'HD2', 29), OPTS)
    r = await logins.takeOutForeign(ROOT, 'held', null, OPTS)
    check('takeOutForeign: a held login its chat renewed (end date a few ms later) is still taken out, not "changed"', r.ok && !logins.hasLogin(ROOT, 'held', OPTS), JSON.stringify(r))
  }

  console.log('\n-- how often to look for /login --')
  check('macOS: every 30 seconds (each look runs the security tool)', logins.loginCheckMs('darwin') === 30000)
  check('Windows and Linux: every 5 seconds (a file stat)', logins.loginCheckMs('win32') === 5000 && logins.loginCheckMs('linux') === 5000)

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  if (failed) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
