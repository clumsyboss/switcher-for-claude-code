# Experimental edition

The release, plus whatever is being tried out before it ships.

New features land here first. Once one has been used for real and works, it is
promoted into the release by adding its command ids to `MAIN_COMMANDS` (or, for
a switch on the Accounts page, its name to `MAIN_FEATURES`) in
[lib/edition.js](../lib/edition.js); its menu entries and settings follow it
automatically. Until then the release build leaves the feature out entirely:
its commands are not in the Command Palette, and nothing can call them by id.

## In testing right now

Nothing at the moment. The last three features in testing moved into the
release in 1.2.0: **a login for another PC**, **▶ start a 5-hour session** and
**chat context**. The README describes them. The per-account Artifacts switch
moved in 1.1.0.

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
