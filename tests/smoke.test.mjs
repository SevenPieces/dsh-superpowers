import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, composeBootstrap, apply, createBootstrapProvider, PLUGIN_DIR, name, inject } from '../lib/index.js'

test('plugin exports, skill provider, and assembly-time bootstrap section over the vendor tree', async () => {
  assert.equal(name, 'dsh-superpowers')
  assert.deepEqual(inject, ['skills', 'systemPrompt'])
  const cfg = resolveConfig({}, PLUGIN_DIR)
  const bootstrap = composeBootstrap(cfg.skillsDir, cfg.toolMappingPath)
  assert.ok(bootstrap, 'bootstrap composed')
  assert.ok(bootstrap.includes('superpowers:using-superpowers bootstrap for dsh'))
  assert.ok(bootstrap.includes('subagent_fork'))
  const captured = { provider: null, section: null }
  const fake = {
    logger: { info() {}, warn() {} },
    skills: { registerProvider(create) { captured.provider = create() } },
    systemPrompt: { section(s) { captured.section = s; return () => {} } },
    effect(fn) { const d = fn(); return () => { if (d) d() } },
  }
  apply(fake, {})
  assert.ok(captured.provider, 'provider registered')
  assert.ok(captured.section, 'bootstrap section registered')
  assert.equal(captured.section.name, cfg.sectionName)
  assert.equal(captured.section.order, cfg.sectionOrder)
  assert.equal(typeof captured.section.text, 'function', 'section text is an assembly-time provider')
  const text = captured.section.text({})
  assert.equal(text, bootstrap, 'section text is byte-identical to composeBootstrap output')
  assert.ok(text.includes('superpowers:using-superpowers bootstrap for dsh'))
  assert.ok(text.includes('subagent_fork'))
  assert.ok(!text.includes('{{'), 'bootstrap must not contain {{...}} (renderPrompt interpolation would fail)')
  const list = await captured.provider.list({})
  assert.equal(list.length, 14, 'all 14 skills discovered')
  const first = await captured.provider.get(list[0], {})
  assert.ok(typeof first.content === 'string' && first.content.length > 0, 'body loads without frontmatter')
})

test('injectBootstrap=false registers no bootstrap section but keeps the skill provider', () => {
  const captured = { section: null, provider: null }
  const fake = {
    logger: { info() {}, warn() {} },
    skills: { registerProvider(create) { captured.provider = create() } },
    systemPrompt: { section(s) { captured.section = s; return () => {} } },
    effect(fn) { const d = fn(); return () => { if (d) d() } },
  }
  apply(fake, { injectBootstrap: false })
  assert.equal(captured.section, null, 'no section when injectBootstrap is false')
  assert.ok(captured.provider, 'skill provider still registered')
})

test('composeBootstrap falls back to the built-in DSH mapping when the mapping file is unreadable', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sp-map-'))
  try {
    const skillDir = join(root, 'skills', 'using-superpowers')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: using-superpowers\ndescription: x\n---\nBODY-FALLBACK\n')
    const bootstrap = composeBootstrap(join(root, 'skills'), join(root, 'missing-tools.md'))
    assert.ok(bootstrap.includes('BODY-FALLBACK'))
    assert.ok(bootstrap.includes('invoke a skill        -> skill tool'), 'built-in mapping used')
    assert.ok(bootstrap.includes('deliver a file        -> present'), 'built-in mapping used')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('bootstrap provider is fail-open when composition throws', () => {
  const warnings = []
  const provider = createBootstrapProvider({ skillsDir: null, toolMappingPath: null }, (m) => warnings.push(m))
  assert.equal(provider({}), '')
  assert.equal(provider({}), '')
  assert.ok(warnings.some((m) => m.includes('bootstrap composition failed')), 'composition failure logged')
})

test('apply logs and skips the section when the systemPrompt seam is unavailable', () => {
  const warns = []
  const fake = {
    logger: { info() {}, warn: (m) => warns.push(m) },
    skills: { registerProvider() {} },
    effect(fn) { const d = fn(); return () => { if (d) d() } },
  }
  apply(fake, {})
  assert.ok(warns.some((m) => m.includes('systemPrompt.section unavailable')), 'missing seam logged')
})
