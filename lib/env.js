const KEY = 'CLAUDE_CONFIG_DIR'
const SECTION = 'claudeCode'
const SETTING = 'environmentVariables'

function read(vscode) {
  const cfg = vscode.workspace.getConfiguration(SECTION)
  const raw = cfg.get(SETTING)
  return Array.isArray(raw) ? raw.filter((e) => e && typeof e.name === 'string') : []
}

function currentConfigDir(vscode) {
  const hit = read(vscode).find((e) => e.name === KEY)
  return hit ? hit.value : null
}

async function setConfigDir(vscode, dir) {
  const others = read(vscode).filter((e) => e.name !== KEY)
  const next = dir ? [...others, { name: KEY, value: dir }] : others
  await vscode.workspace.getConfiguration(SECTION)
    .update(SETTING, next, vscode.ConfigurationTarget.Global)
}

module.exports = { KEY, currentConfigDir, setConfigDir, read }
