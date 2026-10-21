import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { inject, discoverSkills, apply, PLUGIN_DIR, resolveConfig } from '../lib/index.js';
import { updateSkills } from '../bin/dsh-superpowers.mjs';

const LF = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);
const ESCAPED_BIDI = BACKSLASH + 'u{202e}';
const ESCAPED_LINE_SEP = BACKSLASH + 'u{2028}';
// Raw ESC, bidi formatting controls and line/paragraph separators: none of
// these may reach a terminal line unescaped.
const RAW_MARKS = new RegExp(
  '[' + String.fromCharCode(0x001b, 0x2028, 0x2029) +
  String.fromCharCode(0x202a) + '-' + String.fromCharCode(0x202e) +
  String.fromCharCode(0x2066) + '-' + String.fromCharCode(0x2069) + ']',
);

/** Real git with commit/tag signing pinned off (F1 pattern). */
function runGit(args, cwd) {
  return spawnSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
}

/** Apply env overrides for the duration of fn, restoring every key afterwards. */
function withPatchedEnv(patch, fn) {
  const previous = {};
  for (const key of Object.keys(patch)) previous[key] = process.env[key];
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

/** A fake 'git' that records every invocation and fails, to prove no clone ran. */
function makeRecordingGitShim(root) {
  const shimDir = join(root, 'shim');
  mkdirSync(shimDir);
  const logPath = join(root, 'git-calls.log');
  const shimPath = join(shimDir, 'git');
  writeFileSync(
    shimPath,
    '#!/bin/sh' + LF + 'echo "$@" >> "$GIT_SHIM_LOG"' + LF + 'exit 1' + LF,
  );
  chmodSync(shimPath, 0o755);
  return { shimDir, logPath };
}

/**
 * Build a local bare remote whose newest version-sorted tag is v2.0.0
 * (commit order and tag order are deliberately different).
 * @returns {{ remote: string, url: string }} the bare repo path and its file: URL.
 */
function makeTaggedBareRemote(root) {
  const remote = join(root, 'remote');
  mkdirSync(remote);
  assert.equal(runGit(['init', '--bare', remote]).status, 0, 'bare remote created');
  const work = join(root, 'work');
  assert.equal(runGit(['clone', remote, work]).status, 0, 'work clone created');
  runGit(['config', 'user.email', 't@example.com'], work);
  runGit(['config', 'user.name', 't'], work);
  const commit = (content) => {
    writeFileSync(join(work, 'f.txt'), content);
    runGit(['add', 'f.txt'], work);
    assert.equal(runGit(['commit', '-m', content], work).status, 0, 'commit ' + content + ' created');
  };
  commit('a');
  assert.equal(runGit(['tag', 'v1.0.0'], work).status, 0, 'v1.0.0 tagged');
  commit('b');
  assert.equal(runGit(['tag', 'v2.0.0'], work).status, 0, 'v2.0.0 tagged');
  assert.equal(runGit(['push', '--tags', 'origin', 'HEAD'], work).status, 0, 'tags pushed');
  return { remote, url: pathToFileURL(remote).href };
}

/**
 * A local bare remote carrying exactly one tag, however exotic or option-like
 * the legal refname is. update-ref writes any legal refname, so '-x' works.
 * @param {string} root - scratch directory.
 * @param {string} tag - the single tag name.
 * @returns {{ remote: string, url: string, work: string }} remote path, file: URL and work tree.
 */
function makeBareRemoteWithTag(root, tag) {
  const remote = join(root, 'remote');
  mkdirSync(remote);
  assert.equal(runGit(['init', '--bare', remote]).status, 0, 'bare remote created');
  const work = join(root, 'work');
  assert.equal(runGit(['clone', remote, work]).status, 0, 'work clone created');
  runGit(['config', 'user.email', 't@example.com'], work);
  runGit(['config', 'user.name', 't'], work);
  writeFileSync(join(work, 'f.txt'), 'a');
  runGit(['add', 'f.txt'], work);
  assert.equal(runGit(['commit', '-m', 'a'], work).status, 0, 'commit created');
  assert.equal(runGit(['push', 'origin', 'HEAD'], work).status, 0, 'branch pushed');
  assert.equal(runGit(['update-ref', 'refs/tags/' + tag, 'HEAD'], work).status, 0, 'tag created');
  assert.equal(runGit(['push', 'origin', 'refs/tags/' + tag], work).status, 0, 'tag pushed');
  return { remote, url: pathToFileURL(remote).href, work };
}

function makeCtx() {
  const sections = new Map();
  const warns = [];
  const ctx = {
    logger: { warn: (m) => warns.push(m), info: () => {} },
    skills: { registerProvider: () => {} },
    systemPrompt: { section: (section) => { sections.set(section.name, section); return () => {}; } },
    effect: (fn) => { const disposer = fn(); return () => { if (disposer) disposer(); }; },
  };
  return { ctx, sections, warns };
}

test('F2: the bootstrap is an assembly-time system-prompt section, not a session-start injection', () => {
  assert.deepEqual(inject, ['skills', 'systemPrompt']);
  assert.ok(Number.isFinite(resolveConfig({}, PLUGIN_DIR).sectionOrder), 'sectionOrder is live config');
});

test('discoverSkills candidates carry resourceBase pointing at the skill dir (D3 regression)', () => {
  const cfg = resolveConfig({}, PLUGIN_DIR);
  const list = discoverSkills(cfg.skillsDir, 'superpowers', 600);
  assert.ok(list.length >= 1, 'skills discovered');
  for (const candidate of list) {
    assert.deepEqual(candidate.resourceBase, { kind: 'directory', path: candidate.locator });
  }
});

test('F2: the section provider re-reads the bootstrap sources at each assembly', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-f2-'));
  try {
    const skillsDir = join(root, 'skills');
    const skillDir = join(skillsDir, 'using-superpowers');
    mkdirSync(skillDir, { recursive: true });
    const mapping = join(root, 'dsh-tools.md');
    writeFileSync(mapping, 'MAPPING-ONE');
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, '---' + LF + 'name: using-superpowers' + LF + 'description: x' + LF + '---' + LF + 'BODY-ONE');
    const { ctx, sections } = makeCtx();
    apply(ctx, { skillsDir, toolMappingPath: mapping });
    const section = Array.from(sections.values())[0];
    assert.ok(section, 'bootstrap section registered');
    assert.equal(typeof section.text, 'function', 'text is an assembly-time provider');
    const first = section.text({});
    assert.ok(first.includes('BODY-ONE'));
    assert.ok(first.includes('MAPPING-ONE'));
    writeFileSync(skillPath, '---' + LF + 'name: using-superpowers' + LF + 'description: x' + LF + '---' + LF + 'BODY-TWO');
    writeFileSync(mapping, 'MAPPING-TWO');
    const second = section.text({});
    assert.ok(second.includes('BODY-TWO'));
    assert.ok(second.includes('MAPPING-TWO'));
    assert.ok(!second.includes('BODY-ONE'), 'second assembly uses refreshed text');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap provider is fail-open: empty text and one warning when the vendor tree is missing', () => {
  const { ctx, sections, warns } = makeCtx();
  apply(ctx, { skillsDir: join(tmpdir(), 'dsh-sp-missing-' + Date.now()), toolMappingPath: join(tmpdir(), 'missing-tools.md') });
  const section = Array.from(sections.values())[0];
  assert.ok(section, 'section still registered when the vendor tree is absent');
  assert.equal(section.text({}), '');
  assert.equal(section.text({}), '');
  assert.equal(section.text({}), '');
  assert.equal(warns.filter((m) => m.includes('no bootstrap')).length, 1, 'missing-vendor warning is deduplicated');
});

