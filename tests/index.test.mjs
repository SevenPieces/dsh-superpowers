import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseFrontmatter,
  discoverSkills,
  loadSkillBody,
  resolveConfig,
  createSkillsProvider,
} from '../lib/index.js'

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-superpowers-'))
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

test('parseFrontmatter reads two-line name and description frontmatter', () => {
  const text = '---\nname: brainstorming\ndescription: Use when starting a new design\n---\n# Brainstorming\n\nBody text.\n'
  const { data, body } = parseFrontmatter(text)
  assert.equal(data.name, 'brainstorming')
  assert.equal(data.description, 'Use when starting a new design')
  assert.match(body, /# Brainstorming/)
  assert.doesNotMatch(body, /name: brainstorming/)
})

test('parseFrontmatter keeps a quoted description containing a colon', () => {
  const text = '---\nname: test-driven-development\ndescription: "Use when implementing: write the test first"\n---\nBody\n'
  const { data } = parseFrontmatter(text)
  assert.equal(data.description, 'Use when implementing: write the test first')
})

test('parseFrontmatter returns empty data and the whole body without frontmatter', () => {
  const text = '# No frontmatter here\n\nJust a body.\n'
  const { data, body } = parseFrontmatter(text)
  assert.deepEqual(data, {})
  assert.equal(body, text)
})

test('discoverSkills returns valid skill dirs and skips one missing a description', () => {
  const dir = makeTempDir()
  try {
    mkdirSync(join(dir, 'alpha'))
    writeFileSync(join(dir, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha skill\n---\nAlpha body\n')
    mkdirSync(join(dir, 'beta'))
    writeFileSync(join(dir, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: Beta skill\n---\nBeta body\n')
    mkdirSync(join(dir, 'broken'))
    writeFileSync(join(dir, 'broken', 'SKILL.md'), '---\nname: broken\n---\nNo description\n')

    const skills = discoverSkills(dir, 'superpowers', 600)

    assert.deepEqual(skills.map(skill => skill.name), ['alpha', 'beta'])
    const alpha = skills.find(skill => skill.name === 'alpha')
    assert.equal(alpha.description, 'Alpha skill')
    assert.equal(alpha.source, 'superpowers')
    assert.equal(alpha.provider, 'superpowers')
    assert.equal(alpha.rank, 600)
    assert.equal(alpha.locator, join(dir, 'alpha'))
    assert.equal(alpha.path, join(dir, 'alpha', 'SKILL.md'))
    assert.deepEqual(alpha.invocation, { modelInvocable: true, userInvocable: true })
  } finally {
    cleanup(dir)
  }
})

test('loadSkillBody strips frontmatter and returns undefined for a missing file', () => {
  const dir = makeTempDir()
  try {
    const file = join(dir, 'SKILL.md')
    writeFileSync(file, '---\nname: alpha\ndescription: Alpha\n---\n# Alpha\n\nBody\n')

    const body = loadSkillBody(file)

    assert.match(body, /# Alpha/)
    assert.doesNotMatch(body, /description: Alpha/)
    assert.equal(loadSkillBody(join(dir, 'missing.md')), undefined)
  } finally {
    cleanup(dir)
  }
})

test('resolveConfig applies documented defaults', () => {
  const pluginDir = '/opt/dsh-superpowers'
  const config = resolveConfig(undefined, pluginDir)

  assert.equal(config.skillsDir, join(pluginDir, 'vendor', 'superpowers', 'skills'))
  assert.equal(config.toolMappingPath, join(pluginDir, 'references', 'dsh-tools.md'))
  assert.equal(config.providerName, 'superpowers')
  assert.equal(config.rank, 600)
  assert.equal(config.injectBootstrap, true)
  assert.equal(typeof config.sectionName, 'string')
  assert.ok(config.sectionName.length > 0)
  assert.equal(config.sectionOrder, 250)
})

test('resolveConfig honors explicit overrides', () => {
  const config = resolveConfig({
    skillsDir: '/tmp/custom-skills',
    toolMappingPath: '/tmp/custom-tools.md',
    providerName: 'custom',
    rank: 12,
    sectionName: 'custom:section',
    sectionOrder: 123,
    injectBootstrap: false,
  }, '/opt/dsh-superpowers')

  assert.equal(config.skillsDir, '/tmp/custom-skills')
  assert.equal(config.toolMappingPath, '/tmp/custom-tools.md')
  assert.equal(config.providerName, 'custom')
  assert.equal(config.rank, 12)
  assert.equal(config.sectionName, 'custom:section')
  assert.equal(config.sectionOrder, 123)
  assert.equal(config.injectBootstrap, false)
})

test('createSkillsProvider lists candidates and loads bodies without frontmatter', async () => {
  const dir = makeTempDir()
  try {
    mkdirSync(join(dir, 'alpha'))
    writeFileSync(join(dir, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha skill\n---\n# Alpha\n\nAlpha body\n')
    mkdirSync(join(dir, 'beta'))
    writeFileSync(join(dir, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: Beta skill\n---\n# Beta\n')

    const provider = createSkillsProvider({ skillsDir: dir, providerName: 'superpowers', rank: 600 }, { warn() {} })

    assert.equal(provider.name, 'superpowers')
    const candidates = await provider.list({})
    assert.equal(candidates.length, 2)

    const alpha = candidates.find(candidate => candidate.name === 'alpha')
    const definition = await provider.get(alpha, {})
    assert.equal(definition.name, 'alpha')
    assert.equal(definition.provider, 'superpowers')
    assert.equal(definition.source, 'superpowers')
    assert.deepEqual(definition.invocation, { modelInvocable: true, userInvocable: true })
    assert.match(definition.content, /# Alpha/)
    assert.doesNotMatch(definition.content, /description: Alpha skill/)

    const gone = await provider.get({ ...alpha, path: join(dir, 'missing', 'SKILL.md'), locator: join(dir, 'missing') }, {})
    assert.equal(gone, undefined)
  } finally {
    cleanup(dir)
  }
})

test('createSkillsProvider returns an empty catalog when the vendor tree is absent', async () => {
  const dir = makeTempDir()
  try {
    const warnings = []
    const provider = createSkillsProvider(
      { skillsDir: join(dir, 'does-not-exist'), providerName: 'superpowers', rank: 600 },
      { warn: message => warnings.push(message) },
    )
    assert.deepEqual(await provider.list({}), [])
    assert.ok(warnings.length >= 1, 'a missing vendor tree must be logged, not silently ignored')
  } finally {
    cleanup(dir)
  }
})

test('createSkillsProvider re-reads a skill body on the next get (upgrade without reload)', async () => {
  const dir = makeTempDir()
  try {
    mkdirSync(join(dir, 'alpha'))
    const file = join(dir, 'alpha', 'SKILL.md')
    writeFileSync(file, '---\nname: alpha\ndescription: Alpha skill\n---\nBODY-ONE\n')
    const provider = createSkillsProvider({ skillsDir: dir, providerName: 'superpowers', rank: 600 }, { warn() {} })
    const candidate = (await provider.list({})).find((item) => item.name === 'alpha')
    const first = await provider.get(candidate, {})
    assert.match(first.content, /BODY-ONE/)
    writeFileSync(file, '---\nname: alpha\ndescription: Alpha skill\n---\nBODY-TWO\n')
    const second = await provider.get(candidate, {})
    assert.match(second.content, /BODY-TWO/)
    assert.doesNotMatch(second.content, /BODY-ONE/)
  } finally {
    cleanup(dir)
  }
})
