# Experimental edition

The release, plus whatever is being tried out before it ships.

New features land here first. Once one has been used for real and works, it is
promoted into the release by adding its command ids to `MAIN_COMMANDS` (or, for
a switch on the Accounts page, its name to `MAIN_FEATURES`) in
[lib/edition.js](../lib/edition.js); its menu entries and settings follow it
automatically. Until then the release build leaves the feature out entirely:
its commands are not in the Command Palette, and nothing can call them by id.

## In testing right now

**Artifacts per account.** Each account's card has an **Artifacts** switch next
to Remote Control. Turning it off stops Claude Code from publishing Artifacts
while that account is in use. It works through Claude Code's own setting,
`enableArtifact` in `~/.claude/settings.json`:

- Switching to an account set to off writes `"enableArtifact": false`;
  switching to one set to on removes the line again. Windows pinned to an
  account get its choice in their own `settings.json`.
- The switcher only ever turns Artifacts **off**. "On" means "as Claude Code
  would have it": Artifacts appear only where Anthropic offers them to that
  account, and a managed policy that turns them off still wins.
- Until some account is set to off, the switcher leaves `enableArtifact` alone,
  so a choice made in Claude Code's own `/config` is never overwritten.
- New chats follow the setting. Restart a chat that is already running to be
  sure it does.
- If `settings.json` is not valid JSON, it is left untouched and the switch
  says why.

To promote it into the release, add `'artifacts'` to `MAIN_FEATURES` in
[lib/edition.js](../lib/edition.js).

## Build and install

```powershell
npm run package:experimental
code --install-extension dist\claude-account-switcher-experimental-<version>.vsix
```

Then reload VS Code. It shares an extension id with the release, so installing
it **replaces** the release (and vice versa). Your saved accounts are kept
either way: they live in `~/.claude-switcher`, not in the extension.

To develop instead, open the repo in VS Code and press `F5`. Running from
source is always the experimental edition.

## Which one am I running?

The experimental build's name in the Extensions view ends in
**(Experimental)**, its account cards have the Artifacts switch, and **Claude
Accounts: Show Status** prints the edition on its first line.

## Tests

```powershell
npm test
```

Runs the extension against a mocked `vscode` API and a throwaway root
directory. Touches neither `~/.claude` nor `~/.claude-switcher`, and never
reaches the network. `test/edition.test.js` checks that a command added only
to experimental stays out of the release build, menus and settings included.
