const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-tracker-'))
process.env.USERPROFILE = HOME
process.env.HOME = HOME
const ROOT = path.join(HOME, '.claude-switcher')

const profiles = require('../lib/profiles.js')
const tracker = require('../lib/tracker.js')
const locks = require('../lib/locks.js')
const oauth = require('../lib/oauth.js')
const usage = require('../lib/usage.js')
const store = require('../lib/store.js')

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}

const calls = { refresh: [], fetch: [] }
let refreshReply = null
let fetchReply = null
let refreshDelayMs = 0
tracker._test.transport.refresh = async (rt) => {
  calls.refresh.push(rt)
  if (refreshDelayMs) await new Promise((r) => setTimeout(r, refreshDelayMs))
  return typeof refreshReply === 'function' ? refreshReply(rt) : refreshReply
}
tracker._test.transport.fetchUsage = async (token) => { calls.fetch.push(token); return fetchReply }
const reset = () => { calls.refresh.length = 0; calls.fetch.length = 0 }
const tokenOk = (n, extra) => ({ status: 200, body: JSON.stringify({ access_token: 'AT-' + n, refresh_token: 'RT-' + n, expires_in: 28800, scope: oauth.SCOPES.join(' '), ...(extra || {}) }) })

const H = 3600e3
function signIn(email, uuid, tag, expiresInMs) {
  fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'AT-' + tag, refreshToken: 'RT-' + tag, expiresAt: Date.now() + expiresInMs,
      scopes: oauth.SCOPES, subscriptionType: 'max', rateLimitTier: 'tier' },
  }))
  const cfgPath = path.join(HOME, '.claude.json')
  const prev = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {}
  fs.writeFileSync(cfgPath, JSON.stringify({ ...prev, oauthAccount: { emailAddress: email, accountUuid: uuid, organizationName: 'Acme' } }))
}
const saved = (name) => profiles.readPayload(ROOT, name).credentials.claudeAiOauth
const meta = (name) => profiles.readMeta(ROOT, name)

