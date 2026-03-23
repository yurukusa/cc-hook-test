# cc-hook-test

Test runner for Claude Code hooks. Auto-detects hook type and generates test cases.

```bash
npx cc-hook-test ~/.claude/hooks/destructive-guard.sh
```

```
  cc-hook-test — destructive-guard.sh
  Detected type: PreToolUse

  PASS empty input passes
  PASS safe command passes
  PASS blocks rm -rf /
  PASS blocks rm -rf ~
  PASS allows rm -rf node_modules
  PASS blocks git reset --hard

  6/6 tests passed
```

## Usage

```bash
# Auto-test a hook (generates test cases based on script content)
npx cc-hook-test <hook-script>

# Test with custom test cases
npx cc-hook-test <hook-script> tests.json

# Generate a test template
npx cc-hook-test --generate destructive
npx cc-hook-test --generate branch
npx cc-hook-test --generate secret
npx cc-hook-test --generate custom
```

## Test File Format

```json
[
  {
    "name": "blocks rm -rf /",
    "input": { "tool_input": { "command": "rm -rf /" } },
    "expect_exit": 2,
    "expect_stderr": "BLOCKED"
  },
  {
    "name": "allows ls",
    "input": { "tool_input": { "command": "ls -la" } },
    "expect_exit": 0
  }
]
```

## What It Auto-Detects

| Hook Content | Detected Type | Generated Tests |
|---|---|---|
| `rm -rf`, `git reset --hard` | PreToolUse (destructive) | rm variants, git reset, git clean |
| `git push`, `main`, `master` | PreToolUse (branch) | push to main, force push, feature push |
| `.env`, `secret`, `credential` | PreToolUse (secret) | git add .env, git add src/ |
| `py_compile`, `file_path` | PostToolUse (syntax) | non-existent file |
| `stop_reason` | Stop | normal/user stop |

## Supports

- Bash hooks (`.sh`)
- Node.js hooks (`.js`)
- Python hooks (`.py`)

## Related

- [cc-safe-setup](https://github.com/yurukusa/cc-safe-setup) — install safety hooks with one command
- [COOKBOOK.md](https://github.com/yurukusa/claude-code-hooks/blob/main/COOKBOOK.md) — 19 hook recipes

## License

MIT
