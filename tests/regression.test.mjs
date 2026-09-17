import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inject, discoverSkills, apply, PLUGIN_DIR, resolveConfig } from '../lib/index.js';
import { updateSkills } from '../bin/dsh-superpowers.mjs';

const LF = String.fromCharCode(10);

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
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sp-bin-'));
  try {
    const real = join(PLUGIN_DIR, 'bin', 'dsh-superpowers.mjs');
    const link = join(dir, 'dsh-superpowers.mjs');
    symlinkSync(real, link);
    const viaLink = spawnSync(process.execPath, [link, 'status'], { encoding: 'utf8' });
    assert.equal(viaLink.status, 0, 'symlinked bin exits 0: ' + viaLink.stderr);
    assert.ok(viaLink.stdout.includes('tag: v6.3.0'));
    assert.ok(viaLink.stdout.includes('skill dirs: 14'));
    const direct = spawnSync(process.execPath, [real, 'status'], { encoding: 'utf8' });
    assert.equal(direct.status, 0);
    assert.ok(direct.stdout.includes('skill dirs: 14'));
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
