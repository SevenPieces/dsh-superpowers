import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { inject, discoverSkills, apply, PLUGIN_DIR, resolveConfig } from '../lib/index.js';
import { updateSkills } from '../bin/dsh-superpowers.mjs';

const LF = String.fromCharCode(10);

/** Real git with commit/tag signing pinned off (F1 pattern). */
function runGit(args, cwd) {
  return spawnSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
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