async function main() {
  store.ensureRoot(ROOT)
  signIn('a@example.com', 'uuid-a', 'A', 0.5 * H)
  profiles.capture(ROOT, 'alpha')
  signIn('b@example.com', 'uuid-b', 'B', -1 * H)
  profiles.capture(ROOT, 'beta')
  signIn('c@example.com', 'uuid-c', 'C', 6 * H)
  profiles.capture(ROOT, 'gamma')
  profiles.apply(ROOT, 'beta')

  console.log('\n-- the request is exactly what Claude Code sends --')
  const b = oauth.body('RT-X')
  check('grant_type refresh_token', b.grant_type === 'refresh_token')
  check('Claude Code client id', b.client_id === '9d1c250a-e61b-44d9-88ed-5944d1962f5e')
  check('Claude Code default scopes', b.scope === 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins')
  check('to Claude Code token endpoint', oauth.TOKEN_HOST === 'platform.claude.com' && oauth.TOKEN_PATH === '/v1/oauth/token')

  console.log('\n-- renewing a saved account that is about to expire --')
  const capturedBefore = meta('alpha').capturedAt
  refreshReply = tokenOk('A2')
  reset()
  let r = await tracker.renew(ROOT, 'alpha')
  check('renewed', r.renewed === true, JSON.stringify(r))
  check('with its own refresh token, once', calls.refresh.length === 1 && calls.refresh[0] === 'RT-A', calls.refresh.join(','))
  check('new access token stored', saved('alpha').accessToken === 'AT-A2')
  check('new refresh token stored', saved('alpha').refreshToken === 'RT-A2')
  check('expires 8 h from now', Math.abs(saved('alpha').expiresAt - (Date.now() + 8 * H)) < 5000)
  check('plan details kept', saved('alpha').subscriptionType === 'max' && saved('alpha').rateLimitTier === 'tier')
  check('"saved at" untouched, so a newer sign-in is never mistaken for older', meta('alpha').capturedAt === capturedBefore)
  check('renewal time recorded', !!meta('alpha').renewedAt)

  console.log('\n-- only when due --')
  reset()
  r = await tracker.renew(ROOT, 'alpha')
  check('a token with 8 h left is left alone', r.skipped === 'fresh' && calls.refresh.length === 0)
  r = await tracker.renew(ROOT, 'gamma')
  check('so is one with 6 h left', r.skipped === 'fresh' && calls.refresh.length === 0)

  console.log('\n-- RULE 1: never the live login --')
  reset()
  r = await tracker.renew(ROOT, 'beta', { force: true })
  check('the live account is not renewed, even expired and forced', r.skipped === 'live' && calls.refresh.length === 0, JSON.stringify(r))
  const betaMeta = meta('beta'); profiles.writeMeta(ROOT, 'beta', { ...betaMeta, email: 'renamed@example.com' })
  r = await tracker.renew(ROOT, 'beta', { force: true })
  check('caught by account id when the email differs', r.skipped === 'live' && calls.refresh.length === 0)
  profiles.writeMeta(ROOT, 'beta', betaMeta)
  const cfgPath = path.join(HOME, '.claude.json')
  const cfgGood = fs.readFileSync(cfgPath, 'utf8')
  fs.writeFileSync(cfgPath, '{"projects":{}}')
  r = await tracker.renew(ROOT, 'alpha', { force: true })
  check('unknown live identity means no renewals at all', r.skipped === 'live' && calls.refresh.length === 0, JSON.stringify(r))
  fs.writeFileSync(cfgPath, cfgGood)
  const liveCreds = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', '.credentials.json'), 'utf8'))
  const alphaPayload = profiles.readPayload(ROOT, 'alpha')
  profiles.updateCredentials(ROOT, 'alpha', { ...alphaPayload.credentials,
    claudeAiOauth: { ...alphaPayload.credentials.claudeAiOauth, refreshToken: liveCreds.claudeAiOauth.refreshToken } })
  r = await tracker.renew(ROOT, 'alpha', { force: true })
  check('a saved copy of the live token is never renewed', r.skipped === 'live' && calls.refresh.length === 0)
  profiles.updateCredentials(ROOT, 'alpha', alphaPayload.credentials)

  console.log('\n-- RULE 2: one at a time, across windows --')
  reset()
  refreshDelayMs = 150
  refreshReply = tokenOk('A3')
  const [r1, r2] = await Promise.all([
    tracker.renew(ROOT, 'alpha', { force: true }),
    new Promise((res) => setTimeout(() => res(tracker.renew(ROOT, 'alpha', { force: true })), 20)),
  ])
  refreshDelayMs = 0
  check('two windows renewing at once: one request', calls.refresh.length === 1, String(calls.refresh.length))
  check('the other stands aside', [r1, r2].some((x) => x.skipped === 'busy') && [r1, r2].some((x) => x.renewed))
  const release = locks.tryAcquire(ROOT, tracker.accountLock('alpha'))
  reset()
  r = await tracker.renew(ROOT, 'alpha', { force: true })
  check('a switch holding the lock blocks renewal', r.skipped === 'busy' && calls.refresh.length === 0)
  let waited = false
  const pending = locks.acquire(ROOT, tracker.accountLock('alpha'), { waitMs: 2000, pollMs: 20 }).then((rel) => { waited = true; return rel })
  await new Promise((res) => setTimeout(res, 100))
  check('and a switch waits for a renewal in progress', waited === false)
  release()
  const rel2 = await pending
  check('then proceeds as soon as it finishes', waited && typeof rel2 === 'function')
  rel2()
  const held = locks.tryAcquire(ROOT, 'x')
  check('waiting gives up after its timeout', (await locks.acquire(ROOT, 'x', { waitMs: 60, pollMs: 20 })) === null)
  held()
  const lockFile = locks.lockPath(ROOT, 'crashed')
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  fs.writeFileSync(lockFile, 'dead-window')
  const old = new Date(Date.now() - 10 * 60e3)
  fs.utimesSync(lockFile, old, old)
  const takeover = locks.tryAcquire(ROOT, 'crashed')
  check('a lock left by a crashed window is taken over', typeof takeover === 'function')
  fs.writeFileSync(lockFile, 'someone-else')
  takeover()
  check('and a late release never removes someone else\'s lock', fs.readFileSync(lockFile, 'utf8') === 'someone-else')
  fs.rmSync(lockFile)

  console.log('\n-- RULE 3: the new token is kept --')
  reset()
  refreshReply = { status: 200, body: JSON.stringify({ access_token: 'AT-A4', expires_in: 28800 }) }
  const rtBefore = saved('alpha').refreshToken
  await tracker.renew(ROOT, 'alpha', { force: true })
  check('no new refresh token in the reply: the old one is kept', saved('alpha').refreshToken === rtBefore && saved('alpha').accessToken === 'AT-A4')
  reset()
  refreshReply = { status: 200, body: '{"expires_in":28800}' }
  r = await tracker.renew(ROOT, 'alpha', { force: true })
  check('a reply with no token changes nothing', r.failed === 'transient' && saved('alpha').accessToken === 'AT-A4')

  console.log('\n-- RULE 4: a rejected token stops --')
  for (const [what, reply] of [['server error', { status: 500, body: '' }], ['network down', { status: 0, body: '', error: 'ECONNRESET' }], ['rate limit', { status: 429, body: '' }]]) {
    reset(); refreshReply = reply
    r = await tracker.renew(ROOT, 'alpha', { force: true })
    check(what + ' is transient: token kept, not marked', r.failed === 'transient' && saved('alpha').accessToken === 'AT-A4' && !meta('alpha').needsLogin)
  }
  reset()
  refreshReply = { status: 400, body: JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token expired' }) }
  r = await tracker.renew(ROOT, 'alpha', { force: true })
  check('invalid_grant marks "sign in again"', r.failed === 'rejected' && meta('alpha').needsLogin === true, JSON.stringify(r))
  check('with the reason', /invalid_grant/.test(meta('alpha').needsLoginReason))
  reset()
  r = await tracker.renew(ROOT, 'alpha', { force: true })
  check('and is never retried', r.skipped === 'needs-login' && calls.refresh.length === 0)
  check('a 401 counts as rejected too', oauth.interpret({ status: 401, body: '{}' }, {}).rejected === true)
  const liveBackup = fs.readFileSync(path.join(HOME, '.claude', '.credentials.json'))
  const cfgBackup = fs.readFileSync(cfgPath)
  signIn('a@example.com', 'uuid-a', 'A9', 8 * H)
  profiles.capture(ROOT, 'alpha')
  check('signing in again clears the mark', !meta('alpha').needsLogin)
  fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), liveBackup)
  fs.writeFileSync(cfgPath, cfgBackup)

  console.log('\n-- RULE 5: polling usage --')
  const fresh = (pct, resetInH) => ({ ok: true, utilization: { limits: [
    { kind: 'session', percent: pct, resets_at: new Date(Date.now() + resetInH * H).toISOString() },
    { kind: 'weekly_all', percent: pct * 2, resets_at: new Date(Date.now() + 100 * H).toISOString() },
  ] } })
  reset(); fetchReply = fresh(7, 2)
  r = await tracker.poll(ROOT, 'alpha')
  check('reads a saved account with its own token', r.polled && calls.fetch[0] === 'AT-A9', JSON.stringify(r) + ' ' + calls.fetch.join(','))
  check('stored under its account id', usage.readCacheForKey(ROOT, 'uuid-a').session.percent === 7)
  reset()
  r = await tracker.poll(ROOT, 'alpha')
  check('not again within 15 min', r.skipped === 'fresh' && calls.fetch.length === 0)
  r = await tracker.poll(ROOT, 'beta', { force: true })
  check('the live account is never polled', r.skipped === 'live' && calls.fetch.length === 0)
  const g = profiles.readPayload(ROOT, 'gamma')
  profiles.updateCredentials(ROOT, 'gamma', { ...g.credentials, claudeAiOauth: { ...g.credentials.claudeAiOauth, expiresAt: Date.now() - 1000 } })
  r = await tracker.poll(ROOT, 'gamma')
  check('an expired token is not used', r.skipped === 'token-expired' && calls.fetch.length === 0)
  profiles.updateCredentials(ROOT, 'gamma', g.credentials)
  reset(); fetchReply = { ok: false, rateLimited: true, retryAfterMs: 60e3 }
  r = await tracker.poll(ROOT, 'gamma')
  check('a 429 pauses that account', r.failed === 'rate-limited' && usage.pausedUntil(ROOT, 'uuid-c') > Date.now())
  reset()
  r = await tracker.poll(ROOT, 'gamma', { force: true })
  check('nothing is sent while paused, even forced', r.skipped === 'paused' && calls.fetch.length === 0)
  r = await tracker.poll(ROOT, 'gamma', { now: Date.now() + 2 * 60e3 })
  check('and it resumes once the pause is over', r.polled === true || r.failed === 'rate-limited', JSON.stringify(r))

  console.log('\n-- the table --')
  usage.writeCacheForKey(ROOT, 'uuid-c', { limits: [
    { kind: 'session', percent: 90, resets_at: new Date(Date.now() - H).toISOString() },
    { kind: 'weekly_all', percent: 40, resets_at: new Date(Date.now() + 50 * H).toISOString() },
  ] }, Date.now() - 3 * H)
  const rows = tracker.snapshot(ROOT)
  check('one row per saved account', rows.length === 3, rows.map((x) => x.name).join(','))
  check('live account first', rows[0].name === 'beta' && rows[0].active)
  const gammaRow = rows.find((x) => x.name === 'gamma')
  check('a 5h window that has reset shows 0%, not the old 90%', gammaRow.session.percent === 0 && gammaRow.session.resetSince)
  check('an unexpired weekly figure is kept', gammaRow.weekly.percent === 40 && !gammaRow.weekly.resetSince)
  const alphaRow = rows.find((x) => x.name === 'alpha')
  check('figures carry their age', alphaRow.fetchedAtMs > Date.now() - 60e3)
  check('most room: alpha (worst 14%) beats gamma (worst 40%)',
    tracker.mostRoom(rows).name === 'alpha', tracker.mostRoom(rows).name)
  profiles.markNeedsLogin(ROOT, 'alpha', 'test')
  check('an account that needs signing in is never "most room"', tracker.mostRoom(tracker.snapshot(ROOT)).name !== 'alpha')
  check('and says so in its row', tracker.snapshot(ROOT).find((x) => x.name === 'alpha').needsLogin)

  console.log('\n-- the leaving account keeps its figures across a switch --')
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  cfg.cachedUsageUtilization = { fetchedAtMs: Date.now(), utilization: { limits: [{ kind: 'session', percent: 33 }] } }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg))
  check('saved under the live account id', usage.rememberClaudeCache(ROOT, null) && usage.readCacheForKey(ROOT, 'uuid-b').session.percent === 33)
  cfg.cachedUsageUtilization.fetchedAtMs = Date.now() - H
  fs.writeFileSync(cfgPath, JSON.stringify(cfg))
  check('an older figure never overwrites a newer one', usage.rememberClaudeCache(ROOT, null) === false)

  console.log('\n-- a whole round --')
  profiles.writeMeta(ROOT, 'alpha', { ...meta('alpha'), needsLogin: undefined })
  const a = profiles.readPayload(ROOT, 'alpha')
  profiles.updateCredentials(ROOT, 'alpha', { ...a.credentials, claudeAiOauth: { ...a.credentials.claudeAiOauth, expiresAt: Date.now() + 10 * 60e3 } })
  reset(); refreshReply = tokenOk('A5'); fetchReply = fresh(3, 1)
  const res = await tracker.tick(ROOT)
  check('renews only what is due', calls.refresh.length === 1 && calls.refresh[0] === 'RT-A9', calls.refresh.join(','))
  check("never sends the live account's tokens anywhere",
    !calls.refresh.some((t) => /^RT-B/.test(t)) && !calls.fetch.some((t) => /^AT-B/.test(t)),
    calls.refresh.concat(calls.fetch).join(','))
  check('and never renews it', res.some((x) => x.name === 'beta' && x.skipped === 'live') && !res.some((x) => x.name === 'beta' && x.renewed))
  reset(); fetchReply = fresh(5, 1)
  const clicked = await tracker.tick(ROOT, { forcePoll: true })
  check('a click re-reads accounts whose figures are fresh', calls.fetch.length > 0, JSON.stringify(clicked))
  check('but never forces a renewal that is not due', calls.refresh.length === 0, calls.refresh.join(','))
  check('and still honours a rate-limit pause',
    clicked.some((x) => x.name === 'gamma' && x.skipped === 'paused') || usage.pausedUntil(ROOT, 'uuid-c') <= Date.now())
  check('no step throws', res.every((x) => !(x.failed === 'error')), JSON.stringify(res.filter((x) => x.failed === 'error')))
}

main()
  .catch((e) => { failed++; console.log('  FAIL crashed: ' + (e && e.stack)) })
  .finally(() => {
    fs.rmSync(HOME, { recursive: true, force: true })
    console.log('\n' + passed + ' passed, ' + failed + ' failed')
    assert.strictEqual(failed, 0, 'tracker tests failed')
  })
