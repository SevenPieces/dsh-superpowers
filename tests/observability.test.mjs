/**
 * Observability hardening tests:
 *  D — discovery distinguishes a missing SKILL.md from an existing-but-unreadable
 *      one and from invalid UTF-8, and never serves U+FFFD.
 *  E — control characters in a skill entry name are escaped, so a hostile
 *      directory name cannot forge warning lines.
 *  R1 — every diagnostic that interpolates a path or an error message is
 *      escaped too: a crafted path, a hostile getter or a config path must not
 *      forge a log line.
 *
 * These are fail-open diagnostics contracts: the catalog must never silently
 * mislabel a file, and a log line must stay one line.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  composeBootstrap,
  createBootstrapProvider,
  createSkillsProvider,
  discoverSkills,
} from '../lib/index.js'

const LF = String.fromCharCode(10)
const ESC = String.fromCharCode(27)
const BACKSLASH = String.fromCharCode(92)
const ESCAPED_NEWLINE = BACKSLASH + 'n'
const BIDI_OVERRIDE = String.fromCharCode(0x202e)
const ESCAPED_BIDI = BACKSLASH + 'u{' + '202e' + '}'
const REPLACEMENT = String.fromCharCode(0xfffd)
// C0 controls, DEL, and C1 controls: a warning line must carry none of these raw.
const CONTROL = new RegExp(
  '[' + String.fromCharCode(0x00) + '-' + String.fromCharCode(0x1f) +
  String.fromCharCode(0x7f) + '-' + String.fromCharCode(0x9f) + ']',
)

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-sp-obs-'))
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

function writeSkill(dir, name, description, body) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---' + LF + 'name: ' + name + LF + 'description: ' + description + LF + '---' + LF + body + LF,
  )
}

/** A SKILL.md whose bytes are not valid UTF-8 (lone 0xFF then 0xFE). */
function writeInvalidUtf8Skill(dir, name, description) {
  mkdirSync(dir, { recursive: true })
  const head = Buffer.from(
    '---' + LF + 'name: ' + name + LF + 'description: ' + description + LF + '---' + LF + 'Body ',
    'utf8',
  )
  writeFileSync(join(dir, 'SKILL.md'), Buffer.concat([head, Buffer.from([0xff, 0xfe, 0x2e])]))
}

/** Discover under a reporter that keeps {reason, entryName, detail}. */
function readSkips(skillsDir) {
  const skips = []
  const skills = discoverSkills(skillsDir, 'superpowers', 600, (reason, entryName, detail) => {
    skips.push({ reason, entryName, detail })
  })
  return { skills, skips }
}

// ------------------------------------------------------------------ D

test('D: an existing but unreadable SKILL.md reports unreadable-skill-md with its cause', { skip: process.getuid?.() === 0 }, () => {
  const root = makeTempDir()
  const dir = join(root, 'skills')
  const lockedPath = join(dir, 'locked', 'SKILL.md')
  try {
    writeSkill(join(dir, 'locked'), 'locked', 'Locked skill', 'Locked body')
    writeSkill(join(dir, 'alpha'), 'alpha', 'Alpha skill', 'Alpha body')
    chmodSync(lockedPath, 0o000)

    const { skills, skips } = readSkips(dir)

    assert.deepEqual(skills.map((skill) => skill.name), ['alpha'], 'the unreadable skill is not catalogued')
    const locked = skips.find((skip) => skip.entryName === 'locked')
    assert.ok(locked, 'the unreadable entry is reported: ' + JSON.stringify(skips))
    assert.equal(
      locked.reason,
      'unreadable-skill-md',
      'an existing unreadable file must not be reported as missing: ' + JSON.stringify(skips),
    )
    assert.ok(
      typeof locked.detail === 'string' && locked.detail !== '',
      'the cause is carried in the detail: ' + JSON.stringify(locked),
    )
    assert.match(
      locked.detail,
      /EACCES|EPERM|permission denied|illegal operation/i,
      'the detail names the read failure: ' + locked.detail,
    )
  } finally {
    chmodSync(lockedPath, 0o644)
    cleanup(root)
  }
})

test('D: a missing SKILL.md stays missing-skill-md, distinct from unreadable', () => {
  const root = makeTempDir()
  const dir = join(root, 'skills')
  try {
    mkdirSync(join(dir, 'no-md'), { recursive: true })
    writeSkill(join(dir, 'alpha'), 'alpha', 'Alpha skill', 'Alpha body')

    const { skills, skips } = readSkips(dir)

    assert.deepEqual(skills.map((skill) => skill.name), ['alpha'], 'only readable skills are catalogued')
    const missing = skips.find((skip) => skip.entryName === 'no-md')
    assert.ok(missing, 'the missing file is reported: ' + JSON.stringify(skips))
    assert.equal(
      missing.reason,
      'missing-skill-md',
      'a missing file keeps its own reason: ' + JSON.stringify(skips),
    )
    assert.ok(
      !skips.some((skip) => skip.reason === 'unreadable-skill-md'),
      'nothing is mislabelled unreadable in a healthy tree: ' + JSON.stringify(skips),
    )
  } finally {
    cleanup(root)
  }
})

