# Experimental edition

The release, plus whatever is being tried out before it ships.

New features land here first. Once one has been used for real and works, it is
promoted into the release by adding its command ids to `MAIN_COMMANDS` (or, for
a switch on the Accounts page, its name to `MAIN_FEATURES`) in
[lib/edition.js](../lib/edition.js); its menu entries and settings follow it
automatically. Until then the release build leaves the feature out entirely:
its commands are not in the Command Palette, and nothing can call them by id.

## In testing right now

Nothing at the moment. **Moving accounts between PCs** (Move to another PC…,
and Add account → Import from a move file), **auto-continue** (Auto-continue After
Limits) and **keep alive** went straight into the release in 1.3.0. **A login for another PC**, **▶ start a 5-hour session** and **chat
context** moved in 1.2.0, and the per-account Artifacts switch in 1.1.0. The
README describes them all.

## Build and install

```powershell
npm run package:experimental
code --install-extension dist\switcher-for-claude-code-experimental-<version>.vsix
```

Then reload VS Code. It shares an extension id with the release, so installing
it **replaces** the release (and vice versa). Your saved accounts are kept
either way: they live in `~/.claude-switcher`, not in the extension.

To develop instead, open the repo in VS Code and press `F5`. Running from
source is always the experimental edition.

## Which one am I running?

The experimental build's name in the Extensions view ends in
**(Experimental)**, and **Claude Accounts: Show Status** prints the edition on
its first line.

## Tests

```powershell
npm test
```

Runs the extension against a mocked `vscode` API and a throwaway root
directory. Touches neither `~/.claude` nor `~/.claude-switcher`, and never
reaches the network. `test/edition.test.js` checks that a command added only
to experimental stays out of the release build, menus and settings included.
