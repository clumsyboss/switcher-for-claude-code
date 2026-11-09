# Move file fixtures

One account move file per format, written by the version that introduced it.
`test/move.test.js` imports each one, so every later version keeps opening
every file people already have.

| File | Format | Written by | Inside |
|---|---|---|---|
| `move-format-1.move` | `claude-switcher-move/1` | 1.1.0, "Make a login for another PC…" | Fixture-Spare |
| `move-format-2.move` | `claude-switcher-move/2` | 1.2.0, `move-accounts.js export` | Fixture-Work (Remote Control and Artifacts off), Fixture-Home |

The passphrase is `fixture passphrase 1`. Every token and account in them is
made up.

Never edit or regenerate these files. A new format gets a new magic, a new
file here and a new row in this table.
