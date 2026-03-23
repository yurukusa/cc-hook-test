#!/usr/bin/env node

/**
 * cc-hook-test — Test runner for Claude Code hooks
 *
 * Usage:
 *   npx cc-hook-test <hook-script>           Test a hook with auto-generated cases
 *   npx cc-hook-test <hook-script> <test.json>  Test with custom test cases
 *   npx cc-hook-test --generate <type>        Generate test template
 *
 * Auto-detects hook type (PreToolUse/PostToolUse/Stop) from script content
 * and generates appropriate test cases.
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { basename, resolve } from 'path';

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[36m',
};

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(`
  cc-hook-test — Test runner for Claude Code hooks

  Usage:
    npx cc-hook-test <hook-script>               Auto-test a hook
    npx cc-hook-test <hook-script> <tests.json>   Run custom tests
    npx cc-hook-test --generate <type>            Generate test template

  Types for --generate:
    destructive    Tests for destructive command blockers
    branch         Tests for branch/push protection
    secret         Tests for secret leak prevention
    syntax         Tests for syntax validators
    custom         Empty template for your own tests

  Test file format (JSON):
    [
      {
        "name": "blocks rm -rf /",
        "input": {"tool_input": {"command": "rm -rf /"}},
        "expect_exit": 2,
        "expect_stderr": "BLOCKED"
      }
    ]

  Exit codes:
    0 = hook allows (or no opinion)
    2 = hook blocks
`);
  process.exit(0);
}

if (args[0] === '--generate') {
  generateTemplate(args[1] || 'custom');
  process.exit(0);
}

const hookPath = resolve(args[0]);
const testFile = args[1] ? resolve(args[1]) : null;

if (!existsSync(hookPath)) {
  console.log(c.red + 'Error: Hook script not found: ' + hookPath + c.reset);
  process.exit(1);
}

const hookContent = readFileSync(hookPath, 'utf-8');
const hookName = basename(hookPath);

// Detect hook type
const hookType = detectHookType(hookContent);
console.log();
console.log(c.bold + '  cc-hook-test' + c.reset + c.dim + ' — ' + hookName + c.reset);
console.log(c.dim + '  Detected type: ' + hookType + c.reset);
console.log();

// Get test cases
let tests;
if (testFile) {
  if (!existsSync(testFile)) {
    console.log(c.red + 'Error: Test file not found: ' + testFile + c.reset);
    process.exit(1);
  }
  tests = JSON.parse(readFileSync(testFile, 'utf-8'));
} else {
  tests = generateTests(hookType, hookContent);
}

// Run tests
let pass = 0;
let fail = 0;

for (const test of tests) {
  const input = JSON.stringify(test.input || {});
  const result = runHook(hookPath, input, hookContent);

  const exitMatch = test.expect_exit === undefined || result.exitCode === test.expect_exit;
  const stderrMatch = !test.expect_stderr || result.stderr.includes(test.expect_stderr);
  const stdoutMatch = !test.expect_stdout || result.stdout.includes(test.expect_stdout);
  const noStderrMatch = !test.expect_no_stderr || !result.stderr.includes(test.expect_no_stderr);

  const passed = exitMatch && stderrMatch && stdoutMatch && noStderrMatch;

  if (passed) {
    console.log(c.green + '  PASS' + c.reset + ' ' + test.name);
    pass++;
  } else {
    console.log(c.red + '  FAIL' + c.reset + ' ' + test.name);
    if (!exitMatch) console.log(c.dim + '    expected exit ' + test.expect_exit + ', got ' + result.exitCode + c.reset);
    if (!stderrMatch) console.log(c.dim + '    expected stderr to contain "' + test.expect_stderr + '"' + c.reset);
    if (!stdoutMatch) console.log(c.dim + '    expected stdout to contain "' + test.expect_stdout + '"' + c.reset);
    if (!noStderrMatch) console.log(c.dim + '    expected stderr NOT to contain "' + test.expect_no_stderr + '"' + c.reset);
    if (result.stderr) console.log(c.dim + '    stderr: ' + result.stderr.slice(0, 200) + c.reset);
    fail++;
  }
}

console.log();
const total = pass + fail;
if (fail === 0) {
  console.log(c.bold + c.green + '  ' + pass + '/' + total + ' tests passed' + c.reset);
} else {
  console.log(c.bold + c.red + '  ' + fail + '/' + total + ' tests failed' + c.reset);
}
console.log();

process.exit(fail > 0 ? 1 : 0);

// ---

function detectHookType(content) {
  const lower = content.toLowerCase();
  if (lower.includes('pretooluse') || lower.includes('pre-tool-use') || lower.includes('pre_tool_use')) return 'PreToolUse';
  if (lower.includes('posttooluse') || lower.includes('post-tool-use') || lower.includes('post_tool_use')) return 'PostToolUse';
  if (lower.includes('stop_reason') || lower.includes('hook_event_name')) return 'Stop';
  if (lower.includes('userpromptsubmit') || lower.includes('.prompt')) return 'UserPromptSubmit';
  if (lower.includes('notification')) return 'Notification';

  // Heuristic: check what the hook inspects
  if (lower.includes('tool_input.command')) return 'PreToolUse';
  if (lower.includes('tool_input.file_path') && lower.includes('py_compile')) return 'PostToolUse';
  if (lower.includes('git add') || lower.includes('rm -rf') || lower.includes('git push')) return 'PreToolUse';

  return 'unknown';
}

function runHook(hookPath, input, content) {
  // Determine interpreter
  let cmd, args;
  if (hookPath.endsWith('.js')) {
    cmd = 'node';
    args = [hookPath];
  } else if (hookPath.endsWith('.py')) {
    cmd = 'python3';
    args = [hookPath];
  } else {
    cmd = 'bash';
    args = [hookPath];
  }

  const result = spawnSync(cmd, args, {
    input,
    timeout: 10000,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CC_ALLOW_DESTRUCTIVE: '0' },
  });

  return {
    exitCode: result.status ?? -1,
    stdout: (result.stdout || Buffer.alloc(0)).toString(),
    stderr: (result.stderr || Buffer.alloc(0)).toString(),
  };
}

function generateTests(hookType, content) {
  const lower = content.toLowerCase();
  const tests = [];

  // Always test empty input
  tests.push({
    name: 'empty input passes',
    input: {},
    expect_exit: 0,
  });

  if (hookType === 'PreToolUse') {
    // Test with non-matching input
    tests.push({
      name: 'safe command passes',
      input: { tool_input: { command: 'echo hello' } },
      expect_exit: 0,
    });

    // Destructive guard tests
    if (lower.includes('rm') && (lower.includes('rf') || lower.includes('destructive'))) {
      tests.push(
        { name: 'blocks rm -rf /', input: { tool_input: { command: 'rm -rf /' } }, expect_exit: 2 },
        { name: 'blocks rm -rf ~', input: { tool_input: { command: 'rm -rf ~' } }, expect_exit: 2 },
        { name: 'allows rm -rf node_modules', input: { tool_input: { command: 'rm -rf node_modules' } }, expect_exit: 0 },
        { name: 'allows rm single file', input: { tool_input: { command: 'rm file.txt' } }, expect_exit: 0 },
      );
    }

    if (lower.includes('reset') && lower.includes('hard')) {
      tests.push(
        { name: 'blocks git reset --hard', input: { tool_input: { command: 'git reset --hard' } }, expect_exit: 2 },
        { name: 'allows git reset --soft', input: { tool_input: { command: 'git reset --soft HEAD~1' } }, expect_exit: 0 },
      );
    }

    if (lower.includes('git clean')) {
      tests.push(
        { name: 'blocks git clean -fd', input: { tool_input: { command: 'git clean -fd' } }, expect_exit: 2 },
      );
    }

    // Branch guard tests
    if (lower.includes('push') && (lower.includes('main') || lower.includes('master') || lower.includes('branch'))) {
      tests.push(
        { name: 'blocks push to main', input: { tool_input: { command: 'git push origin main' } }, expect_exit: 2 },
        { name: 'allows push to feature branch', input: { tool_input: { command: 'git push origin feature-branch' } }, expect_exit: 0 },
      );
    }

    if (lower.includes('force') && lower.includes('push')) {
      tests.push(
        { name: 'blocks force push', input: { tool_input: { command: 'git push --force origin feature' } }, expect_exit: 2 },
      );
    }

    // Secret guard tests
    if (lower.includes('.env') || lower.includes('secret') || lower.includes('credential')) {
      tests.push(
        { name: 'blocks git add .env', input: { tool_input: { command: 'git add .env' } }, expect_exit: 2 },
        { name: 'allows git add src/', input: { tool_input: { command: 'git add src/' } }, expect_exit: 0 },
      );
    }

    // PowerShell destructive
    if (lower.includes('remove-item')) {
      tests.push(
        { name: 'blocks Remove-Item -Recurse -Force', input: { tool_input: { command: 'Remove-Item -Recurse -Force C:\\Users' } }, expect_exit: 2 },
      );
    }
  }

  if (hookType === 'PostToolUse') {
    tests.push({
      name: 'non-existent file passes',
      input: { tool_input: { file_path: '/tmp/nonexistent-test-file-12345.xyz' } },
      expect_exit: 0,
    });
  }

  if (hookType === 'Stop') {
    tests.push(
      { name: 'normal stop passes', input: { stop_reason: 'user' }, expect_exit: 0 },
      { name: 'normal exit passes', input: { stop_reason: 'normal' }, expect_exit: 0 },
    );
  }

  if (tests.length <= 1) {
    tests.push({
      name: 'basic input passes',
      input: { tool_input: { command: 'ls -la' } },
      expect_exit: 0,
    });
  }

  return tests;
}

function generateTemplate(type) {
  const templates = {
    destructive: [
      { name: 'blocks rm -rf /', input: { tool_input: { command: 'rm -rf /' } }, expect_exit: 2, expect_stderr: 'BLOCKED' },
      { name: 'blocks rm -rf ~', input: { tool_input: { command: 'rm -rf ~' } }, expect_exit: 2 },
      { name: 'allows rm -rf node_modules', input: { tool_input: { command: 'rm -rf node_modules' } }, expect_exit: 0 },
      { name: 'blocks git reset --hard', input: { tool_input: { command: 'git reset --hard' } }, expect_exit: 2 },
      { name: 'blocks git clean -fd', input: { tool_input: { command: 'git clean -fd' } }, expect_exit: 2 },
      { name: 'allows git status', input: { tool_input: { command: 'git status' } }, expect_exit: 0 },
    ],
    branch: [
      { name: 'blocks push to main', input: { tool_input: { command: 'git push origin main' } }, expect_exit: 2 },
      { name: 'blocks force push', input: { tool_input: { command: 'git push --force origin feature' } }, expect_exit: 2 },
      { name: 'allows feature push', input: { tool_input: { command: 'git push origin feature-branch' } }, expect_exit: 0 },
      { name: 'allows push -u', input: { tool_input: { command: 'git push -u origin feature' } }, expect_exit: 0 },
    ],
    secret: [
      { name: 'blocks git add .env', input: { tool_input: { command: 'git add .env' } }, expect_exit: 2 },
      { name: 'blocks git add .env.local', input: { tool_input: { command: 'git add .env.local' } }, expect_exit: 2 },
      { name: 'blocks git add credentials.json', input: { tool_input: { command: 'git add credentials.json' } }, expect_exit: 2 },
      { name: 'allows git add src/app.js', input: { tool_input: { command: 'git add src/app.js' } }, expect_exit: 0 },
    ],
    syntax: [
      { name: 'non-existent file passes', input: { tool_input: { file_path: '/tmp/nonexistent.py' } }, expect_exit: 0 },
    ],
    custom: [
      { name: 'example: should pass', input: { tool_input: { command: 'echo safe' } }, expect_exit: 0 },
      { name: 'example: should block', input: { tool_input: { command: 'dangerous-command' } }, expect_exit: 2, expect_stderr: 'BLOCKED' },
    ],
  };

  const tpl = templates[type] || templates.custom;
  const outFile = 'hook-tests-' + type + '.json';
  writeFileSync(outFile, JSON.stringify(tpl, null, 2));
  console.log(c.green + '  Generated: ' + outFile + c.reset);
  console.log(c.dim + '  Run: npx cc-hook-test <your-hook.sh> ' + outFile + c.reset);
}
