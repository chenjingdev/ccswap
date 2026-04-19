# ccswap

`ccswap` is a small dashboard/TUI for Claude Code multi-account workflows.

It manages multiple Claude subscription accounts by saving one real
`claude auth login` session per account, then runs Claude through an auto-swap
wrapper that can move to the next account when the current one hits a limit.

## What It Does

- open a TUI dashboard with `ccswap`
- register 2, 3, 4, or more Claude accounts
- save one Claude login per account
- show per-account auth/subscription status
- mark one account as active
- manually switch active accounts
- auto-swap to the next healthy account on limit / 429 style errors

## Install The Command

The workspace includes:

- `/Users/chenjing/dev/ccswap/ccswap.py`

If you want the bare `ccswap` command globally, symlink it into your PATH:

```bash
ln -sf /Users/chenjing/dev/ccswap/ccswap.py ~/.local/bin/ccswap
chmod +x /Users/chenjing/dev/ccswap/ccswap.py
```

## First Run

Open the dashboard:

```bash
ccswap
```

Inside the dashboard:

- `a` adds an account row
- `l` launches `claude auth login` for the selected account and saves that login
- `r` renames the selected account
- `Enter` makes the selected account active
- `space` includes or excludes the selected account from auto-swap
- `Tab` switches between the Accounts and Sessions screens

## CLI Flow

If you want to manage things outside the dashboard:

```bash
ccswap init
ccswap account add work
ccswap account add personal
ccswap account rename personal side
ccswap login work
ccswap login personal
ccswap use work
ccswap run
```

The quickest day-to-day flow is to proxy Claude directly through `ccswap`:

```bash
ccswap claude
ccswap claude --model haiku
ccswap claude --continue
```

Everything after `ccswap claude` is forwarded to Claude, so this is the
recommended entrypoint when you want auto-swap without opening the dashboard.

Pass Claude args through:

```bash
ccswap run -- --model sonnet
```

## Dashboard Keys

- `j` / `k` or arrows: move selection
- `a`: add account
- `l`: login with Claude and save the selected account
- `r`: rename selected account
- `Enter`: set selected account active
- `space`: include/exclude selected account from auto-swap
- `d`: delete selected account
- `s`: open settings on the Sessions screen
- `Tab`: switch between Accounts and Sessions
- `1-9`: jump to account row
- `?`: help
- `q`: quit

## Session Settings

Press `s` in the Sessions screen to open replay settings.

Sessions screen settings:

- `m`: cycle replay mode
- `p`: set the custom replay prompt
- `x`: run Claude
- `r`: run Claude with extra args
- `q` / `Esc`: close settings

## How Accounts Are Stored

Each account gets its own Claude config directory under:

```text
~/.config/ccswap/accounts/<name>/claude
```

`ccswap` also saves one Claude login snapshot per account in your macOS
Keychain. When you launch through `ccswap`, it restores the selected account's
Claude credentials before starting Claude Code.

## Login Setup

`ccswap` uses real Claude subscription logins for interactive Claude Code.

Recommended flow:

1. Select an account row
2. Press `l`
3. Complete the browser flow from `claude auth login`
4. When the command finishes, `ccswap` saves the resulting Claude login for that account

You can also do the same from CLI:

```bash
ccswap login work
```

## Auto-Swap Behavior

When Claude prints a limit message like `You've hit your limit`, `ccswap`:

1. marks the current account as cooled down
2. picks the next account that is included in auto-swap and not on cooldown
3. uses runtime hooks to capture the current `session_id` and the latest submitted prompt
4. relaunches Claude on the next account using the configured replay mode:
   - `Last prompt`: `claude --resume <session-id> "<last-prompt>"`
   - `Continue only`: `claude --resume <session-id>`
   - `Custom prompt`: `claude --resume <session-id> "<custom-prompt>"`

If Claude prints a reset time, `ccswap` uses it. Otherwise it falls back to a
default cooldown window.

## Files

```text
~/.config/ccswap/config.json
~/.config/ccswap/state.json
~/.config/ccswap/runtime/
~/.config/ccswap/accounts/<name>/claude/
```
