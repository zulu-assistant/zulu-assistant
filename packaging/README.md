# Packaging (drafts — not published yet)

The board writes its own `data/` and `overlay/` next to the code, so it lives in a
normal git clone, never inside a package manager's read-only prefix. Both
one-liners therefore install only a small `zulu` launcher that clones the repo to
`~/zulu-assistant` on first use and then runs `./install.sh` with your arguments.

| | Status | Command (once published) |
|---|---|---|
| Homebrew tap | draft formula in `homebrew/`; needs a `zulu-assistant/homebrew-tap` repo | `brew install zulu-assistant/tap/zulu-assistant && zulu --demo` |
| npx | draft package in `npm/`; needs the `zulu-assistant` name on npm | `npx zulu-assistant --demo` |

Until then: `git clone https://github.com/zulu-assistant/zulu-assistant.git && cd zulu-assistant && ./install.sh --demo`.

`ZULU_HOME` overrides the clone location for both.
