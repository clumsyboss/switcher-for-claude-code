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

const aw = require('../lib/awaydesk.js')

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}

const DAY = 86400000
const T0 = Date.parse('2026-11-27T12:00:00Z')
const made = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-aw-')); made.push(d); return d }
const mpYes = { status: 200, body: JSON.stringify({ results: [{ extensions: [{ publisher: { publisherName: 'ClumsyBoss' }, extensionName: 'Awaydesk' }] }] }) }
const mpNo = { status: 200, body: JSON.stringify({ results: [{ extensions: [] }] }) }
const ovYes = { status: 200, body: JSON.stringify({ namespace: 'clumsyboss', name: 'awaydesk', version: '0.1.0' }) }

async function main() {
  console.log('\n-- what the pop-up offers --')
  const m = (installed, platform, listed) => aw.modeFor({ installed, platform, listed })
  check('installed: Connect a phone, on any system', m(true, 'win32', false) === 'connect' && m(true, 'darwin', false) === 'connect')
  check('not installed, on Windows, in the store: Get Awaydesk', m(false, 'win32', true) === 'get')
  check('not installed, on Windows, not in the store: Coming soon', m(false, 'win32', false) === 'soon')
  check('Mac and Linux: Coming to Mac and Linux later, store or not', m(false, 'darwin', true) === 'other' && m(false, 'linux', false) === 'other')

  console.log('\n-- which store --')
  check('VS Code and Insiders ask the Marketplace', aw.storeFor('Visual Studio Code') === 'marketplace' && aw.storeFor('Visual Studio Code - Insiders') === 'marketplace')
  check('Cursor, Windsurf, VSCodium and unknown editors ask Open VSX', ['Cursor', 'Windsurf', 'VSCodium', 'Code - OSS', '', undefined].every((n) => aw.storeFor(n) === 'openvsx'))

  console.log('\n-- reading an answer --')
  check('Marketplace: a match is listed, an empty list is not', aw.interpret('marketplace', mpYes).listed === true && aw.interpret('marketplace', mpNo).listed === false)
  check('Marketplace: another extension\'s match does not count', aw.interpret('marketplace', { status: 200, body: JSON.stringify({ results: [{ extensions: [{ publisher: { publisherName: 'someone' }, extensionName: 'awaydesk' }] }] }) }).listed === false)
  check('Open VSX: the extension is listed, a 404 is not', aw.interpret('openvsx', ovYes).listed === true && aw.interpret('openvsx', { status: 404, body: '{"error":"x"}' }).listed === false)
  check('Open VSX: a 200 that says error is not listed', aw.interpret('openvsx', { status: 200, body: '{"error":"Extension not found"}' }).listed === false)
  check('garbage, other codes and failures are errors, never "listed"', ['marketplace', 'openvsx'].every((s) =>
    aw.interpret(s, { status: 200, body: '<html>' }).error && aw.interpret(s, { status: 500, body: '' }).error && aw.interpret(s, { status: 0, error: 'x' }).error && aw.interpret(s, null).error))
  check('a Marketplace 404 is an error, not an answer', !!aw.interpret('marketplace', { status: 404, body: '' }).error)

  console.log('\n-- the once-a-day check, with a fake request --')
  {
    const dir = tmp()
    const asks = []
    const req = (answer) => async (o) => { asks.push(o); return answer }
    let r = await aw.check(dir, 'marketplace', true, { request: req(mpNo), now: T0 })
    check('asks once and keeps the answer in the Switcher\'s folder', r.asked && r.listed === false && asks.length === 1 && fs.existsSync(path.join(dir, 'awaydesk.json')))
    check('the ask carries only the store and a time limit, nothing about the user', Object.keys(asks[0]).sort().join() === 'store,timeoutMs')
    r = await aw.check(dir, 'marketplace', true, { request: req(mpYes), now: T0 + 3600e3 })
    check('a second look within the day (another window) asks nothing and reads the saved answer', !r.asked && asks.length === 1 && r.listed === false)
    r = await aw.check(dir, 'marketplace', true, { request: req(mpYes), now: T0 + DAY + 1000 })
    check('a day later it asks again and sees the new answer', r.asked && r.listed === true && asks.length === 2)
    check('saved as listed for the next window', aw.savedListed(dir, 'marketplace') === true)
    r = await aw.check(dir, 'openvsx', true, { request: req(ovYes), now: T0 + DAY + 2000 })
    check('each store has its own answer and its own day', r.asked && r.listed === true && aw.savedListed(dir, 'openvsx') === true && asks.length === 3)
    r = await aw.check(dir, 'marketplace', false, { request: req(mpYes), now: T0 + 9 * DAY })
    check('with the setting off nothing is asked', !r.asked && r.listed === false && asks.length === 3)
    r = await aw.check(dir, 'marketplace', true, { request: req(mpYes), now: T0 - 5 * DAY })
    check('a saved time in the future (clock moved back) counts as due', r.asked && asks.length === 4)
  }
  {
    const dir = tmp()
    let r = await aw.check(dir, 'openvsx', true, { request: async () => ({ status: 500, body: '' }), now: T0 })
    check('a failed ask is "not listed", saved, and tried again tomorrow', r.asked && r.error && r.listed === false && aw.readState(dir).openvsx.error === 'HTTP 500')
    r = await aw.check(dir, 'openvsx', true, { request: async () => { throw new Error('boom') }, now: T0 + 2 * DAY })
    check('a request that throws is the same', r.asked && r.error === 'boom' && r.listed === false)
    const memory = {}
    const dir2 = tmp()
    fs.mkdirSync(path.join(dir2, 'awaydesk.json'))
    let n = 0
    const counting = async () => { n++; return mpNo }
    await aw.check(dir2, 'marketplace', true, { request: counting, now: T0, memory })
    await aw.check(dir2, 'marketplace', true, { request: counting, now: T0 + 1000, memory })
    check('even when it cannot save, one window asks at most once a day', n === 1)
  }
  {
    const dir = tmp()
    const t0 = Date.now()
    const r = await aw.check(dir, 'openvsx', true, { request: () => new Promise(() => {}), now: T0, timeoutMs: 100 })
    check('a request that never answers is cut off at the time limit and does not hold the lock', r.asked && /timed out/.test(r.error) && Date.now() - t0 < 3000 &&
      (() => { const l = require('../lib/locks'); const rel = l.tryAcquire(dir, 'awaydesk-check', 1000); if (rel) rel(); return !!rel })())
  }
  {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'awaydesk.json'), JSON.stringify({ marketplace: { checkedAt: 'soon', listed: 'yes' }, openvsx: 5 }))
    check('a damaged file reads as nothing saved', aw.readState(dir).marketplace === null && aw.readState(dir).openvsx === null && aw.savedListed(dir, 'marketplace') === false)
  }

  console.log('\n-- the real request, against a small server on 127.0.0.1 --')
  let mode = 'ok'
  const seen = []
  const MB11 = Math.round(1.1 * 1024 * 1024)
  const server = http.createServer((rq, rs) => {
    const chunks = []
    rq.on('data', (d) => chunks.push(d))
    rq.on('end', () => {
      seen.push({ path: rq.url, method: rq.method, headers: rq.headers, body: Buffer.concat(chunks).toString('utf8') })
      if (mode === 'ok') { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(rq.method === 'POST' ? mpYes.body : ovYes.body) }
      else if (mode === 'big') { rs.writeHead(200); rs.end(Buffer.alloc(MB11, 'x')) }
      else if (mode === 'drip') { rs.writeHead(200); const t = setInterval(() => { if (!rs.destroyed) rs.write('x') }, 50); rs.on('close', () => clearInterval(t)) }
      else if (mode === 'redirect') { rs.writeHead(301, { Location: 'http://127.0.0.1:1/elsewhere' }); rs.end() }
      else { rs.writeHead(Number(mode)); rs.end('{"error":"no"}') }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const ask = (store, timeoutMs) => aw.defaultRequest({ store, local: { port }, timeoutMs })
  let res = await ask('marketplace')
  check('Marketplace: a POST of the extension-id search, JSON, plain User-Agent', res.status === 200 && seen[0].method === 'POST' && seen[0].path === '/_apis/public/gallery/extensionquery' &&
    seen[0].headers['user-agent'] === 'switcher-for-claude-code' && JSON.parse(seen[0].body).filters[0].criteria[0].value === 'clumsyboss.awaydesk', JSON.stringify(seen[0]))
  check('and it reads as listed', aw.interpret('marketplace', res).listed === true)
  res = await ask('openvsx')
  check('Open VSX: a GET of the extension\'s own address, no body', res.status === 200 && seen[1].method === 'GET' && seen[1].path === '/api/clumsyboss/awaydesk' && seen[1].body === '' &&
    aw.interpret('openvsx', res).listed === true)
  check('nothing about the user goes with either: no cookie, no authorization, no id header', seen.every((s) => !s.headers.cookie && !s.headers.authorization &&
    Object.keys(s.headers).every((k) => ['host', 'connection', 'user-agent', 'accept', 'content-type', 'content-length'].includes(k))), JSON.stringify(seen.map((s) => Object.keys(s.headers))))
  check('what is sent is only the extension\'s public id', !/token|email|account|machine|user/i.test(seen[0].body))
  mode = '404'
  res = await ask('openvsx')
  check('a 404 from Open VSX reads as not listed', res.status === 404 && aw.interpret('openvsx', res).listed === false)
  mode = 'big'
  res = await ask('openvsx')
  check('an answer over 1 MB is refused', res.status === 0 && /too large/.test(res.error))
  mode = 'drip'
  const t0 = Date.now()
  res = await ask('openvsx', 300)
  check('an answer that never ends is cut off at the limit, from start to end', res.status === 0 && /timed out/.test(res.error) && Date.now() - t0 < 3000)
  mode = 'redirect'
  res = await ask('marketplace')
  check('a redirect is not followed', res.status === 301 && aw.interpret('marketplace', res).error)
  mode = 'ok'
  const dir = tmp()
  const r = await aw.check(dir, 'marketplace', true, { request: (o) => aw.defaultRequest({ ...o, local: { port } }), now: T0 })
  check('the whole check through the real request: saved as listed', r.asked && r.listed === true && aw.savedListed(dir, 'marketplace') === true)
  await new Promise((r2) => server.close(r2))
  check('and nothing reached a real address', realRequests === 0)

  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {  } }
  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  if (failed) process.exit(1)
}
const keep = setInterval(() => {}, 1000)
main().then(() => clearInterval(keep)).catch((e) => { console.log('  FAIL ' + (e && e.stack || e)); process.exit(1) })
