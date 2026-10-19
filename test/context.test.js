require('./fake-security')

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ctx = require('../lib/context.js')

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-context-'))
const DIR = path.join(TMP, 'projects', 'c--code-app')
fs.mkdirSync(DIR, { recursive: true })

const reply = (used, at, model) => ({ type: 'assistant', timestamp: at, message: { model: model || 'claude-opus-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: used - 10 } } })
const boundary = (pre, post, at) => ({ type: 'system', subtype: 'compact_boundary', timestamp: at, compactMetadata: { trigger: 'manual', preTokens: pre, postTokens: post } })
function chat(name, records) {
  const f = path.join(DIR, name + '.jsonl')
  fs.writeFileSync(f, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return f
}

console.log('readChat')
{
  const c = ctx.readChat(chat('plain', [{ type: 'custom-title', customTitle: 'Plain chat' }, reply(150000, '2026-10-19T10:00:00Z')]))
  check('uses the last reply', c.used === 150000 && c.peak === 150000, JSON.stringify(c))
  check('reads the title', c.title === 'Plain chat')
}
{
  const c = ctx.readChat(chat('compacted', [reply(876000, '2026-10-19T10:00:00Z'), boundary(876641, 11939, '2026-10-19T10:05:00Z'), { type: 'user', message: { content: 'summary' } }]))
  check('a compaction after the last reply sets the size', c.used === 11939, String(c.used))
  check('remembers the size before compacting', c.peak === 876641, String(c.peak))
  check('dates the chat from the compaction', c.at === Date.parse('2026-10-19T10:05:00Z'))
  const [f] = ctx.withFill([c])
  check('keeps the 1M window after compacting', f.limit === ctx.LARGE_WINDOW && f.pct === 1, JSON.stringify(f))
}
{
  const c = ctx.readChat(chat('replied', [reply(876000, '2026-10-19T10:00:00Z'), boundary(876641, 11939, '2026-10-19T10:05:00Z'), reply(43162, '2026-10-19T10:06:00Z')]))
  check('the next reply takes over again', c.used === 43162, String(c.used))
}
{
  const c = ctx.readChat(chat('nopost', [reply(300000, '2026-10-19T10:00:00Z'), { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 300000 } }]))
  check('an old compaction record without postTokens keeps the reply', c.used === 300000, String(c.used))
}
{
  const c = ctx.readChat(chat('older', [boundary(500000, 9000, '2026-10-19T09:00:00Z'), reply(60000, '2026-10-19T10:00:00Z')]))
  check('a compaction before the last reply is ignored', c.used === 60000 && c.peak === 60000, JSON.stringify(c))
}

console.log('isCompacting')
{
  const q = (operation, content, at) => ({ type: 'queue-operation', operation, timestamp: at, ...(content === undefined ? {} : { content }) })
  const user = { type: 'user', message: { content: 'go on' } }
  const busy = { status: 'busy', now: Date.now() }
  const at = '2026-10-19T10:00:01Z'
  const compacting = (name, records, o) => {
    const c = ctx.readChat(chat(name, records))
    return ctx.isCompacting({ ...c, pct: 20 }, o || busy)
  }
  check('a background agent reporting back is not a compaction',
    !compacting('agent', [reply(200000, at), q('enqueue', '<task-notification>\n<task-id>x</task-id>', at)]))
  check('nor is an agent message', !compacting('agentmsg', [reply(200000, at), q('enqueue', '<agent-message from="a">hi</agent-message>', at)]))
  check('nor a message typed mid-turn, or taken back', !compacting('typed', [reply(200000, at), q('enqueue', 'also check X', at), q('remove', 'also check X', at)]))
  check('nor another slash command', !compacting('context', [reply(200000, at), q('enqueue', '/context', at)]))
  check('a queued /compact is', compacting('compact', [reply(200000, at), q('enqueue', '/compact', at)]))
  check('with instructions too', compacting('compactargs', [reply(200000, at), q('enqueue', '/compact keep the plan', at)]))
  check('and while it runs, after it leaves the queue', compacting('running', [reply(200000, at), q('enqueue', '/compact', at), q('dequeue', undefined, at)]))
  check('and with an agent queued behind it', compacting('behind', [reply(200000, at), q('enqueue', '/compact', at), q('enqueue', '<task-notification>', at)]))
  check('but not once it was taken back', !compacting('cancelled', [reply(200000, at), q('enqueue', '/compact', at), q('remove', '/compact', at)]))
  check('nor after the chat moved on', !compacting('done', [reply(200000, at), q('enqueue', '/compact', at), user]))
  check('nor when the chat is idle', !compacting('idle', [reply(200000, at), q('enqueue', '/compact', at)], { status: 'idle', now: Date.now() }))
  check('/compacting is not /compact', !compacting('prefix', [reply(200000, at), q('enqueue', '/compacting', at)]))
}

console.log('project folder names (L2)')
{
  check('a short path: every non-alphanumeric character becomes "-"', ctx.projectKey('/Users/me/my app') === '-Users-me-my-app')
  const long = '/Users/me/' + 'deep/'.repeat(50) + 'project'
  const k = ctx.projectKey(long)
  let h = 0
  for (let i = 0; i < long.length; i++) h = ((h << 5) - h + long.charCodeAt(i)) | 0
  check('a long path is cut at 200 characters and given a hash, as Claude Code names it',
    k === long.replace(/[^A-Za-z0-9]/g, '-').slice(0, 200) + '-' + Math.abs(h).toString(36), k.slice(190))
  if (process.platform !== 'win32') {
    const real = path.join(TMP, 'real-project')
    const link = path.join(TMP, 'linked-project')
    fs.mkdirSync(real, { recursive: true })
    fs.symlinkSync(real, link)
    const realKey = ctx.projectKey(fs.realpathSync.native(real))
    const chats = [{ id: 'c1', project: realKey, at: 1 }]
    check('a folder opened through a symlink finds its chats under the real path', ctx.currentChat(chats, link) === chats[0])
    check('and so does a pin made through the symlink', ctx.accountOf(chats[0], { pins: { [link]: 'work' }, liveLog: [] }) === 'work')
  }
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log('\n' + passed + ' passed, ' + failed + ' failed')
assert.strictEqual(failed, 0, 'context tests failed')