test('F1: updateSkills picks the highest semver tag, not the newest commit date', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-f1-'));
  // Signing is pinned off: an ambient commit.gpgsign/tag.gpgsign would otherwise make
  // commit and tag fail in a non-interactive test process (no editor, no pinentry).
  const git = (args, cwd, env) => spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  try {
    const remote = join(root, 'remote');
    mkdirSync(remote);
    assert.equal(git(['init', '--bare', remote]).status, 0);
    const work = join(root, 'work');
    assert.equal(git(['clone', remote, work]).status, 0);
    git(['config', 'user.email', 't@example.com'], work);
    git(['config', 'user.name', 't'], work);
    writeFileSync(join(work, 'f.txt'), 'a');
    git(['add', 'f.txt'], work);
    assert.equal(git(['commit', '-m', 'a'], work, { GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' }).status, 0);
    git(['tag', 'v2.0.0'], work);
    writeFileSync(join(work, 'f.txt'), 'b');
    git(['add', 'f.txt'], work);
    assert.equal(git(['commit', '-m', 'b'], work, { GIT_AUTHOR_DATE: '2021-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2021-01-01T00:00:00Z' }).status, 0);
    git(['tag', 'v0.9.0'], work);
    git(['push', '--tags', 'origin', 'HEAD'], work);
    const vendor = join(root, 'vendor');
    assert.equal(git(['clone', remote, vendor]).status, 0);
    assert.equal(updateSkills(vendor), 0);
    const described = git(['describe', '--tags'], vendor).stdout.trim();
    assert.equal(described, 'v2.0.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bin runs through the installed-style symlink (D2 regression)', () => {
  // Derived, not pinned: the vendor tag and skill set are mutable external data.
  const vendorDir = join(PLUGIN_DIR, 'vendor', 'superpowers');
  const described = spawnSync('git', ['-C', vendorDir, 'describe', '--tags'], { encoding: 'utf8' });
  assert.equal(described.status, 0, 'git describe in the vendor checkout: ' + described.stderr);
  const expectedTag = described.stdout.trim();
  assert.match(expectedTag, /^v\d+\.\d+\.\d+/, 'the vendor checkout carries a version tag: ' + expectedTag);
  // Count on disk, independently of the CLI under test, so a broken
  // listSkillDirs cannot agree with itself and hide a wrong status count.
  const skillsDir = join(vendorDir, 'skills');
  const expectedSkillDirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') &&
      existsSync(join(skillsDir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort().length;
  assert.ok(expectedSkillDirs > 0, 'the vendor checkout ships skill dirs');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-sp-bin-'));
  try {
    const real = join(PLUGIN_DIR, 'bin', 'dsh-superpowers.mjs');
    const link = join(dir, 'dsh-superpowers.mjs');
    symlinkSync(real, link);
    const viaLink = spawnSync(process.execPath, [link, 'status'], { encoding: 'utf8' });
    assert.equal(viaLink.status, 0, 'symlinked bin exits 0: ' + viaLink.stderr);
    assert.ok(viaLink.stdout.includes('tag: ' + expectedTag), 'the tag line reports git describe: ' + viaLink.stdout);
    assert.ok(viaLink.stdout.includes('skill dirs: ' + expectedSkillDirs), 'the count matches the vendor tree: ' + viaLink.stdout);
    const direct = spawnSync(process.execPath, [real, 'status'], { encoding: 'utf8' });
    assert.equal(direct.status, 0);
    assert.ok(direct.stdout.includes('skill dirs: ' + expectedSkillDirs), 'direct run counts the same: ' + direct.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap provider self-heals once the vendor tree appears', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-heal-'));
  try {
    const skillsDir = join(root, 'skills');
    const mapping = join(root, 'dsh-tools.md');
    const { ctx, sections, warns } = makeCtx();
    apply(ctx, { skillsDir, toolMappingPath: mapping });
    const section = Array.from(sections.values())[0];
    assert.equal(section.text({}), '');
    assert.ok(warns.some((m) => m.includes('no bootstrap')), 'missing vendor logged');
    mkdirSync(join(skillsDir, 'using-superpowers'), { recursive: true });
    writeFileSync(join(skillsDir, 'using-superpowers', 'SKILL.md'), '---' + LF + 'name: using-superpowers' + LF + '---' + LF + 'HEALED-BODY');
    writeFileSync(mapping, 'HEALED-MAPPING');
    const healed = section.text({});
    assert.ok(healed.includes('HEALED-BODY'));
    assert.ok(healed.includes('HEALED-MAPPING'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// F5 was decided as "keep the behaviour, correct the comments": selection is
// version-sorted (git tag --sort=-v:refname), so a prerelease outranks an older
// release ON PURPOSE today. This test pins that behaviour so a future change to
// it is a loud, deliberate one.
test('F5 (behaviour kept by decision) updateSkills resolves the highest version-sorted tag including the prerelease v2.0.0-rc1', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-f5-'));
  // Signing is pinned off: an ambient commit.gpgsign/tag.gpgsign would otherwise make
  // commit and tag fail in a non-interactive test process (no editor, no pinentry).
  const git = (args, cwd, env) => spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  try {
    const remote = join(root, 'remote');
    mkdirSync(remote);
    assert.equal(git(['init', '--bare', remote]).status, 0);
    const work = join(root, 'work');
    assert.equal(git(['clone', remote, work]).status, 0);
    git(['config', 'user.email', 't@example.com'], work);
    git(['config', 'user.name', 't'], work);
    const commit = (content, iso) => {
      writeFileSync(join(work, 'f.txt'), content);
      git(['add', 'f.txt'], work);
      assert.equal(
        git(['commit', '-m', content], work, { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso }).status,
        0,
      );
    };
    commit('a', '2020-01-01T00:00:00Z');
    git(['tag', 'v1.0.0'], work);
    commit('b', '2021-01-01T00:00:00Z');
    git(['tag', 'v1.2.0'], work);
    commit('c', '2022-01-01T00:00:00Z');
    git(['tag', 'v2.0.0-rc1'], work);
    git(['push', '--tags', 'origin', 'HEAD'], work);
    const vendor = join(root, 'vendor');
    assert.equal(git(['clone', remote, vendor]).status, 0);

    // No network and never the real vendor tree: the clone's origin is the scratch bare repo.
    assert.equal(updateSkills(vendor), 0);
    assert.equal(
      git(['describe', '--tags'], vendor).stdout.trim(),
      'v2.0.0-rc1',
      'the prerelease outranks v1.2.0 by version sort, and that is the kept behaviour',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// F2 is the first-run clone branch: it must be exercised without network,
// through an injected file: URL, and it must fail closed on bad input.

test('F2: updateSkills(vendorDir, repoUrl) clones a fresh directory from the injected URL and checks out the newest version-sorted tag', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-clone-'));
  // Hermetic: only the file: transport is allowed, so a clone that ignored the
  // injected repoUrl could never reach the default GitHub URL.
  const previousProtocol = process.env.GIT_ALLOW_PROTOCOL;
  process.env.GIT_ALLOW_PROTOCOL = 'file';
  try {
    const { url } = makeTaggedBareRemote(root);
    const vendor = join(root, 'fresh', 'nested', 'vendor');
    assert.equal(existsSync(vendor), false, 'the target directory is missing before the first run');

    assert.equal(updateSkills(vendor, url), 0);

    assert.ok(existsSync(join(vendor, '.git')), 'the first run creates a git checkout');
    assert.equal(runGit(['describe', '--tags'], vendor).stdout.trim(), 'v2.0.0', 'the newest version-sorted tag is checked out');
    assert.equal(
      runGit(['rev-parse', 'HEAD'], vendor).stdout.trim(),
      runGit(['rev-parse', 'v2.0.0'], vendor).stdout.trim(),
      'HEAD is exactly the tagged commit, not just the branch tip',
    );
    assert.equal(
      runGit(['config', '--get', 'remote.origin.url'], vendor).stdout.trim(),
      url,
      'the checkout came from the injected repoUrl and not the default remote',
    );
  } finally {
    if (previousProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = previousProtocol;
    rmSync(root, { recursive: true, force: true });
  }
});

test('F2: updateSkills names the failed clone when the injected repoUrl cannot be cloned', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-clonefail-'));
  const previousProtocol = process.env.GIT_ALLOW_PROTOCOL;
  process.env.GIT_ALLOW_PROTOCOL = 'file';
  try {
    const badUrl = pathToFileURL(join(root, 'missing-remote', 'repo.git')).href;
    const vendor = join(root, 'vendor');

    assert.throws(
      () => updateSkills(vendor, badUrl),
      (error) => {
        assert.ok(error instanceof Error, 'a clone failure throws an Error');
        assert.match(error.message, /git clone failed/, 'the failure names the git clone step: ' + error.message);
        assert.ok(
          error.message.includes(badUrl),
          'the failure names the URL it tried, proving the injected repoUrl was used: ' + error.message,
        );
        return true;
      },
      'a bad file: URL must fail the clone step',
    );
  } finally {
    if (previousProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = previousProtocol;
    rmSync(root, { recursive: true, force: true });
  }
});

test('F2: updateSkills refuses an existing non-git vendor directory before cloning', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-nongit-'));
  try {
    const vendor = join(root, 'vendor');
    mkdirSync(vendor);
    writeFileSync(join(vendor, 'keep.txt'), 'do not overwrite');

    assert.throws(
      () => updateSkills(vendor, pathToFileURL(join(root, 'remote')).href),
      (error) => {
        assert.match(
          error.message,
          /vendor directory exists but is not a git checkout/,
          'the refusal is explicit: ' + error.message,
        );
        assert.ok(error.message.includes(vendor), 'the refusal names the directory: ' + error.message);
        return true;
      },
      'an existing non-git directory must be refused, never cloned over',
    );
    assert.equal(existsSync(join(vendor, '.git')), false, 'no git checkout is created');
    assert.equal(readFileSync(join(vendor, 'keep.txt'), 'utf8'), 'do not overwrite', 'the directory is left intact');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// R2 (round 2): an option-like repoUrl must be rejected before any git step.
// A recording shim proves no clone was even attempted.

test('R2: updateSkills rejects an option-like repoUrl before any clone', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-repourl-'));
  try {
    const { shimDir, logPath } = makeRecordingGitShim(root);
    const vendor = join(root, 'vendor');

    withPatchedEnv({ PATH: shimDir + ':' + process.env.PATH, GIT_SHIM_LOG: logPath }, () => {
      assert.throws(
        () => updateSkills(vendor, '--bogus-option'),
        (error) => {
          assert.ok(error instanceof Error, 'an option-like repoUrl is rejected');
          assert.match(error.message, /repoUrl/i, 'the error names the repoUrl parameter: ' + error.message);
          assert.doesNotMatch(
            error.message,
            /git clone failed|fetch --tags/i,
            'it is a validation error, not a clone failure: ' + error.message,
          );
          return true;
        },
      );
    });

    assert.equal(existsSync(logPath), false, 'no git process was started');
    assert.equal(existsSync(vendor), false, 'no vendor directory was created');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R2: updateSkills rejects a leading-whitespace option-like repoUrl before any clone', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-repourl-ws-'));
  try {
    const { shimDir, logPath } = makeRecordingGitShim(root);
    const vendor = join(root, 'vendor');

    withPatchedEnv({ PATH: shimDir + ':' + process.env.PATH, GIT_SHIM_LOG: logPath }, () => {
      assert.throws(
        () => updateSkills(vendor, '   --bogus-option'),
        (error) => {
          assert.ok(error instanceof Error, 'a whitespace-prefixed option-like repoUrl is rejected after trim');
          assert.match(error.message, /repoUrl/i, 'the error names the repoUrl parameter: ' + error.message);
          assert.doesNotMatch(
            error.message,
            /git clone failed|fetch --tags/i,
            'it is a validation error, not a clone failure: ' + error.message,
          );
          return true;
        },
      );
    });

    assert.equal(existsSync(logPath), false, 'no git process was started');
    assert.equal(existsSync(vendor), false, 'no vendor directory was created');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// V7-F2 (round 2): every git step is timeout-bounded and the timeout is reported.

test('V7-F2: DSH_SUPERPOWERS_GIT_TIMEOUT_MS bounds a hung git step and leaves no checkout', { skip: process.platform === 'win32' }, () => {
  // Neutral temp prefix: the word "timeout" must come from the implementation's
  // diagnostic, never from the scratch path the message happens to contain.
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-git-bound-'));
  try {
    // A valid file: remote, so only the shim's hang can fail the first step.
    const remote = join(root, 'remote');
    mkdirSync(remote);
    assert.equal(runGit(['init', '--bare', remote]).status, 0, 'bare remote created');
    const url = pathToFileURL(remote).href;

    const shimDir = join(root, 'shim');
    mkdirSync(shimDir);
    const shimPath = join(shimDir, 'git');
    writeFileSync(shimPath, '#!/bin/sh' + LF + 'exec sleep 2' + LF);
    chmodSync(shimPath, 0o755);

    const vendor = join(root, 'fresh', 'vendor');
    let elapsed = 0;
    withPatchedEnv(
      { PATH: shimDir + ':' + process.env.PATH, DSH_SUPERPOWERS_GIT_TIMEOUT_MS: '100' },
      () => {
        const started = Date.now();
        assert.throws(
          () => updateSkills(vendor, url),
          (error) => {
            assert.ok(error instanceof Error, 'a timed-out step throws an Error');
            assert.match(
              error.message,
              /timed out|timeout|timed-out/i,
              'the failure names the timeout: ' + error.message,
            );
            return true;
          },
        );
        elapsed = Date.now() - started;
      },
    );

    assert.ok(elapsed < 5000, 'the hung git step is bounded; elapsed ' + elapsed + 'ms');
    assert.equal(existsSync(join(vendor, '.git')), false, 'no checkout is left behind');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// NEW-1 (round 3): vendor-controlled ref text in git output and diagnostics must
// be escaped; normal multi-line output must survive.

test('NEW-1: updateSkills escapes a bidi/line-separator tag in its child-process output', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-gitout-'));
  try {
    const tag = 'v1.0.0' + String.fromCharCode(0x202e) + 'x' + String.fromCharCode(0x2028) + 'y';
    const { url } = makeBareRemoteWithTag(root, tag);
    const vendor = join(root, 'fresh', 'vendor');
    const binUrl = pathToFileURL(join(PLUGIN_DIR, 'bin', 'dsh-superpowers.mjs')).href;
    const script = [
      'import { updateSkills } from ' + JSON.stringify(binUrl) + ';',
      'process.exitCode = updateSkills(process.env.VENDOR_DIR, process.env.REMOTE_URL);',
    ].join(LF);

    // A child process has the real terminal streams: nothing can be swallowed by
    // the in-process console object.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, VENDOR_DIR: vendor, REMOTE_URL: url },
    });

    assert.equal(child.status, 0, 'the child succeeds: ' + child.stdout + child.stderr);
    const combined = child.stdout + child.stderr;

    // Raw bidi / line separators / ESC must never reach the terminal.
    assert.doesNotMatch(combined, RAW_MARKS, 'raw control marks leaked to the output: ' + JSON.stringify(combined));

    // Normal output stays multi-line: escaping must not flatten the log.
    const normalLines = child.stdout.split(LF).filter((line) => line !== '');
    assert.ok(normalLines.length >= 2, 'stdout stays multi-line: ' + JSON.stringify(child.stdout));
    assert.ok(child.stdout.includes('Resolved superpowers tag:'), 'the resolved-tag line survives: ' + child.stdout);
    assert.ok(child.stdout.includes('Commit:'), 'the commit line survives: ' + child.stdout);

    // Captured git output is still printed (escaped), not dropped.
    assert.ok(
      combined.includes('HEAD is now at') || combined.includes('detached HEAD'),
      'captured git output is still printed: ' + JSON.stringify(combined),
    );

    // Escaped forms are present.
    assert.ok(combined.includes(ESCAPED_BIDI), 'the bidi override is escaped in output: ' + JSON.stringify(combined));
    assert.ok(combined.includes(ESCAPED_LINE_SEP), 'the line separator is escaped in output: ' + JSON.stringify(combined));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// NEW-4 (round 3): a tag named like an option must be checked out through
// refs/tags, never parsed as a git option.

test('NEW-4: updateSkills checks out a legal tag named "-x" via refs/tags without an option error', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-tagopt-'));
  try {
    const { url, work } = makeBareRemoteWithTag(root, '-x');
    assert.equal(runGit(['tag'], work).stdout.trim(), '-x', 'the remote carries exactly the option-like tag');

    const vendor = join(root, 'fresh', 'vendor');
    assert.equal(updateSkills(vendor, url), 0);

    assert.ok(existsSync(join(vendor, '.git')), 'a checkout exists');
    assert.equal(runGit(['describe', '--tags'], vendor).stdout.trim(), '-x', 'the option-like tag is checked out');
    assert.equal(
      runGit(['rev-parse', 'HEAD'], vendor).stdout.trim(),
      runGit(['rev-parse', 'refs/tags/-x'], vendor).stdout.trim(),
      'HEAD is exactly the tagged commit',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// R3-F1 (round 4): a legal tag ending in a Unicode space-like character must not
// be JS-trimmed away - the exact ref must resolve, and status must show it.

/** Strip only trailing CR/LF, never Unicode whitespace (legal tags can end in it). */
function stripTrailingNewlines(text) {
  return String(text ?? '').replace(/[\r\n]+$/, '');
}

const TRAILING_SPACE_TAGS = [
  ['U+FEFF', String.fromCharCode(0xfeff), 'feff'],
  ['U+00A0', String.fromCharCode(0x00a0), '00a0'],
];

test('R3-F1: updateSkills resolves and checks out tags ending in U+FEFF and U+00A0', () => {
  for (const [label, suffix] of TRAILING_SPACE_TAGS) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sp-tagspace-'));
    try {
      const tag = 'v1.0.0' + suffix;
      const { url } = makeBareRemoteWithTag(root, tag);
      const vendor = join(root, 'fresh', 'vendor');

      assert.equal(updateSkills(vendor, url), 0, label + ': the exact tag resolves');
      const describe = stripTrailingNewlines(runGit(['describe', '--tags'], vendor).stdout);
      assert.equal(describe, tag, label + ': the exact tag is checked out, trailing character intact');
      assert.ok(describe.endsWith(suffix), label + ': the trailing character survives checkout');
      assert.equal(
        runGit(['rev-parse', 'HEAD'], vendor).stdout.trim(),
        runGit(['rev-parse', 'refs/tags/' + tag], vendor).stdout.trim(),
        label + ': HEAD is exactly the tagged commit',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('R3-F1: status reports tags ending in U+FEFF and U+00A0 untrimmed', () => {
  for (const [label, suffix, hex] of TRAILING_SPACE_TAGS) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sp-status-tagspace-'));
    try {
      const tag = 'v1.0.0' + suffix;
      const repo = join(root, 'repo');
      mkdirSync(repo);
      assert.equal(runGit(['init'], repo).status, 0, label + ': repo initialised');
      runGit(['config', 'user.email', 't@example.com'], repo);
      runGit(['config', 'user.name', 't'], repo);
      writeFileSync(join(repo, 'f.txt'), 'a');
      runGit(['add', 'f.txt'], repo);
      assert.equal(runGit(['commit', '-m', 'a'], repo).status, 0, label + ': commit created');
      assert.equal(
        runGit(['update-ref', 'refs/tags/' + tag, 'HEAD'], repo).status,
        0,
        label + ': tag created',
      );
      assert.equal(
        runGit(['checkout', '--force', 'refs/tags/' + tag], repo).status,
        0,
        label + ': checkout created',
      );

      const statusResult = spawnSync(
        process.execPath,
        [join(PLUGIN_DIR, 'bin', 'dsh-superpowers.mjs'), 'status', '--dir', repo],
        { encoding: 'utf8' },
      );
      assert.equal(statusResult.status, 0, label + ': status exits 0: ' + statusResult.stderr);
      const tagLine = statusResult.stdout.split(LF).find((line) => line.startsWith('tag: '));
      assert.ok(tagLine, label + ': status prints a tag line: ' + statusResult.stdout);
      const displayed = tagLine.slice(5);
      // The trailing character must survive: raw for U+00A0, or escaped for
      // U+FEFF (a zero-width control escaped for terminal safety).
      assert.ok(
        displayed === tag || displayed === 'v1.0.0' + BACKSLASH + 'u{' + hex + '}',
        label + ': status reports the untrimmed tag, got ' + JSON.stringify(tagLine),
      );
      assert.ok(!displayed.endsWith('v1.0.0'), label + ': the trailing character is not trimmed away');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// R3-F2 (round 4): a legitimate large tag set must not fail at spawnSync's 1 MiB
// default; the implementation's explicit capture bound must admit it.

test('R3-F2: updateSkills succeeds when fetch output exceeds 1 MiB (large legal tag set)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-bigtags-'));
  try {
    const remote = join(root, 'remote');
    mkdirSync(remote);
    assert.equal(runGit(['init', '--bare', remote]).status, 0, 'bare remote created');
    const work = join(root, 'work');
    assert.equal(runGit(['clone', remote, work]).status, 0, 'work clone created');
    runGit(['config', 'user.email', 't@example.com'], work);
    runGit(['config', 'user.name', 't'], work);
    writeFileSync(join(work, 'f.txt'), 'a');
    runGit(['add', 'f.txt'], work);
    assert.equal(runGit(['commit', '-m', 'a'], work).status, 0, 'first commit created');
    const taggedSha = runGit(['rev-parse', 'HEAD'], work).stdout.trim();
    writeFileSync(join(work, 'f.txt'), 'b');
    runGit(['add', 'f.txt'], work);
    assert.equal(runGit(['commit', '-m', 'b'], work).status, 0, 'second commit created');
    assert.equal(runGit(['push', 'origin', 'HEAD'], work).status, 0, 'branch pushed');

    // Tags point at the parent commit, which a --depth 1 clone does not fetch,
    // so the follow-up fetch must emit a line per tag.
    const tagCount = 3000;
    const body = 'x'.repeat(220);
    const refs = [];
    for (let index = 0; index < tagCount; index += 1) {
      refs.push('create refs/tags/v2.' + String(index).padStart(4, '0') + '.0-' + body + ' ' + taggedSha);
    }
    const created = spawnSync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', 'update-ref', '--stdin'],
      { cwd: work, input: refs.join(LF) + LF, encoding: 'utf8' },
    );
    assert.equal(created.status, 0, 'tags batch-created: ' + created.stderr);
    assert.equal(
      runGit(['push', '--quiet', 'origin', 'refs/tags/*:refs/tags/*'], work).status,
      0,
      'all tags pushed in one command',
    );

    const url = pathToFileURL(remote).href;

    // Preflight: prove the fixture really exceeds the 1 MiB spawnSync default.
    const probe = join(root, 'probe');
    assert.equal(runGit(['clone', '--depth', '1', url, probe], root).status, 0, 'probe clone created');
    const probeFetch = spawnSync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', 'fetch', '--tags', '--force', 'origin'],
      { cwd: probe, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(probeFetch.status, 0, 'probe fetch succeeds: ' + probeFetch.stderr);
    const fetchOutputBytes = Buffer.byteLength(probeFetch.stderr ?? '', 'utf8');
    assert.ok(
      fetchOutputBytes > 1024 * 1024,
      'the fixture must exceed the 1 MiB default; measured ' + fetchOutputBytes + ' bytes',
    );

    const vendor = join(root, 'fresh', 'vendor');
    const binUrl = pathToFileURL(join(PLUGIN_DIR, 'bin', 'dsh-superpowers.mjs')).href;
    const script = [
      'import { updateSkills } from ' + JSON.stringify(binUrl) + ';',
      'process.exitCode = updateSkills(process.env.VENDOR_DIR, process.env.REMOTE_URL);',
    ].join(LF);

    const started = Date.now();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, VENDOR_DIR: vendor, REMOTE_URL: url },
      // The child replays the captured git output; keep the harness bound wide
      // enough that the test observes the implementation, not its own default.
      maxBuffer: 64 * 1024 * 1024,
    });
    const elapsed = Date.now() - started;

    assert.equal(
      child.status,
      0,
      'updateSkills succeeds past the 1 MiB default capture: ' + (child.stderr ?? '').slice(0, 800),
    );
    assert.ok(existsSync(join(vendor, '.git')), 'a checkout exists');
    assert.notEqual(runGit(['describe', '--tags'], vendor).stdout.trim(), '', 'a tag is checked out');
    assert.ok(elapsed < 60000, 'runtime stays reasonable; elapsed ' + elapsed + 'ms');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// R4-F1 (round 5): git output is replayed in bounded chunks, and an over-bound
// (ENOBUFS) capture is not replayed at all - neither may crash the stream.

/** A POSIX fake 'git' that floods stderr with newline-dense bytes, then fails. */
function makeNewlineDenseGitShim(root, byteCount) {
  const shimDir = join(root, 'shim');
  mkdirSync(shimDir);
  const shimPath = join(shimDir, 'git');
  writeFileSync(
    shimPath,
    '#!/bin/sh' + LF + 'yes A | head -c ' + byteCount + ' >&2' + LF + 'exit 1' + LF,
  );
  chmodSync(shimPath, 0o755);
  return { shimDir };
}

/** Node -e source: run updateSkills, mark a caught error, and probe for a checkout. */
function updateSkillsChildScript() {
  const binUrl = pathToFileURL(join(PLUGIN_DIR, 'bin', 'dsh-superpowers.mjs')).href;
  return [
    'import { existsSync } from "node:fs";',
    'import { updateSkills } from ' + JSON.stringify(binUrl) + ';',
    'try { updateSkills(process.env.VENDOR_DIR, process.env.REMOTE_URL); console.log("MARKER:NOERROR"); process.exitCode = 0; }',
    'catch (error) { console.log("MARKER:CAUGHT:" + (error && error.message)); process.exitCode = 7; }',
    'console.log("CHECKOUT:" + existsSync(process.env.VENDOR_DIR + "/.git"));',
  ].join(LF);
}

/** Run the updateSkills child behind a PATH shim, capturing up to 64 MiB. */
function runUpdateSkillsChild({ shimDir, vendor, repoUrl }) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', updateSkillsChildScript()], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: shimDir + ':' + process.env.PATH,
      VENDOR_DIR: vendor,
      REMOTE_URL: repoUrl,
    },
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Assertions shared by both newline-dense cases: no stream-error signature. */
function assertNoStreamError(combined, label) {
  const sample = JSON.stringify(combined.slice(0, 300));
  assert.ok(!combined.includes('EINVAL'), label + ': no EINVAL stream error: ' + sample);
  assert.ok(!combined.includes("Unhandled 'error' event"), label + ': no unhandled stream error event: ' + sample);
  assert.ok(!combined.includes('throw er;'), label + ': no uncaught stream error throw: ' + sample);
  assert.doesNotMatch(combined, /^\s+at .*node:/m, label + ': no Node internal stack from a stream error');
}

test('R4-F1: newline-dense output beyond the capture bound fails closed without EINVAL or a giant replay', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-enobufs-'));
  try {
    // 17,000,000 bytes > the implementation's 16 MiB capture bound.
    const { shimDir } = makeNewlineDenseGitShim(root, 17000000);
    const vendor = join(root, 'fresh', 'vendor');
    const repoUrl = 'file://' + join(root, 'unused.git');

    const started = Date.now();
    const child = runUpdateSkillsChild({ shimDir, vendor, repoUrl });
    const elapsed = Date.now() - started;
    const combined = (child.stdout ?? '') + (child.stderr ?? '');
    const outputBytes = Buffer.byteLength(combined, 'utf8');

    assert.notEqual(child.status, 0, 'the run fails closed: ' + JSON.stringify(combined.slice(0, 400)));
    assert.match(child.stdout ?? '', /MARKER:CAUGHT:/, 'the child caught and marked the error: ' + JSON.stringify(child.stdout));
    assert.match(combined, /git clone failed/, 'the failure diagnostic names the clone step: ' + JSON.stringify(combined.slice(0, 400)));
    assertNoStreamError(combined, 'above-cap');
    assert.match(child.stdout ?? '', /CHECKOUT:false/, 'no checkout is left behind: ' + JSON.stringify(child.stdout));
    assert.ok(!existsSync(join(vendor, '.git')), 'no checkout exists on disk');

    // ENOBUFS means the captured text is incomplete: replaying it is wrong, so
    // the oversized capture must not reach the terminal.
    assert.ok(outputBytes < 1024 * 1024, 'the incomplete capture is not replayed; output ' + outputBytes + ' bytes');
    assert.ok(elapsed < 30000, 'the run fails fast; elapsed ' + elapsed + 'ms');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R4-F1: below-cap newline-dense output is replayed in chunks without stream errors', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-chunked-'));
  try {
    // 2 MiB is below the 16 MiB capture bound, so it is captured and replayed.
    const byteCount = 2 * 1024 * 1024;
    const { shimDir } = makeNewlineDenseGitShim(root, byteCount);
    const vendor = join(root, 'fresh', 'vendor');
    const repoUrl = 'file://' + join(root, 'unused.git');

    const started = Date.now();
    const child = runUpdateSkillsChild({ shimDir, vendor, repoUrl });
    const elapsed = Date.now() - started;
    const combined = (child.stdout ?? '') + (child.stderr ?? '');
    const stderrBytes = Buffer.byteLength(child.stderr ?? '', 'utf8');

    assert.notEqual(child.status, 0, 'the clone still fails: ' + JSON.stringify(combined.slice(0, 400)));
    assert.match(child.stdout ?? '', /MARKER:CAUGHT:/, 'the child caught and marked the error: ' + JSON.stringify(child.stdout));
    assert.match(combined, /git clone failed/, 'the failure diagnostic names the clone step');
    assertNoStreamError(combined, 'below-cap');
    assert.match(child.stdout ?? '', /CHECKOUT:false/, 'no checkout is left behind: ' + JSON.stringify(child.stdout));

    // Chunked replay preserves the full below-bound output and its line structure.
    assert.ok(stderrBytes >= byteCount * 0.9, 'the newline-dense output is preserved; got ' + stderrBytes + ' bytes');
    let newlineCount = 0;
    for (let index = 0; index < (child.stderr ?? '').length; index += 1) {
      if (child.stderr.charCodeAt(index) === 10) newlineCount += 1;
    }
    assert.ok(newlineCount > 500000, 'the line structure is preserved; got ' + newlineCount + ' newlines');
    assert.ok(elapsed < 30000, 'the replay is bounded; elapsed ' + elapsed + 'ms');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// R5-F1 (round 6): a huge single-line git error must fail fast with the clean
// clone diagnostic, not spend quadratic time inside credential redaction.

/** A POSIX fake 'git' that emits one long stderr line (no newline), then fails. */
function makeLongLineGitShim(root, byteCount) {
  const shimDir = join(root, 'shim');
  mkdirSync(shimDir);
  const shimPath = join(shimDir, 'git');
  writeFileSync(
    shimPath,
    '#!/bin/sh' + LF + "printf '%*s' " + byteCount + " '' | tr ' ' 'A' >&2" + LF + 'exit 1' + LF,
  );
  chmodSync(shimPath, 0o755);
  return { shimDir };
}

test('R5-F1: a 512 KiB single-line git error fails fast with the clean clone diagnostic', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-longline-'));
  try {
    const { shimDir } = makeLongLineGitShim(root, 512 * 1024);
    const vendor = join(root, 'fresh', 'vendor');
    const repoUrl = 'file://' + join(root, 'unused.git');

    const started = Date.now();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', updateSkillsChildScript()], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: shimDir + ':' + process.env.PATH,
        VENDOR_DIR: vendor,
        REMOTE_URL: repoUrl,
      },
      // Hard timeout: the pre-fix redaction is quadratic on this 512 KiB line
      // and would otherwise stall the run for minutes.
      timeout: 12000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const elapsed = Date.now() - started;
    const combined = (child.stdout ?? '') + (child.stderr ?? '');

    assert.notEqual(child.error?.code, 'ETIMEDOUT', 'the run must not hit the hard timeout: ' + (child.error?.message ?? ''));
    assert.equal(child.status, 7, 'the child caught the error and exited on its own: ' + JSON.stringify(combined.slice(0, 300)));
    assert.match(
      child.stdout ?? '',
      /MARKER:CAUGHT:git clone failed \(/,
      'the caught error is the clean clone diagnostic: ' + JSON.stringify((child.stdout ?? '').slice(0, 200)),
    );
    assert.ok(!combined.includes('EINVAL'), 'no stream error: ' + JSON.stringify(combined.slice(0, 200)));
    assert.ok(!combined.includes("Unhandled 'error' event"), 'no unhandled stream error: ' + JSON.stringify(combined.slice(0, 200)));
    assert.ok(!existsSync(join(vendor, '.git')), 'no checkout is left behind');
    assert.ok(elapsed < 5000, 'the whole run finishes in <5 s; elapsed ' + elapsed + 'ms');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// R7-F1 (round 8): the replayed git stream must be redacted too, not only the
// plugin's own failure diagnostic.

/** A POSIX fake 'git' that echoes a credential-bearing error line, then fails. */
function makeCredentialLeakGitShim(root) {
  const shimDir = join(root, 'shim');
  mkdirSync(shimDir);
  const shimPath = join(shimDir, 'git');
  writeFileSync(
    shimPath,
    '#!/bin/sh' + LF +
      "echo 'fatal: unable to access https://user:supersecret@host.example/x: The requested URL returned error: 400' >&2" + LF +
      'exit 1' + LF,
  );
  chmodSync(shimPath, 0o755);
  return { shimDir };
}

test('R7-F1: a credential-bearing git error line is redacted in the replayed stream', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-credleak-'));
  try {
    const { shimDir } = makeCredentialLeakGitShim(root);
    const vendor = join(root, 'fresh', 'vendor');
    const repoUrl = 'file://' + join(root, 'unused.git');

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', updateSkillsChildScript()], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: shimDir + ':' + process.env.PATH,
        VENDOR_DIR: vendor,
        REMOTE_URL: repoUrl,
      },
      timeout: 15000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const combined = (child.stdout ?? '') + (child.stderr ?? '');

    assert.equal(child.status, 7, 'the child caught the error and exited on its own: ' + JSON.stringify(combined.slice(0, 300)));
    assert.match(
      child.stdout ?? '',
      /MARKER:CAUGHT:git clone failed \(/,
      'the caught error is the clean clone diagnostic: ' + JSON.stringify((child.stdout ?? '').slice(0, 200)),
    );
    // The masked form must survive in the output (replayed stream and/or diagnostic).
    assert.ok(
      combined.includes('https://***@host.example/x'),
      'the credential URL is masked in the output: ' + JSON.stringify(combined.slice(0, 400)),
    );
    // The secret must not leak through the replay path.
    assert.ok(
      !combined.includes('supersecret'),
      'the password never reaches the output: ' + JSON.stringify(combined.slice(0, 400)),
    );
    assert.ok(!combined.includes('user:supersecret'), 'the userinfo pair never reaches the output');
    assertNoStreamError(combined, 'credential replay');
    assert.ok(!existsSync(join(vendor, '.git')), 'no checkout is left behind');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Round 9 (AR-1..AR-6): EPIPE-tolerant CLI, SIGKILL timeout, non-UTF-8 refs,
// column-proof tag listing, and CLI-level below-cap replay.
// ---------------------------------------------------------------------------

test('AR-1: a closed stdout reader (EPIPE) does not crash the CLI replay', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-epipe-'));
  try {
    const shimDir = join(root, 'shim');
    mkdirSync(shimDir);
    const shimPath = join(shimDir, 'git');
    // 2 MiB of newline-dense output on STDOUT, so the replayed stream is big
    // enough to hit a closed pipe; then the clone fails.
    writeFileSync(shimPath, '#!/bin/sh' + LF + 'yes A | head -c 2097152' + LF + 'exit 1' + LF);
    chmodSync(shimPath, 0o755);

    const child = spawn(
      process.execPath,
      [join(PLUGIN_DIR, 'bin', 'dsh-superpowers.mjs'), 'update-skills', '--dir', join(root, 'vendor')],
      { env: { ...process.env, PATH: shimDir + ':' + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('error', () => {}); // the parent read side closing is expected
    child.stdout.destroy(); // closed reader: every replay write should EPIPE

    const [code] = await once(child, 'close');

    assert.equal(code, 1, 'the CLI still exits with the git-failure code: ' + JSON.stringify(stderr.slice(0, 300)));
    assert.ok(stderr.includes('git clone failed'), 'the failure diagnostic is still produced: ' + JSON.stringify(stderr.slice(0, 300)));
    assert.ok(!stderr.includes('EPIPE'), 'no EPIPE reaches stderr: ' + JSON.stringify(stderr.slice(0, 400)));
    assert.ok(!stderr.includes("Unhandled 'error' event"), 'no unhandled stream error event: ' + JSON.stringify(stderr.slice(0, 400)));
    assert.doesNotMatch(stderr, /^\s+at .*node:/m, 'no Node-internal stream stack');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AR-3: a TERM-ignoring git child is SIGKILLed within the timeout bound', { skip: process.platform === 'win32', timeout: 15000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-sigkill-'));
  try {
    const shimDir = join(root, 'shim');
    mkdirSync(shimDir);
    const shimPath = join(shimDir, 'git');
    // Ignore SIGTERM and outlive the 100 ms bound; only SIGKILL can stop it.
    writeFileSync(
      shimPath,
      '#!/bin/sh' + LF + "trap '' TERM" + LF + 'sleep 3 </dev/null >/dev/null 2>&1' + LF + 'exit 1' + LF,
    );
    chmodSync(shimPath, 0o755);

    const vendor = join(root, 'fresh', 'vendor');
    let elapsed = 0;
    withPatchedEnv({ PATH: shimDir + ':' + process.env.PATH, DSH_SUPERPOWERS_GIT_TIMEOUT_MS: '100' }, () => {
      const started = Date.now();
      assert.throws(
        () => updateSkills(vendor, 'file://' + join(root, 'unused.git')),
        (error) => {
          assert.ok(error instanceof Error, 'a timed-out step still throws');
          assert.match(error.message, /timed out/i, 'the failure names the timeout: ' + error.message);
          return true;
        },
      );
      elapsed = Date.now() - started;
    });

    assert.ok(elapsed < 1000, 'the TERM-trapping child is killed well inside 1 s; elapsed ' + elapsed + 'ms');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AR-5: a tag whose name is invalid UTF-8 fails closed instead of selecting the U+FFFD twin', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-nonutf8-tag-'));
  try {
    const remote = join(root, 'remote');
    mkdirSync(remote);
    assert.equal(runGit(['init', '--bare', remote]).status, 0, 'bare remote created');
    const work = join(root, 'work');
    assert.equal(runGit(['clone', remote, work]).status, 0, 'work clone created');
    runGit(['config', 'user.email', 't@example.com'], work);
    runGit(['config', 'user.name', 't'], work);
    writeFileSync(join(work, 'f.txt'), 'a');
    runGit(['add', 'f.txt'], work);
    assert.equal(runGit(['commit', '-m', 'a'], work).status, 0, 'tag target commit created');
    const taggedSha = runGit(['rev-parse', 'HEAD'], work).stdout.trim();
    // The branch tip is a different commit, so a silent tag checkout would move
    // HEAD backwards and be observable.
    writeFileSync(join(work, 'f.txt'), 'b');
    runGit(['add', 'f.txt'], work);
    assert.equal(runGit(['commit', '-m', 'b'], work).status, 0, 'branch tip commit created');
    assert.equal(runGit(['push', 'origin', 'HEAD'], work).status, 0, 'branch pushed');

    // A legal ref containing a raw 0xFF byte, plus the U+FFFD twin it would
    // decode to: a utf8 decoder cannot tell them apart.
    const twin = 'v2.0.0' + String.fromCharCode(0xfffd);
    assert.equal(runGit(['update-ref', 'refs/tags/' + twin, taggedSha], work).status, 0, 'U+FFFD twin tag created');
    const payload = Buffer.concat([
      Buffer.from('create refs/tags/v2.0.0'),
      Buffer.from([0xff]),
      Buffer.from(' ' + taggedSha + LF),
    ]);
    const raw = spawnSync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', 'update-ref', '--stdin'],
      { cwd: work, input: payload },
    );
    assert.equal(raw.status, 0, 'non-UTF-8 tag created: ' + raw.stderr.toString());
    assert.equal(
      runGit(['push', '--quiet', 'origin', 'refs/tags/*:refs/tags/*'], work).status,
      0,
      'both tags pushed',
    );

    const vendor = join(root, 'fresh', 'vendor');
    assert.throws(
      () => updateSkills(vendor, pathToFileURL(remote).href),
      (error) => {
        assert.ok(error instanceof Error, 'a non-UTF-8 tag fails closed');
        assert.match(
          error.message,
          /invalid|utf-?8|replacement|decode/i,
          'the failure names the encoding problem: ' + error.message,
        );
        return true;
      },
      'a tag decoding to U+FFFD must not be checked out silently',
    );
    // Fails closed: the U+FFFD twin was never checked out, so HEAD still points
    // at the branch tip rather than at the tagged (older) commit.
    if (existsSync(join(vendor, '.git'))) {
      assert.notEqual(
        runGit(['rev-parse', 'HEAD'], vendor).stdout.trim(),
        runGit(['rev-parse', 'refs/tags/' + twin], vendor).stdout.trim(),
        'the U+FFFD twin is not checked out',
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AR-6: column.ui=always does not break tag resolution', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-column-'));
  try {
    const { url } = makeTaggedBareRemote(root);
    const gitConfig = join(root, 'gitconfig');
    writeFileSync(gitConfig, '[column]' + LF + 'ui = always' + LF);
    const vendor = join(root, 'fresh', 'vendor');

    withPatchedEnv({ GIT_CONFIG_GLOBAL: gitConfig }, () => {
      assert.equal(updateSkills(vendor, url), 0, 'the columnized tag listing still resolves');
    });

    assert.equal(
      stripTrailingNewlines(runGit(['describe', '--tags'], vendor).stdout),
      'v2.0.0',
      'the newest version-sorted tag is checked out',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AR-2: a below-cap newline-dense replay completes through the real CLI', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-cli-replay-'));
  try {
    const shimDir = join(root, 'shim');
    mkdirSync(shimDir);
    const shimPath = join(shimDir, 'git');
    // 256 KiB is below the 16 MiB capture bound, so it must be replayed.
    writeFileSync(shimPath, '#!/bin/sh' + LF + 'yes A | head -c 262144 >&2' + LF + 'exit 1' + LF);
    chmodSync(shimPath, 0o755);

    const result = spawnSync(
      process.execPath,
      [join(PLUGIN_DIR, 'bin', 'dsh-superpowers.mjs'), 'update-skills', '--dir', join(root, 'vendor')],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: shimDir + ':' + process.env.PATH },
        timeout: 15000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const combined = (result.stdout ?? '') + (result.stderr ?? '');

    assert.equal(result.status, 1, 'the CLI exits with the git-failure code: ' + JSON.stringify(combined.slice(0, 200)));
    assert.ok(combined.includes('git clone failed'), 'the failure diagnostic is present');
    let newlineCount = 0;
    for (let index = 0; index < combined.length; index += 1) {
      if (combined.charCodeAt(index) === 10) newlineCount += 1;
    }
    assert.ok(newlineCount > 1000, 'the newline-dense replay reached the CLI streams; newlines ' + newlineCount);
    assert.ok(!combined.includes('EINVAL'), 'no EINVAL stream error');
    assert.ok(!combined.includes("Unhandled 'error' event"), 'no unhandled stream error event');
    assert.doesNotMatch(combined, /^\s+at .*node:/m, 'no Node-internal stream stack');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Round 10 (R9-1, R9-2, R9-4, R9-6): partial-clone cleanup, direct-library
// EPIPE, U+FFFD diagnostics, and a 16 MiB tag listing.
// ---------------------------------------------------------------------------

/**
 * A bare remote whose tags point at a parent commit and whose tag list contains
 * a raw 0xFF ref plus the valid-UTF-8 U+FFFD twin it decodes to. The branch tip
 * is a different commit, so a silent tag checkout moves HEAD and is observable.
 */
function makeFffdTwinRemote(root) {
  mkdirSync(root, { recursive: true });
  const remote = join(root, 'remote');
  mkdirSync(remote);
  assert.equal(runGit(['init', '--bare', remote]).status, 0, 'bare remote created');
  const work = join(root, 'work');
  assert.equal(runGit(['clone', remote, work]).status, 0, 'work clone created');
  runGit(['config', 'user.email', 't@example.com'], work);
  runGit(['config', 'user.name', 't'], work);
  writeFileSync(join(work, 'f.txt'), 'a');
  runGit(['add', 'f.txt'], work);
  assert.equal(runGit(['commit', '-m', 'a'], work).status, 0, 'tag target commit created');
  const taggedSha = runGit(['rev-parse', 'HEAD'], work).stdout.trim();
  writeFileSync(join(work, 'f.txt'), 'b');
  runGit(['add', 'f.txt'], work);
  assert.equal(runGit(['commit', '-m', 'b'], work).status, 0, 'branch tip commit created');
  assert.equal(runGit(['push', 'origin', 'HEAD'], work).status, 0, 'branch pushed');

  const twin = 'v2.0.0' + String.fromCharCode(0xfffd);
  assert.equal(runGit(['update-ref', 'refs/tags/' + twin, taggedSha], work).status, 0, 'U+FFFD twin tag created');
  const payload = Buffer.concat([
    Buffer.from('create refs/tags/v2.0.0'),
    Buffer.from([0xff]),
    Buffer.from(' ' + taggedSha + LF),
  ]);
  const raw = spawnSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', 'update-ref', '--stdin'],
    { cwd: work, input: payload },
  );
  assert.equal(raw.status, 0, 'non-UTF-8 tag created: ' + raw.stderr.toString());
  assert.equal(
    runGit(['push', '--quiet', 'origin', 'refs/tags/*:refs/tags/*'], work).status,
    0,
    'both tags pushed',
  );
  return { remote, url: pathToFileURL(remote).href, twin, work };
}

test('R9-1: a failed first-run clone removes the partial directory so a retry re-clones', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-partial-'));
  try {
    const shimDir = join(root, 'shim');
    mkdirSync(shimDir);
    const shimPath = join(shimDir, 'git');
    // Emulate a clone that creates a partial checkout in its destination, then
    // fails. The destination is the last argv element (the plugin may clone into
    // a temporary sibling), so the fixture must not assume the final vendor path.
    writeFileSync(
      shimPath,
      '#!/bin/sh' + LF +
        'for last in "$@"; do :; done' + LF +
        'mkdir -p "$last/.git"' + LF +
        'echo partial > "$last/partial.txt"' + LF +
        'exit 1' + LF,
    );
    chmodSync(shimPath, 0o755);
    const parent = join(root, 'fresh');
    const vendor = join(parent, 'vendor');

    withPatchedEnv({ PATH: shimDir + ':' + process.env.PATH }, () => {
      assert.throws(
        () => updateSkills(vendor, 'file://' + join(root, 'nope.git')),
        /git clone failed/,
        'the first clone fails',
      );
    });
    assert.equal(existsSync(vendor), false, 'the plugin-created partial vendor directory is removed');
    assert.deepEqual(readdirSync(parent), [], 'no temporary clone directory is left behind');

    const goodRoot = join(root, 'good');
    mkdirSync(goodRoot, { recursive: true });
    const { url } = makeTaggedBareRemote(goodRoot);
    assert.equal(updateSkills(vendor, url), 0, 'a retry after the failure re-clones and succeeds');
    assert.equal(
      stripTrailingNewlines(runGit(['describe', '--tags'], vendor).stdout),
      'v2.0.0',
      'the retry checks out the newest tag',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R9-2: direct library callers tolerate EPIPE from a closed stdout reader', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-lib-epipe-'));
  try {
    const shimDir = join(root, 'shim');
    mkdirSync(shimDir);
    const shimPath = join(shimDir, 'git');
    writeFileSync(shimPath, '#!/bin/sh' + LF + 'yes A | head -c 2097152' + LF + 'exit 1' + LF);
    chmodSync(shimPath, 0o755);

    const binUrl = pathToFileURL(join(PLUGIN_DIR, 'bin', 'dsh-superpowers.mjs')).href;
    const script = [
      'import { updateSkills } from ' + JSON.stringify(binUrl) + ';',
      'try { updateSkills(process.env.VENDOR_DIR, process.env.REMOTE_URL); process.exitCode = 0; }',
      'catch (error) { console.error("MARKER:CAUGHT:" + (error && error.message)); process.exitCode = 7; }',
    ].join(LF);
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: {
        ...process.env,
        PATH: shimDir + ':' + process.env.PATH,
        VENDOR_DIR: join(root, 'vendor'),
        REMOTE_URL: 'file://' + join(root, 'nope.git'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('error', () => {}); // the parent read side closing is expected
    child.stdout.destroy();

    const [code] = await once(child, 'close');

    assert.equal(code, 7, 'the library caller caught the git failure cleanly: ' + JSON.stringify(stderr.slice(0, 300)));
    assert.ok(
      stderr.includes('MARKER:CAUGHT:git clone failed'),
      'the caught error is the git failure, not an EPIPE crash: ' + JSON.stringify(stderr.slice(0, 300)),
    );
    assert.ok(!stderr.includes('EPIPE'), 'no EPIPE reaches stderr: ' + JSON.stringify(stderr.slice(0, 400)));
    assert.ok(!stderr.includes("Unhandled 'error' event"), 'no unhandled stream error event');
    assert.doesNotMatch(stderr, /^\s+at .*node:/m, 'no Node-internal stream stack');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R9-4: the U+FFFD refusal names the offending tag', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-fffd-message-'));
  try {
    const { url } = makeFffdTwinRemote(root);
    const vendor = join(root, 'fresh', 'vendor');

    assert.throws(
      () => updateSkills(vendor, url),
      (error) => {
        assert.ok(error instanceof Error, 'a U+FFFD tag fails closed');
        assert.match(
          error.message,
          /U\+FFFD|replacement|invalid.*utf-?8|utf-?8/i,
          'the refusal explains the U+FFFD decoding problem: ' + error.message,
        );
        assert.ok(
          error.message.includes('v2.0.0'),
          'the refusal names the offending tag: ' + error.message,
        );
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R9-4: status diagnoses a describe tag that contains U+FFFD', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-fffd-status-'));
  try {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    assert.equal(runGit(['init'], repo).status, 0, 'repo initialised');
    runGit(['config', 'user.email', 't@example.com'], repo);
    runGit(['config', 'user.name', 't'], repo);
    writeFileSync(join(repo, 'f.txt'), 'a');
    runGit(['add', 'f.txt'], repo);
    assert.equal(runGit(['commit', '-m', 'a'], repo).status, 0, 'commit created');
    const twin = 'v2.0.0' + String.fromCharCode(0xfffd);
    assert.equal(runGit(['update-ref', 'refs/tags/' + twin, 'HEAD'], repo).status, 0, 'U+FFFD tag created');
    assert.equal(runGit(['checkout', '--force', 'refs/tags/' + twin], repo).status, 0, 'tag checked out');

    const result = spawnSync(
      process.execPath,
      [join(PLUGIN_DIR, 'bin', 'dsh-superpowers.mjs'), 'status', '--dir', repo],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 0, 'status stays informational (exit 0): ' + result.stderr);
    assert.match(
      result.stderr,
      /U\+FFFD|replacement|invalid.*utf-?8/i,
      'status diagnoses the U+FFFD tag on stderr: ' + result.stderr,
    );
    assert.ok(result.stderr.includes('v2.0.0'), 'the diagnostic names the tag: ' + result.stderr);
    assert.match(result.stdout, /^tag: /m, 'the informational tag line is still printed: ' + result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R9-6: a 16 MiB tag listing still completes and selects its first line', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-16m-tags-'));
  try {
    const shimDir = join(root, 'shim');
    mkdirSync(shimDir);
    const logPath = join(root, 'git-calls.log');
    const vendor = join(root, 'vendor');
    writeFileSync(
      join(shimDir, 'git'),
      [
        '#!/bin/sh',
        'case "$1" in',
        '  clone) for last in "$@"; do :; done; mkdir -p "$last/.git"; exit 0 ;;',
        '  fetch|checkout) echo "$@" >> "$GIT_LOG"; exit 0 ;;',
        '  tag) echo v9.9.9; yes x | head -c 16777209; exit 0 ;;',
        '  rev-list) echo 0123456789abcdef0123456789abcdef01234567; exit 0 ;;',
        'esac',
        'exit 0',
        '',
      ].join(LF),
    );
    chmodSync(join(shimDir, 'git'), 0o755);

    let elapsed = 0;
    withPatchedEnv({ PATH: shimDir + ':' + process.env.PATH, GIT_LOG: logPath }, () => {
      const started = Date.now();
      assert.equal(updateSkills(vendor, 'file://' + join(root, 'nope.git')), 0, 'the 16 MiB listing resolves');
      elapsed = Date.now() - started;
    });

    const calls = readFileSync(logPath, 'utf8').trim().split(LF);
    assert.ok(
      calls.some((line) => /checkout --force refs\/tags\/v9\.9\.9$/.test(line)),
      'the first line of the 16 MiB listing is selected: ' + JSON.stringify(calls.slice(0, 5)),
    );
    assert.ok(elapsed < 15000, 'the listing completes in reasonable time; elapsed ' + elapsed + 'ms');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Round 11 (R10-1, R10-2): clone-temp race safety, dangling symlink refusal,
// bounded tag diagnostics, and the 16 MiB listing memory guard.
// ---------------------------------------------------------------------------

/** A POSIX fake 'git' whose behaviour is a case statement over its first argument. */
function makeCaseGitShim(root, caseLines) {
  const shimDir = join(root, 'shim');
  mkdirSync(shimDir, { recursive: true });
  const shimPath = join(shimDir, 'git');
  writeFileSync(shimPath, '#!/bin/sh' + LF + 'case "$1" in' + LF + caseLines.join(LF) + LF + 'esac' + LF);
  chmodSync(shimPath, 0o755);
  return shimDir;
}

test('R10-1: a vendor directory that appears during the clone is kept and the clone fails clearly', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-clone-race-'));
  try {
    const shimDir = makeCaseGitShim(root, [
      '  clone) for last in "$@"; do :; done; mkdir -p "$last/.git"; mkdir -p "$VENDOR_DIR"; echo concurrent > "$VENDOR_DIR/concurrent.txt"; exit 0 ;;',
      '  fetch) exit 0 ;;',
      '  tag) echo v1.0.0; exit 0 ;;',
      '  rev-list) echo 0123456789abcdef0123456789abcdef01234567; exit 0 ;;',
      '  checkout) exit 0 ;;',
    ]);
    const parent = join(root, 'fresh');
    const vendor = join(parent, 'vendor');

    withPatchedEnv({ PATH: shimDir + ':' + process.env.PATH, VENDOR_DIR: vendor }, () => {
      assert.throws(
        () => updateSkills(vendor, 'file://' + join(root, 'nope.git')),
        (error) => {
          assert.ok(error instanceof Error, 'the race fails closed');
          assert.match(
            error.message,
            /appear|concurrent|already exists|existing|vendor dir|refus/i,
            'the race failure is clear: ' + error.message,
          );
          return true;
        },
      );
    });

    assert.equal(
      existsSync(join(vendor, 'concurrent.txt')),
      true,
      'the concurrently created vendor file survives',
    );
    assert.deepEqual(readdirSync(parent), ['vendor'], 'only the plugin-created temporary directory is removed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R10-1: a dangling symlink at vendorDir is refused and preserved', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-dangling-link-'));
  try {
    const parent = join(root, 'fresh');
    mkdirSync(parent);
    const vendor = join(parent, 'vendor');
    const target = join(root, 'missing-target');
    symlinkSync(target, vendor);
    assert.equal(lstatSync(vendor).isSymbolicLink(), true, 'the fixture is a symlink');

    assert.throws(
      () => updateSkills(vendor, 'file://' + join(root, 'nope.git')),
      (error) => {
        assert.ok(error instanceof Error, 'an existing dangling symlink is refused');
        assert.match(
          error.message,
          /symlink|symbolic|existing|refus|not a git|appear/i,
          'the refusal is clear: ' + error.message,
        );
        return true;
      },
    );

    assert.equal(lstatSync(vendor).isSymbolicLink(), true, 'the symlink is not replaced or removed');
    assert.equal(readlinkSync(vendor), target, 'the symlink target is unchanged');
    assert.equal(existsSync(target), false, 'the symlink target is not created');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R10-1: a failed clone removes only its own temporary directory', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-temp-only-'));
  try {
    const shimDir = makeCaseGitShim(root, [
      '  clone) for last in "$@"; do :; done; mkdir -p "$last/.git"; mkdir -p "$VENDOR_DIR"; echo concurrent > "$VENDOR_DIR/concurrent.txt"; exit 1 ;;',
    ]);
    const parent = join(root, 'fresh');
    const vendor = join(parent, 'vendor');

    withPatchedEnv({ PATH: shimDir + ':' + process.env.PATH, VENDOR_DIR: vendor }, () => {
      assert.throws(
        () => updateSkills(vendor, 'file://' + join(root, 'nope.git')),
        /git clone failed/,
        'the failed clone still reports the git failure',
      );
    });

    assert.equal(
      existsSync(join(vendor, 'concurrent.txt')),
      true,
      'the concurrently created vendor file survives a clone failure',
    );
    assert.deepEqual(readdirSync(parent), ['vendor'], 'no temporary clone directory is left behind');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R10-2: a 1 MiB U+FFFD tag diagnostic is capped and marked as truncated', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-big-fffd-tag-'));
  try {
    const tagData = join(root, 'tag-data.bin');
    writeFileSync(
      tagData,
      Buffer.concat([
        Buffer.from('v1.0.0'),
        Buffer.alloc(1048576, 'a'),
        Buffer.from([0xef, 0xbf, 0xbd]),
        Buffer.from(LF),
      ]),
    );
    const shimDir = makeCaseGitShim(root, [
      '  clone) for last in "$@"; do :; done; mkdir -p "$last/.git"; exit 0 ;;',
      '  fetch) exit 0 ;;',
      '  tag) cat "$TAG_DATA"; exit 0 ;;',
      '  rev-list) echo 0123456789abcdef0123456789abcdef01234567; exit 0 ;;',
      '  checkout) exit 0 ;;',
    ]);
    const vendor = join(root, 'fresh', 'vendor');

    withPatchedEnv({ PATH: shimDir + ':' + process.env.PATH, TAG_DATA: tagData }, () => {
      assert.throws(
        () => updateSkills(vendor, 'file://' + join(root, 'nope.git')),
        (error) => {
          assert.ok(error instanceof Error, 'a huge U+FFFD tag fails closed');
          assert.ok(
            error.message.length < 1024,
            'the diagnostic is capped, got ' + error.message.length + ' chars',
          );
          assert.match(error.message, /\.\.\.|…/, 'the capped diagnostic marks truncation');
          assert.match(error.message, /chars|characters/i, 'the diagnostic reports the original length');
          assert.ok(error.message.includes('v1.0.0'), 'the diagnostic still identifies the tag');
          assert.match(
            error.message,
            /U\+FFFD|replacement|invalid.*utf-?8/i,
            'the diagnostic explains the decoding problem: ' + error.message,
          );
          return true;
        },
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R9-6: the 16 MiB tag listing child stays under 250 MB maxRSS', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-16m-rss-'));
  try {
    const shimDir = makeCaseGitShim(root, [
      '  clone) for last in "$@"; do :; done; mkdir -p "$last/.git"; exit 0 ;;',
      '  fetch|checkout) exit 0 ;;',
      '  tag) echo v9.9.9; yes x | head -c 16777209; exit 0 ;;',
      '  rev-list) echo 0123456789abcdef0123456789abcdef01234567; exit 0 ;;',
    ]);
    const vendor = join(root, 'vendor');
    const binUrl = pathToFileURL(join(PLUGIN_DIR, 'bin', 'dsh-superpowers.mjs')).href;
    const script = [
      'import { updateSkills } from ' + JSON.stringify(binUrl) + ';',
      'let code = 0;',
      'try { code = updateSkills(process.env.VENDOR_DIR, "file:///tmp/x"); } catch (error) { code = "threw:" + error.message.slice(0, 60); }',
      'process.stdout.write("RESULT_JSON:" + JSON.stringify({ code, maxRSS: process.resourceUsage().maxRSS }) + "\\n");',
    ].join(LF);

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: shimDir + ':' + process.env.PATH, VENDOR_DIR: vendor },
      timeout: 60000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(child.status, 0, 'the maxRSS probe exits 0: ' + child.stderr);

    const line = child.stdout.split(LF).find((entry) => entry.startsWith('RESULT_JSON:'));
    assert.ok(line, 'the probe reports its result: ' + JSON.stringify(child.stdout.slice(0, 200)));
    const result = JSON.parse(line.slice('RESULT_JSON:'.length));
    assert.equal(result.code, 0, 'the 16 MiB listing resolves in the child');
    assert.ok(result.maxRSS > 0, 'maxRSS is reported in KB: ' + result.maxRSS);
    assert.ok(
      result.maxRSS < 250 * 1024,
      'the 16 MiB listing child stays under 250 MB; maxRSS ' + result.maxRSS + ' KB',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