test('D: an invalid-UTF-8 SKILL.md reports invalid-utf8 and never yields a U+FFFD candidate', () => {
  const root = makeTempDir()
  const dir = join(root, 'skills')
  try {
    writeInvalidUtf8Skill(join(dir, 'broken'), 'broken', 'Broken skill')
    writeSkill(join(dir, 'alpha'), 'alpha', 'Alpha skill', 'Alpha body')

    const { skills, skips } = readSkips(dir)

    assert.deepEqual(skills.map((skill) => skill.name), ['alpha'], 'no candidate is emitted from invalid bytes')
    const broken = skips.find((skip) => skip.entryName === 'broken')
    assert.ok(broken, 'the invalid file is reported: ' + JSON.stringify(skips))
    assert.equal(
      broken.reason,
      'invalid-utf8',
      'invalid UTF-8 has its own reason: ' + JSON.stringify(skips),
    )
    assert.ok(
      !JSON.stringify(skips).includes(REPLACEMENT),
      'no replacement character leaks into the diagnostics: ' + JSON.stringify(skips),
    )
  } finally {
    cleanup(root)
  }
})

test('D: provider.get returns undefined and warns for an invalid-UTF-8 body, never serving U+FFFD', async () => {
  const root = makeTempDir()
  const dir = join(root, 'skills')
  const skillDir = join(dir, 'broken')
  try {
    writeInvalidUtf8Skill(skillDir, 'broken', 'Broken skill')
    const warns = []
    const provider = createSkillsProvider(
      { skillsDir: dir, providerName: 'superpowers', rank: 600 },
      { warn: (message) => warns.push(message) },
    )

    assert.deepEqual(await provider.list({}), [], 'the invalid entry never enters the catalog')

    const candidate = {
      name: 'broken',
      description: 'Broken skill',
      path: join(skillDir, 'SKILL.md'),
      locator: skillDir,
    }
    const definition = await provider.get(candidate, {})

    assert.equal(definition, undefined, 'an invalid body is never served')
    assert.ok(
      warns.some((message) => message.includes(candidate.path)),
      'the warning names the SKILL.md path: ' + JSON.stringify(warns),
    )
    assert.ok(
      !JSON.stringify(warns).includes(REPLACEMENT),
      'no U+FFFD leaks out through the diagnostics: ' + JSON.stringify(warns),
    )
  } finally {
    cleanup(root)
  }
})

test('D: an invalid-UTF-8 bootstrap reports an anomaly and composes null text', () => {
  const root = makeTempDir()
  const skillsDir = join(root, 'skills')
  const usingDir = join(skillsDir, 'using-superpowers')
  try {
    writeInvalidUtf8Skill(usingDir, 'using-superpowers', 'x')
    const mapping = join(root, 'dsh-tools.md')
    writeFileSync(mapping, 'MAPPING-BODY')

    assert.equal(composeBootstrap(skillsDir, mapping), null, 'invalid bytes compose no text')

    const warns = []
    const provider = createBootstrapProvider({ skillsDir, toolMappingPath: mapping }, (message) => warns.push(message))
    assert.equal(provider({}), '', 'the provider contributes no text')
    const reported = warns.find((message) => message.includes('no bootstrap'))
    assert.ok(reported, 'the anomaly is reported: ' + JSON.stringify(warns))
    assert.ok(
      reported.includes('unreadable ' + join(usingDir, 'SKILL.md')),
      'the invalid bootstrap is reported as unreadable with its path: ' + reported,
    )
    assert.ok(!reported.includes('missing'), 'an existing invalid file is never reported as missing: ' + reported)
    assert.ok(
      !JSON.stringify(warns).includes(REPLACEMENT),
      'no U+FFFD leaks into the diagnostics: ' + JSON.stringify(warns),
    )
  } finally {
    cleanup(root)
  }
})

// ------------------------------------------------------------------ E

test('E: control characters in a skill entry name are escaped, never forged into the warning line', async () => {
  const root = makeTempDir()
  const skillsDir = join(root, 'skills')
  const forged = 'dsh-superpowers: FORGED LINE'
  const evilName = 'evil' + LF + forged + ESC + '[31mred' + BIDI_OVERRIDE + 'gnp.exe'
  try {
    // No SKILL.md, so the entry is skipped and named in a warning.
    mkdirSync(join(skillsDir, evilName), { recursive: true })
    const warns = []
    const provider = createSkillsProvider(
      { skillsDir, providerName: 'superpowers', rank: 600 },
      { warn: (message) => warns.push(message) },
    )

    await provider.list({})

    const reported = warns.filter((message) => message.includes('skipped skill entry'))
    assert.equal(reported.length, 1, 'the hostile entry is reported once: ' + JSON.stringify(warns))
    const line = reported[0]

    assert.doesNotMatch(line, CONTROL, 'no raw control character reaches the warning line: ' + JSON.stringify(line))
    assert.equal(line.split(LF).length, 1, 'the warning stays exactly one line')
    assert.ok(line.includes('FORGED'), 'the entry name stays identifiable after escaping: ' + line)
    assert.ok(
      !new RegExp('^' + forged.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'm').test(line),
      'the forged text never starts a line: ' + JSON.stringify(line),
    )
    assert.ok(
      line.includes(BACKSLASH),
      'the control characters are escaped with a backslash rather than silently dropped: ' + JSON.stringify(line),
    )
    // Round 2: bidi formatting controls are escaped too, so a right-to-left
    // override cannot reorder a diagnostic line.
    assert.ok(!line.includes(BIDI_OVERRIDE), 'the right-to-left override is escaped: ' + JSON.stringify(line))
    assert.ok(line.includes(ESCAPED_BIDI), 'the bidi override is escaped in unicode form: ' + JSON.stringify(line))
    assert.ok(line.includes('gnp.exe'), 'the filename after the override stays identifiable: ' + line)
  } finally {
    cleanup(root)
  }
})

