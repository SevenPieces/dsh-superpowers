// Hardening tests for bin/dsh-superpowers.mjs — contract items H11a, H11b, H11c, I-A, I-B, B1-B4.
// I-A/I-B replaced H12 (the proxy-retry contract) when the plugin stopped owning any
// proxy surface: routing belongs to the invoking environment, never to this plugin.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { listSkillDirs } from '../bin/dsh-superpowers.mjs';
import * as binModule from '../bin/dsh-superpowers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'dsh-superpowers.mjs');
const VENDOR_DIR = join(HERE, '..', 'vendor', 'superpowers');
const VENDOR_SKILLS_DIR = join(VENDOR_DIR, 'skills');

/** Escape a literal string so it can be embedded in a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Facts about the mutable vendored checkout, read from git and the disk so the
 * assertions cannot rot when the vendor tag or skill set changes.
 */
function vendorFacts() {
  const described = spawnSync('git', ['-C', VENDOR_DIR, 'describe', '--tags'], { encoding: 'utf8' });
  assert.equal(described.status, 0, 'git describe in the vendor checkout: ' + described.stderr);
  const tag = described.stdout.trim();
  // Count independently of the CLI under test: a broken listSkillDirs must not
  // be able to agree with itself and hide a wrong status count.
  const onDisk = readdirSync(VENDOR_SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') &&
      existsSync(join(VENDOR_SKILLS_DIR, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(listSkillDirs(VENDOR_SKILLS_DIR), onDisk, 'listSkillDirs agrees with the on-disk skill dirs');
  return { tag, skillDirCount: onDisk.length };
}

/** Run the real CLI through node and capture stdout/stderr/status. */
function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

/** Run real git in a fixture with commit/tag signing pinned off (F1 pattern). */
function runGit(args, cwd) {
  return spawnSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
}

/** A vendor-ish directory that EXISTS, contains skills, but is not a git checkout. */
function makeNonGitVendorFixture() {
  const vendorDir = mkdtempSync(join(tmpdir(), 'dsh-bin-vendor-'));
  const skillsDir = join(vendorDir, 'skills');
  for (const name of ['alpha', 'beta']) {
    mkdirSync(join(skillsDir, name), { recursive: true });
    writeFileSync(
      join(skillsDir, name, 'SKILL.md'),
      '---' + String.fromCharCode(10) + 'name: ' + name + String.fromCharCode(10) +
        'description: ' + name + ' skill' + String.fromCharCode(10) + '---' + String.fromCharCode(10) + 'body' + String.fromCharCode(10),
    );
  }
  return vendorDir;
}

// ---------------------------------------------------------------------------
// H11a — listSkillDirs must skip dot-directories (match lib discoverSkills)
// ---------------------------------------------------------------------------

test('H11a listSkillDirs skips dot-directories', () => {
  const skillsDir = mkdtempSync(join(tmpdir(), 'dsh-bin-list-'));
  try {
    for (const name of ['alpha', 'beta']) {
      mkdirSync(join(skillsDir, name), { recursive: true });
      writeFileSync(
        join(skillsDir, name, 'SKILL.md'),
        '---' + String.fromCharCode(10) + 'name: ' + name + String.fromCharCode(10) +
          'description: ' + name + ' skill' + String.fromCharCode(10) + '---' + String.fromCharCode(10) + 'body' + String.fromCharCode(10),
      );
    }
    mkdirSync(join(skillsDir, '.hidden'), { recursive: true });
    writeFileSync(
      join(skillsDir, '.hidden', 'SKILL.md'),
      '---' + String.fromCharCode(10) + 'name: hidden' + String.fromCharCode(10) +
        'description: hidden skill' + String.fromCharCode(10) + '---' + String.fromCharCode(10) + 'body' + String.fromCharCode(10),
    );

    const names = listSkillDirs(skillsDir);

    assert.ok(names.includes('alpha') && names.includes('beta'), 'normal skill dirs are still listed: ' + JSON.stringify(names));
    assert.ok(!names.includes('.hidden'), 'dot-directories must be skipped: ' + JSON.stringify(names));
    assert.deepEqual(names.filter((name) => name.startsWith('.')), [], 'no dot-entry may be listed: ' + JSON.stringify(names));
  } finally {
    rmSync(skillsDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// H11b — status must distinguish "path exists" from "is a git checkout"
// ---------------------------------------------------------------------------

test('H11b status says exists: yes for an existing non-git directory that holds skills', () => {
  const vendorDir = makeNonGitVendorFixture();
  try {
    const result = runCli(['status', '--dir', vendorDir]);

    assert.equal(result.status, 0, 'status exits 0: stderr=' + result.stderr);
    assert.match(result.stdout, /^skill dirs: [1-9][0-9]*$/m, 'fixture skill dirs are counted: ' + result.stdout);
    const claimsAbsent = /^exists: no$/m.test(result.stdout);
    const nonZeroSkills = /^skill dirs: [1-9][0-9]*$/m.test(result.stdout);
    assert.ok(
      !(claimsAbsent && nonZeroSkills),
      'the misleading "exists: no" next to a non-zero skill dir count must be gone: ' + result.stdout,
    );
    assert.match(result.stdout, /^exists: yes$/m, 'exists: reports path existence, not git-ness: ' + result.stdout);
  } finally {
    rmSync(vendorDir, { recursive: true, force: true });
  }
});

test('H11b status prints a separate git: yes/no line for checkout vs plain directory', () => {
  const vendorDir = makeNonGitVendorFixture();
  try {
    const plain = runCli(['status', '--dir', vendorDir]);
    assert.equal(plain.status, 0, 'status exits 0: stderr=' + plain.stderr);
    assert.match(plain.stdout, /^git: no$/m, 'a plain directory is not a git checkout: ' + plain.stdout);

    const real = runCli(['status']);
    assert.equal(real.status, 0, 'status on the real vendor dir exits 0: stderr=' + real.stderr);
    assert.match(real.stdout, /^git: yes$/m, 'the real vendor dir is a git checkout: ' + real.stdout);
  } finally {
    rmSync(vendorDir, { recursive: true, force: true });
  }
});

test('H11b status keeps the exists:, tag:, and skill dirs: lines on the real vendor dir (I5)', () => {
  // Derived, not pinned: the vendor tag and skill set are mutable external data.
  const facts = vendorFacts();
  assert.match(facts.tag, /^v\d+\.\d+\.\d+/, 'the vendor checkout carries a version tag: ' + facts.tag);
  assert.ok(facts.skillDirCount > 0, 'the vendor checkout ships skill dirs');

  const result = runCli(['status']);

  assert.equal(result.status, 0, 'status exits 0: ' + result.stderr);
  assert.match(result.stdout, /^exists: yes$/m, 'real vendor dir exists: ' + result.stdout);
  assert.match(
    result.stdout,
    new RegExp('^tag: ' + escapeRegExp(facts.tag) + '$', 'm'),
    'the tag line must report the tag git describes, not a stale pin: ' + result.stdout,
  );
  const counted = /^skill dirs: (\d+)$/m.exec(result.stdout);
  assert.ok(counted, 'the skill dirs line is printed: ' + result.stdout);
  assert.equal(
    Number(counted[1]),
    facts.skillDirCount,
    'the skill dir count must match the vendor tree on disk: ' + result.stdout,
  );
});

// ---------------------------------------------------------------------------
// B1 — the count line is labelled "skill dirs:" so it cannot be read as the
//      catalogue size (which additionally requires a description)
// ---------------------------------------------------------------------------

test('B1 status prints "skill dirs: <n>" and never the old "skill count:" label', () => {
  const vendorDir = makeNonGitVendorFixture();
  try {
    const result = runCli(['status', '--dir', vendorDir]);

    assert.equal(result.status, 0, 'status exits 0: ' + result.stderr);
    assert.match(result.stdout, /^skill dirs: 2$/m, 'both fixture dirs are counted under the new label: ' + result.stdout);
    assert.doesNotMatch(result.stdout, /skill count/, 'the ambiguous old label is gone: ' + result.stdout);
  } finally {
    rmSync(vendorDir, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// B2 — an existing but unreadable skills directory is named on stderr (status stays 0)
// ---------------------------------------------------------------------------

test('B2 an unreadable skills directory is named on stderr while status still exits 0', () => {
  const vendorDir = mkdtempSync(join(tmpdir(), 'dsh-bin-unreadable-'));
  const skillsDir = join(vendorDir, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  chmodSync(skillsDir, 0o000);
  try {
    const result = runCli(['status', '--dir', vendorDir]);

    assert.equal(result.status, 0, 'status stays informational (exit 0): ' + result.stderr);
    assert.match(result.stdout, /^skill dirs: 0$/m, 'the count line is still printed: ' + result.stdout);
    assert.match(
      result.stderr,
      /^dsh-superpowers: skills directory unreadable at /m,
      'stderr names the unreadable skills directory: ' + result.stderr,
    );
    assert.ok(result.stderr.includes(skillsDir), 'the diagnostic names the exact directory: ' + result.stderr);
    assert.match(result.stderr, /EACCES|permission denied/i, 'the diagnostic carries the cause: ' + result.stderr);
  } finally {
    chmodSync(skillsDir, 0o755);
    rmSync(vendorDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B3 — a failed tag read is named on stderr, so it is distinguishable from a
//      repository that merely has no tags
// ---------------------------------------------------------------------------

test('B3 a failed git describe prints tag: n/a plus an stderr cause, unlike a tagless repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bin-describe-'));
  const broken = join(root, 'broken');
  const tagless = join(root, 'tagless');
  try {
    // (a) a directory holding an empty .git: isGitCheckout() says yes, describe fails.
    mkdirSync(join(broken, '.git'), { recursive: true });
    const failed = runCli(['status', '--dir', broken]);

    assert.equal(failed.status, 0, 'status stays informational (exit 0): ' + failed.stderr);
    assert.match(failed.stdout, /^git: yes$/m, 'a bare .git still reads as a checkout: ' + failed.stdout);
    assert.match(failed.stdout, /^tag: n\/a$/m, 'the n/a tag line is kept: ' + failed.stdout);
    assert.match(
      failed.stderr,
      /^dsh-superpowers: could not read the tag in /m,
      'stderr names the failed tag read: ' + failed.stderr,
    );
    assert.ok(failed.stderr.includes(broken), 'the diagnostic names the checkout: ' + failed.stderr);
    assert.match(failed.stderr, /not a git repository|fatal/i, 'the diagnostic carries the cause: ' + failed.stderr);

    // (b) a real repository with a commit but no tags: describe --always succeeds,
    // so the tag line differs and no diagnostic is printed.
    mkdirSync(tagless, { recursive: true });
    assert.equal(runGit(['init'], tagless).status, 0, 'tagless repository initialised');
    runGit(['config', 'user.email', 't@example.com'], tagless);
    runGit(['config', 'user.name', 't'], tagless);
    writeFileSync(join(tagless, 'f.txt'), 'a');
    runGit(['add', 'f.txt'], tagless);
    assert.equal(runGit(['commit', '-m', 'a'], tagless).status, 0, 'tagless repository has a commit');

    const quiet = runCli(['status', '--dir', tagless]);

    assert.equal(quiet.status, 0, 'status exits 0: ' + quiet.stderr);
    assert.match(quiet.stdout, /^tag: [0-9a-f]{7,}$/m, 'a tagless repository reports its commit, not n/a: ' + quiet.stdout);
    assert.doesNotMatch(quiet.stderr, /could not read the tag/, 'no diagnostic when describe succeeds: ' + quiet.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B4 — the tag-resolution failure names the directory instead of asserting a
//      cause ("no tags found") that it has not established
// ---------------------------------------------------------------------------

test('B4 the tag-resolution failure names the directory and does not claim "no tags found"', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bin-notagfail-'));
  try {
    const remote = join(root, 'remote');
    mkdirSync(remote);
    assert.equal(runGit(['init', '--bare', remote], root).status, 0, 'bare remote created');
    const work = join(root, 'work');
    assert.equal(runGit(['clone', remote, work], root).status, 0, 'work clone created');
    runGit(['config', 'user.email', 't@example.com'], work);
    runGit(['config', 'user.name', 't'], work);
    writeFileSync(join(work, 'f.txt'), 'a');
    runGit(['add', 'f.txt'], work);
    assert.equal(runGit(['commit', '-m', 'a'], work).status, 0, 'commit created');
    assert.equal(runGit(['push', 'origin', 'HEAD'], work).status, 0, 'commit pushed');
    const vendor = join(root, 'vendor');
    assert.equal(runGit(['clone', remote, vendor], root).status, 0, 'vendor clone created');

    const result = runCli(['update-skills', '--dir', vendor]);

    assert.equal(result.status, 1, 'a checkout with no tags fails: ' + result.stdout + result.stderr);
    assert.match(result.stderr, /could not resolve the newest tag from /, 'the message names the failed operation: ' + result.stderr);
    assert.ok(result.stderr.includes(vendor), 'the message names the directory: ' + result.stderr);
    assert.doesNotMatch(result.stderr, /no tags found/, 'it must not assert a cause it has not established: ' + result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// H11c — '-h'/'--help' anywhere in argv prints usage on stdout and exits 0
// ---------------------------------------------------------------------------

test("H11c 'status --help' prints usage on stdout and exits 0", () => {
  const result = runCli(['status', '--help']);

  assert.equal(result.status, 0, "'status --help' must exit 0: stderr=" + result.stderr);
  assert.match(result.stdout, /Usage:/, 'usage is printed on stdout: ' + result.stdout);
  assert.doesNotMatch(result.stderr, /Usage:/, 'usage must not be printed on stderr: ' + result.stderr);
});

test("H11c '--help' prints usage on stdout and exits 0", () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0, "'--help' must exit 0: stderr=" + result.stderr);
  assert.match(result.stdout, /Usage:/, 'usage is printed on stdout: ' + result.stdout);
  assert.doesNotMatch(result.stderr, /Usage:/, 'usage must not be printed on stderr: ' + result.stderr);
});

test('H11c malformed argv still exits 2 (I6)', () => {
  const cases = [
    { args: [], label: 'missing command' },
    { args: ['bogus'], label: 'unknown command' },
    { args: ['status', 'extra'], label: 'unexpected extra argument' },
    { args: ['--dir'], label: '--dir without a value' },
    { args: ['status', '--bogus'], label: 'unknown option' },
  ];

  for (const { args, label } of cases) {
    const result = runCli(args);
    assert.equal(
      result.status,
      2,
      label + ' ' + JSON.stringify(args) + ' must exit 2: stdout=' + result.stdout + ' stderr=' + result.stderr,
    );
  }
});

// ---------------------------------------------------------------------------
// I-A — the CLI owns no proxy surface at all
// ---------------------------------------------------------------------------

const MODULE_EXPORTS_READER =
  'import * as mod from ' + JSON.stringify(pathToFileURL(BIN).href) + ';' + String.fromCharCode(10) +
  'process.stdout.write(JSON.stringify(Object.keys(mod)));' + String.fromCharCode(10);

test('I-A the CLI exposes no proxy surface and reads no proxy variable', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', MODULE_EXPORTS_READER], {
    encoding: 'utf8',
    env: { ...process.env, DSH_SUPERPOWERS_PROXY: 'http://knob.invalid:2' },
  });
  assert.equal(child.status, 0, 'child could not import the bin: ' + child.stderr);

  const proxied = JSON.parse(child.stdout).filter((name) => /proxy/i.test(name));
  assert.deepEqual(proxied, [], 'the bin exports no proxy-shaped name');

  const mentions = readFileSync(BIN, 'utf8')
    .split(/\r?\n/)
    .map((line, index) => index + 1 + ': ' + line)
    .filter((line) => /proxy/i.test(line));
  assert.deepEqual(mentions, [], 'the bin source mentions no proxy');
});

// ---------------------------------------------------------------------------
// I-B — a failing git step runs exactly once, with the inherited environment
// ---------------------------------------------------------------------------

test('I-B a failing git step runs once with the inherited environment (no proxy retry)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-fakegit-'));
  try {
    const shimDir = join(root, 'shim');
    mkdirSync(shimDir);
    const logPath = join(root, 'git-calls.log');
    const shimPath = join(shimDir, 'git');
    // A fake git that records the subcommand and the proxy variables it received,
    // then fails every fetch so a second attempt would show up as a second line.
    writeFileSync(shimPath, [
      '#!/bin/sh',
      'printf "%s|%s|%s|%s\\n" "$1" "$HTTPS_PROXY" "$HTTP_PROXY" "$DSH_SUPERPOWERS_PROXY" >> "$GIT_SHIM_LOG"',
      '[ "$1" = "fetch" ] && exit 1',
      'exit 0',
      '',
    ].join(String.fromCharCode(10)));
    chmodSync(shimPath, 0o755);

    // An existing checkout, so updateSkills goes straight to fetch (no clone).
    const vendorDir = join(root, 'vendor');
    mkdirSync(join(vendorDir, '.git'), { recursive: true });

    const result = spawnSync(process.execPath, [BIN, 'update-skills', '--dir', vendorDir], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: shimDir + ':' + process.env.PATH,
        GIT_SHIM_LOG: logPath,
        HTTPS_PROXY: 'http://inherited.invalid:1',
        HTTP_PROXY: 'http://inherited.invalid:1',
        DSH_SUPERPOWERS_PROXY: 'http://knob.invalid:2',
      },
    });

    assert.equal(result.status, 1, 'a failed fetch exits 1: ' + result.stdout + result.stderr);

    const calls = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.split('|'));
    const fetches = calls.filter((parts) => parts[0] === 'fetch');
    assert.equal(fetches.length, 1, 'fetch is attempted exactly once: ' + JSON.stringify(calls));
    assert.deepEqual(
      [...new Set(fetches.map((parts) => parts[1]))],
      ['http://inherited.invalid:1'],
      'the git child inherits HTTPS_PROXY unchanged and never the knob value',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F — bin exports redactCredentials and masks URL userinfo in diagnostics
// ---------------------------------------------------------------------------

test('F redactCredentials masks URL userinfo in a diagnostic line', () => {
  // Namespace access keeps this file loadable while the export is still landing,
  // so only this test is red rather than every test in the file.
  const redactCredentials = binModule.redactCredentials;
  assert.equal(typeof redactCredentials, 'function', 'the bin exports redactCredentials');

  const line = 'fatal: unable to access https://user:secret@host.example/repo.git/: The requested URL returned error: 401';
  const redacted = redactCredentials(line);

  assert.equal(typeof redacted, 'string', 'redaction returns text');
  assert.ok(!redacted.includes('secret'), 'the password is never echoed: ' + redacted);
  assert.ok(redacted.includes('host.example'), 'the host stays diagnosable: ' + redacted);
  assert.ok(redacted.includes('401'), 'the rest of the diagnostic survives: ' + redacted);

  const plain = 'fatal: not a git repository (or any of the parent directories)';
  assert.equal(redactCredentials(plain), plain, 'a line without credentials is unchanged');
});

// ---------------------------------------------------------------------------
// R5-F1 — redactCredentials stays linear for text that cannot hold a credential
// ---------------------------------------------------------------------------

test('R5-F1: redactCredentials keeps its output for real userinfo and plain text', () => {
  const redactCredentials = binModule.redactCredentials;
  assert.equal(
    redactCredentials('fatal: https://user:secret@host.example/repo.git/: 401'),
    'fatal: https://***@host.example/repo.git/: 401',
    'real userinfo is still masked exactly',
  );
  assert.equal(
    redactCredentials('ssh://git@host.example/repo'),
    'ssh://***@host.example/repo',
    'ssh userinfo is still masked',
  );
  assert.equal(
    redactCredentials('fatal: not a git repository (or any of the parent directories)'),
    'fatal: not a git repository (or any of the parent directories)',
    'plain text is unchanged',
  );
});

test('R5-F1: redactCredentials returns 1 MiB credential-free text unchanged in under 1 s', () => {
  const LF = String.fromCharCode(10);
  const binUrl = pathToFileURL(BIN).href;
  const script = [
    'const { redactCredentials } = await import(' + JSON.stringify(binUrl) + ');',
    'const M = 1048576;',
    'const noScheme = "A".repeat(M);',
    'const schemeNoAt = "A".repeat(M - 3) + "://";',
    'const t1 = Date.now(); const out1 = redactCredentials(noScheme); const ms1 = Date.now() - t1;',
    'const t2 = Date.now(); const out2 = redactCredentials(schemeNoAt); const ms2 = Date.now() - t2;',
    'process.stdout.write(JSON.stringify({',
    '  noScheme: { length: out1.length, unchanged: out1 === noScheme, hasScheme: noScheme.includes("://"), hasAt: noScheme.includes("@"), ms: ms1 },',
    '  schemeNoAt: { length: out2.length, unchanged: out2 === schemeNoAt, hasScheme: schemeNoAt.includes("://"), hasAt: schemeNoAt.includes("@"), ms: ms2 },',
    '}));',
  ].join(LF);

  // Hard timeout: on the pre-fix implementation the regex is quadratic and this
  // probe would otherwise run for minutes.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 12000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(child.error?.code, undefined, 'the probe completes within the hard timeout: ' + (child.error?.message ?? ''));
  assert.equal(child.status, 0, 'the probe exits 0: ' + child.stderr);

  const result = JSON.parse(child.stdout);
  assert.deepEqual(
    {
      length: result.noScheme.length,
      unchanged: result.noScheme.unchanged,
      hasScheme: result.noScheme.hasScheme,
      hasAt: result.noScheme.hasAt,
    },
    { length: 1048576, unchanged: true, hasScheme: false, hasAt: false },
    'a 1 MiB string without "://" is returned unchanged',
  );
  assert.ok(result.noScheme.ms < 1000, 'the no-:// fast path stays under 1 s; ' + result.noScheme.ms + ' ms');
  assert.deepEqual(
    {
      length: result.schemeNoAt.length,
      unchanged: result.schemeNoAt.unchanged,
      hasScheme: result.schemeNoAt.hasScheme,
      hasAt: result.schemeNoAt.hasAt,
    },
    { length: 1048576, unchanged: true, hasScheme: true, hasAt: false },
    'a 1 MiB string with "://" but no "@" is returned unchanged',
  );
  assert.ok(result.schemeNoAt.ms < 1000, 'the no-@ fast path stays under 1 s; ' + result.schemeNoAt.ms + ' ms');
});

// ---------------------------------------------------------------------------
// R5-F1 (round 7) — linear redaction, semantically identical to the old regex
// ---------------------------------------------------------------------------

/** The pre-round-7 regex, kept only as a frozen oracle for small fixtures. */
function oldRedact(text) {
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/]+@/g, '$1***@');
}

test('R5-F1: redactCredentials matches the old URL_USERINFO regex on small fixtures', () => {
  const redactCredentials = binModule.redactCredentials;
  const fixtures = [
    'fatal: https://user:secret@host.example/repo.git/: 401',
    'clone https://user:pass@host/a and https://x:y@host/b failed',
    'https://user:p@ss@host/x',
    'https://user:p@ss@h/a https://v:w@x/y',
    'https://host.example/repo',
    'https://user:pass@host:8443/p',
    'http://u:p@h:1/a@b/c',
    'x.y+z://user:pw@host/p',
    'ssh://git@host.example/repo',
    'git@github.com:obra/superpowers.git',
    'mailto:user@example.com',
    'see https://host/p?x=a@b',
    '//user:pass@host/p',
    'a://@host',
    'plain text without any url',
    '',
  ];

  for (const fixture of fixtures) {
    assert.equal(
      redactCredentials(fixture),
      oldRedact(fixture),
      'redaction must equal the old oracle for ' + JSON.stringify(fixture),
    );
  }

  // Pin a few semantics explicitly, so the oracle is not the only check.
  assert.equal(redactCredentials('https://user:p@ss@host/x'), 'https://***@host/x', 'a password containing @ is masked whole');
  assert.equal(redactCredentials('//user:pass@host/p'), '//user:pass@host/p', 'a protocol-relative string has no scheme and is unchanged');
  assert.equal(redactCredentials('a://@host'), 'a://@host', 'an empty userinfo is not a match');
});

test('R5-F1: redactCredentials stays linear on MiB-scale credential-like, many-:// and credential-free text', () => {
  const LF = String.fromCharCode(10);
  const binUrl = pathToFileURL(BIN).href;
  const script = [
    'const { redactCredentials } = await import(' + JSON.stringify(binUrl) + ');',
    'const M = 1048576;',
    'const userinfo = "A://user:pass@" + "A".repeat(M);',
    'const manySchemes = "a://".repeat(Math.floor((M - 1) / 4)) + "@";',
    'const clean = "A".repeat(M);',
    'const t1 = Date.now(); const o1 = redactCredentials(userinfo); const ms1 = Date.now() - t1;',
    'const t2 = Date.now(); const o2 = redactCredentials(manySchemes); const ms2 = Date.now() - t2;',
    'const t3 = Date.now(); const o3 = redactCredentials(clean); const ms3 = Date.now() - t3;',
    'process.stdout.write(JSON.stringify({',
    '  userinfo: { ms: ms1, length: o1.length, masked: o1 !== userinfo && o1.includes("***@"), passwordGone: !o1.includes("user:pass"), exact: o1 === "A://***@" + "A".repeat(M) },',
    '  manySchemes: { ms: ms2, length: manySchemes.length, unchanged: o2 === manySchemes },',
    '  clean: { ms: ms3, length: o3.length, unchanged: o3 === clean },',
    '}));',
  ].join(LF);

  // Hard timeout: the pre-fix regex is quadratic on the credential-like case and
  // would otherwise stall the suite for minutes.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(child.error?.code, undefined, 'the heavy probe completes within the hard timeout: ' + (child.error?.message ?? ''));
  assert.equal(child.status, 0, 'the heavy probe exits 0: ' + child.stderr);

  const result = JSON.parse(child.stdout);
  // Fixture is the 'A://user:pass@' prefix plus a 1 MiB body; masking replaces
  // 'user:pass' (9 chars) with '***' (3), so output length is M + len('A://***@').
  assert.equal(
    result.userinfo.length,
    1048576 + 'A://***@'.length,
    'only the userinfo is replaced by ***@',
  );
  assert.equal(result.userinfo.masked, true, 'the credential-like fixture is masked');
  assert.equal(result.userinfo.passwordGone, true, 'the password never survives');
  assert.equal(result.userinfo.exact, true, 'the masked output matches the oracle exactly');
  assert.ok(result.userinfo.ms < 200, 'a 1 MiB credential-like line masks in <200 ms; ' + result.userinfo.ms + ' ms');

  assert.ok(
    result.manySchemes.length >= 1048576 - 8 && result.manySchemes.length <= 1048576,
    'the many-:// fixture is about 1 MiB; got ' + result.manySchemes.length,
  );
  assert.equal(result.manySchemes.unchanged, true, 'many "://" with one unrelated "@" has no userinfo to mask');
  assert.ok(result.manySchemes.ms < 500, 'the many-:// 1 MiB fixture completes in <500 ms; ' + result.manySchemes.ms + ' ms');

  assert.equal(result.clean.length, 1048576, 'the credential-free fixture is 1 MiB');
  assert.equal(result.clean.unchanged, true, 'credential-free text is returned unchanged');
  assert.ok(result.clean.ms < 100, 'credential-free 1 MiB completes in <100 ms; ' + result.clean.ms + ' ms');
});
