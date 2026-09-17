/**
 * Hardening tests for the frozen contract items H1..H10 (lib/index.js) plus
 * the clean-tree invariant I1. Owned by test author A.
 *
 * TDD RED phase: each test asserts behaviour the frozen contract requires.
 * Tests that already pass today are deliberate regression tripwires.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  composeBootstrap,
  createBootstrapProvider,
  createSkillsProvider,
  discoverSkills,
  parseFrontmatter,
  resolveConfig,
  DEFAULT_TOOL_MAPPING,
  PLUGIN_DIR,
} from '../lib/index.js'

const LF = String.fromCharCode(10)
const BS = String.fromCharCode(92)
const OPEN_TAG = '<EXTREMELY_IMPORTANT>'
const CLOSE_TAG = '</EXTREMELY_IMPORTANT>'
const OPEN_ESC = '<' + BS + 'EXTREMELY_IMPORTANT>'
const CLOSE_ESC = '<' + BS + '/EXTREMELY_IMPORTANT>'
const OPEN_HYPHEN = '<EXTREMELY-IMPORTANT>'
const CLOSE_HYPHEN = '</EXTREMELY-IMPORTANT>'
const BRACE_ESC = BS + '{' + BS + '{'

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-sp-hardening-'))
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1
}

function writeSkill(dir, name, description, body) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---' + LF + 'name: ' + name + LF + 'description: ' + description + LF + '---' + LF + body + LF)
}

function makeCtx(overrides) {
  const sections = []
  const warns = []
  const infos = []
  const ctx = {
    logger: { warn: (message) => warns.push(message), info: (message) => infos.push(message) },
    skills: { registerProvider: () => {} },
    systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
    effect: (fn) => { const disposer = fn(); return () => { if (disposer) disposer() } },
    ...(overrides || {}),
  }
  return { ctx, sections, warns, infos }
}

// ---------------------------------------------------------------- H1

test('H1: apply() survives a hostile raw config (throwing getter and throwing proxy)', () => {
  const hostileGetter = {}
  Object.defineProperty(hostileGetter, 'skillsDir', {
    enumerable: true,
    get() { throw new Error('hostile config getter') },
  })
  const hostileProxy = new Proxy({}, {
    get() { throw new Error('hostile config proxy') },
    has() { throw new Error('hostile config proxy') },
  })
  const { ctx } = makeCtx()
  assert.doesNotThrow(() => apply(ctx, hostileGetter))
  assert.doesNotThrow(() => apply(ctx, hostileProxy))
})

test('H1: apply() survives a ctx.logger getter that throws', () => {
  const ctx = {
    get logger() { throw new Error('hostile logger getter') },
    skills: { registerProvider: () => {} },
    systemPrompt: { section: () => () => {} },
    effect: (fn) => fn(),
  }
  assert.doesNotThrow(() => apply(ctx, {}))
})

test('H1: apply() survives a logger.warn that throws', () => {
  const ctx = {
    logger: { warn() { throw new Error('warn exploded') }, info() {} },
    skills: { registerProvider: () => {} },
    // systemPrompt seam deliberately absent so the unavailable-seam warning fires
    effect: (fn) => fn(),
  }
  assert.doesNotThrow(() => apply(ctx, {}))
})

test('H1: apply() survives a logger.info that throws', () => {
  const ctx = {
    logger: { warn() {}, info() { throw new Error('info exploded') } },
    skills: { registerProvider: () => {} },
    systemPrompt: { section: () => () => {} },
    effect: (fn) => fn(),
  }
  assert.doesNotThrow(() => apply(ctx, {}))
})

test('H1: apply() survives throwing skills, systemPrompt and effect seams', () => {
  const logger = { warn() {}, info() {} }
  assert.doesNotThrow(() => apply({
    logger,
    skills: { registerProvider() { throw new Error('registerProvider exploded') } },
    systemPrompt: { section: () => () => {} },
    effect: (fn) => fn(),
  }, {}))
  assert.doesNotThrow(() => apply({
    logger,
    skills: { registerProvider: () => {} },
    systemPrompt: { section() { throw new Error('section exploded') } },
    effect: (fn) => fn(),
  }, {}))
  assert.doesNotThrow(() => apply({
    logger,
    skills: { registerProvider: () => {} },
    systemPrompt: { section: () => () => {} },
    effect() { throw new Error('effect exploded') },
  }, {}))
})

test('H1: apply() survives undefined, null, empty and frozen ctx', () => {
  assert.doesNotThrow(() => apply(undefined, {}))
  assert.doesNotThrow(() => apply(null, {}))
  assert.doesNotThrow(() => apply({}, {}))
  const { ctx } = makeCtx()
  assert.doesNotThrow(() => apply(Object.freeze(ctx), {}))
})

// ---------------------------------------------------------------- H2

test('H2: createBootstrapProvider never throws with a throwing warn sink (missing tree)', () => {
  const root = makeTempDir()
  try {
    const boom = () => { throw new Error('warn sink exploded') }
    const provider = createBootstrapProvider(
      { skillsDir: join(root, 'missing-skills'), toolMappingPath: join(root, 'missing-tools.md') },
      boom,
    )
    assert.equal(provider({}), '')
    assert.equal(provider({}), '')
    assert.equal(provider({}), '')
  } finally {
    cleanup(root)
  }
})

test('H2: createBootstrapProvider never throws with a throwing warn sink (composition failure)', () => {
  const boom = () => { throw new Error('warn sink exploded') }
  const provider = createBootstrapProvider({ skillsDir: null, toolMappingPath: null }, boom)
  assert.equal(provider({}), '')
  assert.equal(provider({}), '')
})

test('H2: createSkillsProvider list/get never throw with a throwing warn sink', async () => {
  const root = makeTempDir()
  try {
    const boom = () => { throw new Error('warn sink exploded') }
    const provider = createSkillsProvider(
      { skillsDir: join(root, 'missing-skills'), providerName: 'superpowers', rank: 600 },
      { warn: boom },
    )
    assert.deepEqual(await provider.list({}), [])
    assert.deepEqual(await provider.list({}), [])
    assert.equal(await provider.get({
      path: join(root, 'missing-skills', 'alpha', 'SKILL.md'),
      locator: join(root, 'missing-skills', 'alpha'),
    }, {}), undefined)
  } finally {
    cleanup(root)
  }
})

// ---------------------------------------------------------------- H3

function makeSkipTree() {
  const root = makeTempDir()
  const dir = join(root, 'skills')
  mkdirSync(dir, { recursive: true })
  writeSkill(join(dir, 'alpha'), 'alpha', 'Alpha skill', 'Alpha body')
  mkdirSync(join(dir, 'no-md'), { recursive: true })
  writeSkill(join(dir, 'nodesc'), 'nodesc', '', 'Body')
  writeFileSync(join(dir, 'nodesc', 'SKILL.md'), '---' + LF + 'name: nodesc' + LF + '---' + LF + 'Body' + LF)
  writeSkill(join(dir, 'Bad_Name'), 'Bad_Name', 'Bad name', 'Body')
  writeFileSync(join(dir, 'loose.txt'), 'not a skill directory')
  writeSkill(join(dir, '.hidden'), 'hidden', 'Hidden skill', 'Body')
  return { root, dir }
}

test('H3: discoverSkills reports every skipped entry with its documented reason', () => {
  const { root, dir } = makeSkipTree()
  try {
    const skips = []
    const skills = discoverSkills(dir, 'superpowers', 600, (reason, entryName) => skips.push(reason + ':' + entryName))

    assert.deepEqual(skills.map((skill) => skill.name), ['alpha'])
    assert.ok(skips.includes('missing-skill-md:no-md'), 'missing SKILL.md reported: ' + JSON.stringify(skips))
    assert.ok(skips.includes('empty-description:nodesc'), 'blank description reported: ' + JSON.stringify(skips))
    assert.ok(skips.includes('invalid-name:Bad_Name'), 'invalid name reported: ' + JSON.stringify(skips))
    assert.ok(skips.includes('not-a-directory:loose.txt'), 'non-directory reported: ' + JSON.stringify(skips))
    assert.ok(!skips.some((skip) => skip.includes('.hidden')), 'hidden entries are not reported: ' + JSON.stringify(skips))
  } finally {
    cleanup(root)
  }
})

test('H3: the 3-argument discoverSkills call still returns the same sorted array', () => {
  const { root, dir } = makeSkipTree()
  try {
    const three = discoverSkills(dir, 'superpowers', 600)
    const four = discoverSkills(dir, 'superpowers', 600, () => {})
    assert.deepEqual(four, three)
    assert.deepEqual(three.map((skill) => skill.name), three.map((skill) => skill.name).sort())
    assert.ok(three.length >= 1, 'valid skills still discovered')
  } finally {
    cleanup(root)
  }
})

test('H3: a symlinked skill directory is reported as not-a-directory', () => {
  const root = makeTempDir()
  try {
    const dir = join(root, 'skills')
    mkdirSync(dir, { recursive: true })
    writeSkill(join(root, 'real', 'alpha'), 'alpha', 'Alpha skill', 'Alpha body')
    symlinkSync(join(root, 'real', 'alpha'), join(dir, 'linked-alpha'))
    const skips = []
    const skills = discoverSkills(dir, 'superpowers', 600, (reason, entryName) => skips.push(reason + ':' + entryName))
    assert.deepEqual(skills, [])
    assert.ok(skips.includes('not-a-directory:linked-alpha'), 'symlinked dir reported: ' + JSON.stringify(skips))
  } finally {
    cleanup(root)
  }
})

test('H3: createSkillsProvider.list surfaces skips through warn, deduplicated per reason and name', async () => {
  const { root, dir } = makeSkipTree()
  try {
    const warns = []
    const provider = createSkillsProvider(
      { skillsDir: dir, providerName: 'superpowers', rank: 600 },
      { warn: (message) => warns.push(message) },
    )
    const first = await provider.list({})
    const second = await provider.list({})

    assert.deepEqual(first.map((skill) => skill.name), ['alpha'])
    assert.deepEqual(second.map((skill) => skill.name), ['alpha'])
    assert.deepEqual(first, discoverSkills(dir, 'superpowers', 600))
    const reported = warns.filter((message) => message.includes('missing-skill-md') && message.includes('no-md'))
    assert.equal(reported.length, 1, 'skip warning deduplicated per reason+name: ' + JSON.stringify(warns))
  } finally {
    cleanup(root)
  }
})

// ---------------------------------------------------------------- H4

test('H4: composeBootstrap neutralizes the wrapper tags in the body and the mapping', () => {
  const root = makeTempDir()
  try {
    const skillsDir = join(root, 'skills')
    const body = [
      'Body says ' + OPEN_TAG + ' and then ' + CLOSE_TAG + '.',
      'Hyphenated ' + OPEN_HYPHEN + ' and ' + CLOSE_HYPHEN + ' must survive.',
    ].join(LF)
    writeSkill(join(skillsDir, 'using-superpowers'), 'using-superpowers', 'x', body)
    const mapping = join(root, 'dsh-tools.md')
    writeFileSync(mapping, [
      'Mapping says ' + OPEN_TAG + ' and ' + CLOSE_TAG + '.',
      'Hyphenated ' + OPEN_HYPHEN + ' and ' + CLOSE_HYPHEN + ' must survive.',
    ].join(LF))

    const text = composeBootstrap(skillsDir, mapping)

    assert.equal(typeof text, 'string')
    assert.ok(text.includes(OPEN_ESC), 'open wrapper tag neutralized in body and mapping')
    assert.ok(text.includes(CLOSE_ESC), 'close wrapper tag neutralized in body and mapping')
    assert.ok(text.includes(OPEN_HYPHEN), 'hyphenated upstream open token untouched')
    assert.ok(text.includes(CLOSE_HYPHEN), 'hyphenated upstream close token untouched')
    assert.equal(count(text, OPEN_TAG), 1, 'exactly one open wrapper tag in the composed output')
    assert.equal(count(text, CLOSE_TAG), 1, 'exactly one close wrapper tag in the composed output')
  } finally {
    cleanup(root)
  }
})

// ---------------------------------------------------------------- H5

test('H5: composeBootstrap neutralizes strict template groups in the body and the mapping', () => {
  const root = makeTempDir()
  try {
    const skillsDir = join(root, 'skills')
    writeSkill(join(skillsDir, 'using-superpowers'), 'using-superpowers', 'x', 'Body uses {{title}} and {{body}}.')
    const mapping = join(root, 'dsh-tools.md')
    writeFileSync(mapping, 'Mapping uses {{tool}} too.')

    const text = composeBootstrap(skillsDir, mapping)

    assert.equal(typeof text, 'string')
    assert.ok(!text.includes('{{'), 'no strict template group survives')
    assert.ok(text.includes(BRACE_ESC + 'title}}'), 'body group escaped')
    assert.ok(text.includes(BRACE_ESC + 'tool}}'), 'mapping group escaped')
  } finally {
    cleanup(root)
  }
})

// ---------------------------------------------------------------- H6

test('H6: consecutive failing assemblies warn exactly once', () => {
  const root = makeTempDir()
  try {
    const warns = []
    const provider = createBootstrapProvider(
      { skillsDir: join(root, 'missing-skills'), toolMappingPath: join(root, 'missing-tools.md') },
      (message) => warns.push(message),
    )
    assert.equal(provider({}), '')
    assert.equal(provider({}), '')
    assert.equal(provider({}), '')
    assert.equal(warns.filter((message) => message.includes('no bootstrap')).length, 1)
  } finally {
    cleanup(root)
  }
})

test('H6: a failure that recovers and fails again warns a second time', () => {
  const root = makeTempDir()
  try {
    const skillsDir = join(root, 'skills')
    const warns = []
    const provider = createBootstrapProvider(
      { skillsDir, toolMappingPath: join(root, 'missing-tools.md') },
      (message) => warns.push(message),
    )
    assert.equal(provider({}), '')
    assert.equal(warns.filter((message) => message.includes('no bootstrap')).length, 1)

    writeSkill(join(skillsDir, 'using-superpowers'), 'using-superpowers', 'x', 'HEALED-BODY')
    assert.ok(provider({}).includes('HEALED-BODY'), 'provider self-heals')

    cleanup(skillsDir)
    assert.equal(provider({}), '')
    assert.equal(
      warns.filter((message) => message.includes('no bootstrap')).length,
      2,
      'warning re-emitted after recovery: ' + JSON.stringify(warns),
    )
  } finally {
    cleanup(root)
  }
})

test('H6: each distinct skills-tree anomaly warns on its own, once', async () => {
  const root = makeTempDir()
  try {
    const skillsDir = join(root, 'skills')
    const warns = []
    const provider = createSkillsProvider(
      { skillsDir, providerName: 'superpowers', rank: 600 },
      { warn: (message) => warns.push(message) },
    )

    assert.deepEqual(await provider.list({}), [])
    assert.equal(warns.length, 1, 'missing tree warns once')

    mkdirSync(skillsDir, { recursive: true })
    assert.deepEqual(await provider.list({}), [])
    assert.equal(warns.length, 2, 'a second, distinct anomaly warns on its own: ' + JSON.stringify(warns))
    assert.notEqual(warns[0], warns[1], 'the two anomalies produce distinct messages')

    await provider.list({})
    await provider.list({})
    assert.equal(warns.length, 2, 'each distinct anomaly is deduplicated: ' + JSON.stringify(warns))
  } finally {
    cleanup(root)
  }
})

test('H6: a skills-tree anomaly warns once, and again after it clears and reappears', async () => {
  const root = makeTempDir()
  try {
    const skillsDir = join(root, 'skills')
    const warns = []
    const provider = createSkillsProvider(
      { skillsDir, providerName: 'superpowers', rank: 600 },
      { warn: (message) => warns.push(message) },
    )

    await provider.list({})
    await provider.list({})
    await provider.list({})
    assert.equal(warns.length, 1, 'persistent anomaly warns once')

    mkdirSync(skillsDir, { recursive: true })
    writeSkill(join(skillsDir, 'alpha'), 'alpha', 'Alpha skill', 'Alpha body')
    assert.deepEqual((await provider.list({})).map((skill) => skill.name), ['alpha'])
    assert.equal(warns.length, 1, 'the cleared anomaly does not re-warn while healthy')

    cleanup(skillsDir)
    assert.deepEqual(await provider.list({}), [])
    assert.equal(warns.length, 2, 'the anomalously-missing tree warns again after recovery: ' + JSON.stringify(warns))
  } finally {
    cleanup(root)
  }
})

// ---------------------------------------------------------------- H7

test('H7: provider.get() treats an empty SKILL.md body as unreadable and warns', async () => {
  const root = makeTempDir()
  try {
    const dir = join(root, 'skills')
    mkdirSync(join(dir, 'alpha'), { recursive: true })
    writeFileSync(join(dir, 'alpha', 'SKILL.md'), '---' + LF + 'name: alpha' + LF + 'description: Alpha skill' + LF + '---' + LF + '   ' + LF)
    const warns = []
    const provider = createSkillsProvider(
      { skillsDir: dir, providerName: 'superpowers', rank: 600 },
      { warn: (message) => warns.push(message) },
    )
    const candidate = (await provider.list({})).find((skill) => skill.name === 'alpha')
    assert.ok(candidate, 'the candidate is still discovered')

    const definition = await provider.get(candidate, {})

    assert.equal(definition, undefined, 'an empty body is never served')
    assert.ok(
      warns.some((message) => message.includes(candidate.path)),
      'the warning names the SKILL.md path: ' + JSON.stringify(warns),
    )
  } finally {
    cleanup(root)
  }
})

test('H7: composeBootstrap returns null for an empty using-superpowers body', () => {
  const root = makeTempDir()
  try {
    const skillsDir = join(root, 'skills')
    writeSkill(join(skillsDir, 'using-superpowers'), 'using-superpowers', 'x', '   ')
    const mapping = join(root, 'dsh-tools.md')
    writeFileSync(mapping, 'MAPPING-BODY')

    assert.equal(composeBootstrap(skillsDir, mapping), null, 'empty body is not composed')

    const warns = []
    const provider = createBootstrapProvider({ skillsDir, toolMappingPath: mapping }, (message) => warns.push(message))
    assert.equal(provider({}), '', 'the provider contributes no text')
    assert.ok(warns.length >= 1, 'the empty body is reported: ' + JSON.stringify(warns))
  } finally {
    cleanup(root)
  }
})

// ---------------------------------------------------------------- H8

test('H8: quoted true/false stay strings while unquoted values stay boolean', () => {
  const text = [
    '---',
    'name: alpha',
    'description: "false"',
    'whenToUse: true',
    'quotedTrue: "true"',
    "quotedFalse: 'false'",
    '---',
    'Body',
    '',
  ].join(LF)

  const { data } = parseFrontmatter(text)

  assert.equal(typeof data.description, 'string', 'quoted "false" is a string, not a boolean')
  assert.equal(data.description, 'false')
  assert.equal(data.quotedTrue, 'true')
  assert.equal(data.quotedFalse, 'false')
  assert.equal(data.whenToUse, true)
  assert.equal(typeof data.whenToUse, 'boolean')
})

test('H8: a skill whose quoted description is "false" is catalogued', () => {
  const root = makeTempDir()
  try {
    const dir = join(root, 'skills')
    writeSkill(join(dir, 'quoted'), 'quoted', '"false"', 'Body')
    const skills = discoverSkills(dir, 'superpowers', 600)
    assert.deepEqual(skills.map((skill) => skill.name), ['quoted'])
    assert.equal(skills[0].description, 'false')
  } finally {
    cleanup(root)
  }
})

// ---------------------------------------------------------------- H9

test('H9: composeBootstrap returns null and never throws for a non-string skillsDir', () => {
  const root = makeTempDir()
  try {
    const mapping = join(root, 'dsh-tools.md')
    writeFileSync(mapping, 'MAPPING-BODY')
    for (const bad of [undefined, null, 42, {}, []]) {
      let text
      assert.doesNotThrow(() => { text = composeBootstrap(bad, mapping) }, 'no throw for skillsDir ' + String(bad))
      assert.equal(text, null, 'null for skillsDir ' + String(bad))
    }
  } finally {
    cleanup(root)
  }
})

test('H9: composeBootstrap falls back to DEFAULT_TOOL_MAPPING for a non-string mapping path', () => {
  const root = makeTempDir()
  try {
    const skillsDir = join(root, 'skills')
    writeSkill(join(skillsDir, 'using-superpowers'), 'using-superpowers', 'x', 'BODY-FALLBACK')
    for (const bad of [undefined, null, 42, {}]) {
      let text
      assert.doesNotThrow(() => { text = composeBootstrap(skillsDir, bad) }, 'no throw for mapping ' + String(bad))
      assert.equal(typeof text, 'string', 'composed for mapping ' + String(bad))
      assert.ok(text.includes(DEFAULT_TOOL_MAPPING), 'built-in mapping used for ' + String(bad))
    }
  } finally {
    cleanup(root)
  }
})

test('H9: createBootstrapProvider(null) constructs without throwing and warns about composition failure', () => {
  for (const bad of [null, undefined]) {
    assert.doesNotThrow(() => createBootstrapProvider(bad), 'construction must not throw for ' + String(bad))
  }
  const warns = []
  const provider = createBootstrapProvider(null, (message) => warns.push(message))
  assert.equal(provider({}), '')
  assert.equal(provider({}), '')
  assert.ok(
    warns.some((message) => message.includes('bootstrap composition failed')),
    'I3 composition-failure message: ' + JSON.stringify(warns),
  )
})

// ---------------------------------------------------------------- H10

test('H10: relative config overrides resolve against pluginDir', () => {
  const config = resolveConfig({ skillsDir: 'rel/skills', toolMappingPath: 'rel/dsh-tools.md' }, '/opt/plug')
  assert.equal(config.skillsDir, join('/opt/plug', 'rel', 'skills'))
  assert.equal(config.toolMappingPath, join('/opt/plug', 'rel', 'dsh-tools.md'))
})

test('H10: absolute config overrides are unaffected', () => {
  const config = resolveConfig({ skillsDir: '/var/skills', toolMappingPath: '/var/dsh-tools.md' }, '/opt/plug')
  assert.equal(config.skillsDir, '/var/skills')
  assert.equal(config.toolMappingPath, '/var/dsh-tools.md')
})

// ---------------------------------------------------------------- I1

test('I1: the real vendor tree still composes byte-identically with the frozen sha256', () => {
  const config = resolveConfig({}, PLUGIN_DIR)
  const text = composeBootstrap(config.skillsDir, config.toolMappingPath)

  assert.equal(typeof text, 'string', 'the real vendor tree composes')
  assert.equal(text.length, 4119, 'frozen composed length')
  assert.equal(
    createHash('sha256').update(text, 'utf8').digest('hex'),
    '6808dd5eceb0ec44468d2770d39273c5ca3437800ed2c5bedab61001f4da4441',
    'clean-tree sanitising must be a no-op',
  )
  assert.equal(count(text, OPEN_TAG), 1, 'exactly one open wrapper tag in the clean tree')
  assert.equal(count(text, CLOSE_TAG), 1, 'exactly one close wrapper tag in the clean tree')
  assert.ok(!text.includes('{{'), 'no strict template group in the clean tree')

  const { ctx, sections } = makeCtx()
  apply(ctx, {})
  assert.equal(sections.length, 1, 'bootstrap section registered')
  assert.deepEqual(Buffer.from(sections[0].text({}), 'utf8'), Buffer.from(text, 'utf8'), 'section text is byte-identical to composeBootstrap')
})

// ------------------------------------------------ fix round 1 (H5 / H4)

test('H5: odd-length brace runs leave no strict template group behind', () => {
  const root = makeTempDir()
  try {
    const skillsDir = join(root, 'skills')
    const mapping = join(root, 'dsh-tools.md')
    writeFileSync(mapping, 'MAPPING-BODY')
    for (const run of ['{{{y}}}', '{{{{z}}}}']) {
      writeSkill(join(skillsDir, 'using-superpowers'), 'using-superpowers', 'x', 'Body uses ' + run + '.')
      const text = composeBootstrap(skillsDir, mapping)
      assert.equal(typeof text, 'string', 'composed for ' + run)
      assert.ok(text.includes('Body uses'), 'body preserved for ' + run)
      assert.ok(!text.includes('{{'), 'no strict template group survives ' + run + ': ' + JSON.stringify(text))
    }
  } finally {
    cleanup(root)
  }
})

test('H4: a skillsDir containing the close wrapper tag is neutralized and reported', () => {
  const root = makeTempDir()
  try {
    const skillsDir = join(root, 'skills' + CLOSE_TAG)
    writeSkill(join(skillsDir, 'using-superpowers'), 'using-superpowers', 'x', 'BODY-TAGGED-PATH')
    const mapping = join(root, 'dsh-tools.md')
    writeFileSync(mapping, 'MAPPING-BODY')

    const text = composeBootstrap(skillsDir, mapping)

    assert.equal(typeof text, 'string')
    assert.ok(text.includes(CLOSE_ESC), 'the interpolated path is neutralized')
    assert.equal(count(text, OPEN_TAG), 1, 'exactly one open wrapper tag')
    assert.equal(count(text, CLOSE_TAG), 1, 'exactly one close wrapper tag')

    const warns = []
    const provider = createBootstrapProvider({ skillsDir, toolMappingPath: mapping }, (message) => warns.push(message))
    assert.equal(provider({}), text, 'provider serves the composed text')
    assert.ok(
      warns.some((message) => message.includes('neutralized') && message.includes('EXTREMELY_IMPORTANT')),
      'the neutralization is reported: ' + JSON.stringify(warns),
    )
  } finally {
    cleanup(root)
  }
})

// ------------------------------- coverage round 2 (reviewer N3: a / b / c)

test('H5: brace runs in the mapping text leave no strict template group behind', () => {
  const root = makeTempDir()
  try {
    const skillsDir = join(root, 'skills')
    writeSkill(join(skillsDir, 'using-superpowers'), 'using-superpowers', 'x', 'BODY-CLEAN')
    const mapping = join(root, 'dsh-tools.md')
    writeFileSync(mapping, 'MAPPING-BRACE-RUN ' + '{{{{m}}}}')

    const text = composeBootstrap(skillsDir, mapping)

    assert.equal(typeof text, 'string', 'composed with a brace run in the mapping')
    assert.ok(!text.includes('{{'), 'no strict template group survives the mapping: ' + JSON.stringify(text))
    assert.ok(text.includes('m}}}}'), 'the mapping text itself still reaches the bootstrap')

    const warns = []
    const provider = createBootstrapProvider({ skillsDir, toolMappingPath: mapping }, (message) => warns.push(message))
    assert.equal(provider({}), text, 'provider serves the composed text')
    assert.ok(
      warns.some((message) => message.includes('neutralized') && message.includes('{{')),
      'the mapping neutralization is reported: ' + JSON.stringify(warns),
    )
  } finally {
    cleanup(root)
  }
})

test('H5: a skillsDir containing a brace run is neutralized and reported', () => {
  const root = makeTempDir()
  try {
    const skillsDir = join(root, 'skills{{{{b}}}}')
    writeSkill(join(skillsDir, 'using-superpowers'), 'using-superpowers', 'x', 'BRACE-PATH-BODY')
    const mapping = join(root, 'dsh-tools.md')
    writeFileSync(mapping, 'MAPPING-BODY')

    const text = composeBootstrap(skillsDir, mapping)

    assert.equal(typeof text, 'string', 'composed with a brace run in skillsDir')
    assert.ok(!text.includes('{{'), 'no strict template group survives the skillsDir: ' + JSON.stringify(text))
    assert.equal(count(text, OPEN_TAG), 1, 'exactly one open wrapper tag')
    assert.equal(count(text, CLOSE_TAG), 1, 'exactly one close wrapper tag')

    const warns = []
    const provider = createBootstrapProvider({ skillsDir, toolMappingPath: mapping }, (message) => warns.push(message))
    assert.equal(provider({}), text, 'provider serves the composed text')
    assert.ok(
      warns.some((message) => message.includes('neutralized') && message.includes('{{')),
      'the skillsDir neutralization is reported: ' + JSON.stringify(warns),
    )
  } finally {
    cleanup(root)
  }
})

test('H4: a skillsDir containing the open wrapper tag is neutralized and reported', () => {
  const root = makeTempDir()
  try {
    const skillsDir = join(root, 'skills' + OPEN_TAG)
    writeSkill(join(skillsDir, 'using-superpowers'), 'using-superpowers', 'x', 'TAG-PATH-BODY')
    const mapping = join(root, 'dsh-tools.md')
    writeFileSync(mapping, 'MAPPING-BODY')

    const text = composeBootstrap(skillsDir, mapping)

    assert.equal(typeof text, 'string', 'composed with the open wrapper tag in skillsDir')
    assert.ok(!text.includes('{{'), 'no strict template group survives the skillsDir: ' + JSON.stringify(text))
    assert.ok(text.includes(OPEN_ESC), 'the interpolated path is neutralized')
    assert.equal(count(text, OPEN_TAG), 1, 'exactly one open wrapper tag')
    assert.equal(count(text, CLOSE_TAG), 1, 'exactly one close wrapper tag')

    const warns = []
    const provider = createBootstrapProvider({ skillsDir, toolMappingPath: mapping }, (message) => warns.push(message))
    assert.equal(provider({}), text, 'provider serves the composed text')
    assert.ok(
      warns.some((message) => message.includes('neutralized') && message.includes('EXTREMELY_IMPORTANT')),
      'the skillsDir neutralization is reported: ' + JSON.stringify(warns),
    )
  } finally {
    cleanup(root)
  }
})
// ---------------------------------------- fix round 3 (findings A1..A5, lib/index.js)

const UPDATE_HINT = 'dsh plugin --profile web exec dsh-superpowers update-skills'

test('A1: the missing-bootstrap warning names the update-skills command', () => {
  const root = makeTempDir()
  try {
    const skillsDir = join(root, 'skills')
    const usingPath = join(skillsDir, 'using-superpowers', 'SKILL.md')
    const warns = []
    const provider = createBootstrapProvider(
      { skillsDir, toolMappingPath: join(root, 'missing-tools.md') },
      (message) => warns.push(message),
    )

    assert.equal(provider({}), '')

    const reported = warns.find((message) => message.includes('no bootstrap'))
    assert.ok(reported, 'the missing vendor is reported: ' + JSON.stringify(warns))
    assert.ok(reported.includes('missing ' + usingPath), 'the warning names the path: ' + reported)
    assert.ok(reported.includes(UPDATE_HINT), 'the warning names the update command: ' + reported)
  } finally {
    cleanup(root)
  }
})

test('A1: an existing but unreadable SKILL.md is reported as unreadable with its cause, not missing', () => {
  const root = makeTempDir()
  try {
    const skillsDir = join(root, 'skills')
    const usingPath = join(skillsDir, 'using-superpowers', 'SKILL.md')
    mkdirSync(usingPath, { recursive: true })
    const warns = []
    const provider = createBootstrapProvider(
      { skillsDir, toolMappingPath: join(root, 'missing-tools.md') },
      (message) => warns.push(message),
    )

    assert.equal(provider({}), '')

    const reported = warns.find((message) => message.includes('no bootstrap'))
    assert.ok(reported, 'the unreadable bootstrap is reported: ' + JSON.stringify(warns))
    assert.ok(reported.includes('unreadable ' + usingPath), 'the path is reported as unreadable: ' + reported)
    assert.ok(!reported.includes('missing'), 'an existing path is never reported as missing: ' + reported)
    assert.ok(reported.includes(UPDATE_HINT), 'the warning still names the update command: ' + reported)
    assert.ok(
      /EISDIR|EACCES|EPERM|ENOTDIR|illegal operation|permission denied/i.test(reported),
      'the cause is included: ' + reported,
    )
  } finally {
    cleanup(root)
  }
})

test('A2: an unreadable tool mapping warns once and falls back to the built-in mapping', () => {
  const root = makeTempDir()
  try {
    const skillsDir = join(root, 'skills')
    writeSkill(join(skillsDir, 'using-superpowers'), 'using-superpowers', 'x', 'BODY-A2')
    const mappingPath = join(root, 'missing-tools.md')
    const warns = []
    const provider = createBootstrapProvider({ skillsDir, toolMappingPath: mappingPath }, (message) => warns.push(message))

    const text = provider({})

    assert.ok(text.includes('BODY-A2'), 'the bootstrap still composes')
    assert.ok(text.includes(DEFAULT_TOOL_MAPPING), 'the built-in mapping is used')
    const reported = warns.filter((message) => message.includes('tool mapping'))
    assert.equal(reported.length, 1, 'the fallback is reported once: ' + JSON.stringify(warns))
    assert.ok(reported[0].includes('not readable at ' + mappingPath), 'the warning names the path: ' + reported[0])
    assert.ok(reported[0].includes('using the built-in mapping'), 'the warning names the fallback: ' + reported[0])

    provider({})
    provider({})
    assert.equal(warns.filter((message) => message.includes('tool mapping')).length, 1, 'deduplicated while it persists')
  } finally {
    cleanup(root)
  }
})

test('A2: an empty tool mapping warns once and falls back to the built-in mapping', () => {
  const root = makeTempDir()
  try {
    const skillsDir = join(root, 'skills')
    writeSkill(join(skillsDir, 'using-superpowers'), 'using-superpowers', 'x', 'BODY-A2')
    const mappingPath = join(root, 'dsh-tools.md')
    writeFileSync(mappingPath, '   ' + LF + LF)
    const warns = []
    const provider = createBootstrapProvider({ skillsDir, toolMappingPath: mappingPath }, (message) => warns.push(message))

    const text = provider({})

    assert.ok(text.includes(DEFAULT_TOOL_MAPPING), 'the built-in mapping is used')
    const reported = warns.filter((message) => message.includes('tool mapping'))
    assert.equal(reported.length, 1, 'the empty mapping is reported once: ' + JSON.stringify(warns))
    assert.ok(reported[0].includes('is empty at ' + mappingPath), 'the warning names the path: ' + reported[0])
    assert.ok(reported[0].includes('using the built-in mapping'), 'the warning names the fallback: ' + reported[0])
    provider({})
    assert.equal(warns.filter((message) => message.includes('tool mapping')).length, 1, 'deduplicated while it persists')
  } finally {
    cleanup(root)
  }
})

test('A3: a config row resolveConfig cannot read warns and falls back to defaults', () => {
  const hostileGetter = {}
  Object.defineProperty(hostileGetter, 'skillsDir', {
    enumerable: true,
    get() { throw new Error('hostile config getter') },
  })
  const hostileProxy = new Proxy({}, {
    get() { throw new Error('hostile config proxy') },
    has() { throw new Error('hostile config proxy') },
  })
  for (const raw of [hostileGetter, hostileProxy]) {
    const { ctx, warns, sections } = makeCtx()
    assert.doesNotThrow(() => apply(ctx, raw))
    assert.equal(sections.length, 1, 'the bootstrap section is still registered with default config')
    const reported = warns.filter((message) => message.includes('invalid config; using defaults'))
    assert.equal(reported.length, 1, 'the invalid config is reported once: ' + JSON.stringify(warns))
    assert.ok(
      reported[0].startsWith('dsh-superpowers: invalid config; using defaults ('),
      'the documented wording: ' + reported[0],
    )
    assert.ok(/hostile config (getter|proxy)/.test(reported[0]), 'the cause is included: ' + reported[0])
  }
})

test('A3: the invalid-config warning cannot escape a hostile logger getter', () => {
  const hostile = {}
  Object.defineProperty(hostile, 'toolMappingPath', {
    enumerable: true,
    get() { throw new Error('hostile config getter') },
  })
  const ctx = {
    get logger() { throw new Error('hostile logger getter') },
    skills: { registerProvider: () => {} },
    systemPrompt: { section: () => () => {} },
    effect: (fn) => fn(),
  }
  assert.doesNotThrow(() => apply(ctx, hostile))
})

test('A4: duplicate skill names warn once, deduplicated per name, and both entries are still emitted', async () => {
  const root = makeTempDir()
  try {
    const dir = join(root, 'skills')
    writeSkill(join(dir, 'alpha-one'), 'alpha', 'First alpha', 'Body one')
    writeSkill(join(dir, 'alpha-two'), 'alpha', 'Second alpha', 'Body two')
    writeSkill(join(dir, 'beta'), 'beta', 'Beta skill', 'Beta body')
    const warns = []
    const provider = createSkillsProvider(
      { skillsDir: dir, providerName: 'superpowers', rank: 600 },
      { warn: (message) => warns.push(message) },
    )

    const first = await provider.list({})
    const second = await provider.list({})

    assert.deepEqual(first.map((skill) => skill.name), ['alpha', 'alpha', 'beta'], 'both colliding entries are still emitted')
    assert.deepEqual(second, first)
    assert.deepEqual(
      warns.filter((message) => message.includes('duplicate skill name')),
      ['dsh-superpowers: duplicate skill name "alpha" (2 entries); one will be ignored'],
      'reported once, per name: ' + JSON.stringify(warns),
    )
  } finally {
    cleanup(root)
  }
})

test('A4: the real vendor tree emits no duplicate-name warning', async () => {
  const config = resolveConfig({}, PLUGIN_DIR)
  const warns = []
  const provider = createSkillsProvider(
    { skillsDir: config.skillsDir, providerName: config.providerName, rank: config.rank },
    { warn: (message) => warns.push(message) },
  )

  const skills = await provider.list({})

  assert.ok(skills.length >= 1, 'the real tree has skills')
  assert.ok(
    !warns.some((message) => message.includes('duplicate skill name')),
    'no duplicate names in the vendor tree: ' + JSON.stringify(warns),
  )
})

test('A5: an unreadable skills directory surfaces its cause through list()', async () => {
  const root = makeTempDir()
  try {
    const notADir = join(root, 'skills')
    writeFileSync(notADir, 'this is a file, not a directory')
    const warns = []
    const provider = createSkillsProvider(
      { skillsDir: notADir, providerName: 'superpowers', rank: 600 },
      { warn: (message) => warns.push(message) },
    )

    assert.deepEqual(await provider.list({}), [])
    await provider.list({})

    const reported = warns.filter((message) => message.includes('skills directory unreadable at ' + notADir))
    assert.equal(reported.length, 1, 'the cause is reported once: ' + JSON.stringify(warns))
    assert.ok(
      reported[0].startsWith('dsh-superpowers: skills directory unreadable at ' + notADir + ' ('),
      'the documented wording: ' + reported[0],
    )
    assert.ok(
      /ENOTDIR|EACCES|EPERM|not a directory|permission denied/i.test(reported[0]),
      'the cause is included: ' + reported[0],
    )
  } finally {
    cleanup(root)
  }
})

test('A5: discoverSkills reports an unreadable directory and its cause to its reporter', () => {
  const root = makeTempDir()
  try {
    const notADir = join(root, 'skills')
    writeFileSync(notADir, 'this is a file, not a directory')
    const skips = []
    const skills = discoverSkills(notADir, 'superpowers', 600, (reason, entryName, detail) => {
      skips.push({ reason, entryName, detail })
    })

    assert.deepEqual(skills, [])
    const reported = skips.find((skip) => skip.reason === 'unreadable-directory')
    assert.ok(reported, 'the unreadable directory is reported: ' + JSON.stringify(skips))
    assert.equal(reported.entryName, notADir, 'the reporter names the directory')
    assert.ok(
      typeof reported.detail === 'string' && reported.detail !== '',
      'the reporter carries the cause: ' + JSON.stringify(reported),
    )
  } finally {
    cleanup(root)
  }
})

test('A5: a permission-denied skills directory surfaces its cause', { skip: process.getuid?.() === 0 }, async () => {
  const root = makeTempDir()
  const dir = join(root, 'skills')
  try {
    mkdirSync(dir, { recursive: true })
    writeSkill(join(dir, 'alpha'), 'alpha', 'Alpha skill', 'Alpha body')
    chmodSync(dir, 0o000)
    const warns = []
    const provider = createSkillsProvider(
      { skillsDir: dir, providerName: 'superpowers', rank: 600 },
      { warn: (message) => warns.push(message) },
    )

    assert.deepEqual(await provider.list({}), [])
    assert.ok(
      warns.some(
        (message) => message.includes('skills directory unreadable at ' + dir) && /EACCES|EPERM|permission denied/i.test(message),
      ),
      'the permission failure is surfaced: ' + JSON.stringify(warns),
    )
  } finally {
    chmodSync(dir, 0o755)
    cleanup(root)
  }
})