// ------------------------------------------------------------------ R1 (round 2)

/** A provider over an empty tree whose warnings are collected. */
function makeWarnProvider(root) {
  const warns = []
  const provider = createSkillsProvider(
    { skillsDir: join(root, 'skills'), providerName: 'superpowers', rank: 600 },
    { warn: (message) => warns.push(message) },
  )
  return { provider, warns }
}

test('R1: provider.get escapes a newline-bearing candidate path in its warning', async () => {
  const root = makeTempDir()
  try {
    const { provider, warns } = makeWarnProvider(root)
    // A missing body whose path carries a newline and an ESC sequence.
    const evilPath = join(root, 'missing', 'evil' + LF + 'dsh-superpowers: FORGED' + ESC + '[31m', 'SKILL.md')
    const candidate = { name: 'evil', description: 'x', path: evilPath, locator: join(root, 'missing') }

    const definition = await provider.get(candidate, {})

    assert.equal(definition, undefined, 'a missing body is never served')
    const reported = warns.filter((message) => message.includes('skill body'))
    assert.equal(reported.length, 1, 'exactly one body warning: ' + JSON.stringify(warns))
    const line = reported[0]
    assert.doesNotMatch(line, CONTROL, 'no raw control character reaches the warning: ' + JSON.stringify(line))
    assert.equal(line.split(LF).length, 1, 'the warning stays one line')
    assert.ok(line.includes(ESCAPED_NEWLINE), 'the newline is escaped, not dropped: ' + JSON.stringify(line))
    assert.ok(line.includes('evil') && line.includes('FORGED'), 'the path stays identifiable after escaping: ' + line)
  } finally {
    cleanup(root)
  }
})

test('R1: provider.get catches a throwing path getter and escapes its newline-bearing error', async () => {
  const root = makeTempDir()
  try {
    const { provider, warns } = makeWarnProvider(root)
    const candidate = {
      name: 'hostile',
      locator: join(root, 'skills', 'hostile'),
      get path() {
        throw new Error('path getter exploded' + LF + 'dsh-superpowers: FORGED')
      },
    }

    const definition = await provider.get(candidate, {})

    assert.equal(definition, undefined, 'a hostile candidate is contained, not served')
    const reported = warns.filter((message) => message.includes('failed to load skill body'))
    assert.equal(reported.length, 1, 'exactly one catch-all warning: ' + JSON.stringify(warns))
    const line = reported[0]
    assert.doesNotMatch(line, CONTROL, 'no raw control character reaches the warning: ' + JSON.stringify(line))
    assert.equal(line.split(LF).length, 1, 'the warning stays one line')
    assert.ok(line.includes(ESCAPED_NEWLINE), 'the error newline is escaped: ' + JSON.stringify(line))
    assert.ok(line.includes('path getter exploded'), 'the cause stays identifiable: ' + line)
    assert.ok(!new RegExp('^dsh-superpowers: FORGED', 'm').test(line), 'the forged text never starts a line')
  } finally {
    cleanup(root)
  }
})

test('R1: apply() escapes a newline-bearing skillsDir in its info line', () => {
  const root = makeTempDir()
  try {
    const skillsDir = join(root, 'skills' + LF + 'dsh-superpowers: FORGED' + ESC + '[31m')
    const infos = []
    const ctx = {
      logger: { info: (message) => infos.push(message), warn: () => {} },
      skills: { registerProvider: () => {} },
      systemPrompt: { section: () => () => {} },
      effect: (fn) => { const disposer = fn(); return () => { if (disposer) disposer() } },
    }

    apply(ctx, { skillsDir, toolMappingPath: join(root, 'missing-tools.md') })

    const reported = infos.filter((message) => message.includes('skillsDir='))
    assert.equal(reported.length, 1, 'the info line is emitted once: ' + JSON.stringify(infos))
    const line = reported[0]
    assert.doesNotMatch(line, CONTROL, 'no raw control character reaches the info line: ' + JSON.stringify(line))
    assert.equal(line.split(LF).length, 1, 'the info line stays one line')
    assert.ok(line.includes(ESCAPED_NEWLINE), 'the config newline is escaped: ' + JSON.stringify(line))
    assert.ok(line.includes('dsh-superpowers: FORGED'), 'the forged text stays identifiable, only escaped: ' + line)
  } finally {
    cleanup(root)
  }
})
