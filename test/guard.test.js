require('./fake-security')
const { spawnSync } = require('child_process')
const path = require('path')

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}

const probe = "require(" + JSON.stringify(path.join(__dirname, 'fake-security.js')) + "); console.log(JSON.stringify([process.env.CLAUDE_CONFIG_DIR || null, process.env.SWITCHER_TEST_GUARDED, process.pid]))"
function run(guard) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: 'some-dir' }
  delete env.NODE_OPTIONS; delete env.FAKE_KEYCHAIN_FILE; delete env.FAKE_HOME_DIR
  if (guard === undefined) delete env.SWITCHER_TEST_GUARDED; else env.SWITCHER_TEST_GUARDED = guard
  const r = spawnSync(process.execPath, ['-e', probe], { env, encoding: 'utf8' })
  return r.status === 0 ? JSON.parse(r.stdout.trim().split('\n').pop()) : { error: r.stderr }
}

console.log('-- test guard --')
check('this process marks itself with its pid', process.env.SWITCHER_TEST_GUARDED === String(process.pid), process.env.SWITCHER_TEST_GUARDED)
let r = run(undefined)
check('a fresh test process drops the login variables', r[0] === null && r[1] === String(r[2]), JSON.stringify(r))
r = run(String(process.pid))
check('a child of a guarded process keeps what its parent gave it', r[0] === 'some-dir', JSON.stringify(r))
const dead = String(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout)
r = run(dead)
check('a value left in an outside shell (a program that has ended) does not switch the guard off', r[0] === null && r[1] === String(r[2]), JSON.stringify(r))

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
