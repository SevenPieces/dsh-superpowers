/**
 * dsh-superpowers: out-of-tree Cordis plugin that ports the superpowers
 * harness integration to DeepSeek Harness.
 *
 * Runtime source is vendor-only: the plugin reads the
 * vendored checkout under vendor/superpowers and never touches ~/.claude.
 * Only node:* builtins are imported, because out-of-tree plugins cannot
 * resolve the host's @deepseek-ai/* packages from their own directory.
 *
 * The always-on bootstrap is delivered as a system-prompt section whose text
 * provider is evaluated at each prompt assembly, so
 * upgraded text takes effect without a plugin reload.
 *
 * @module dsh-superpowers
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-superpowers'
export const inject = ['skills', 'systemPrompt']

const LF = String.fromCharCode(10)
const HERE = dirname(fileURLToPath(import.meta.url))
export const PLUGIN_DIR = resolve(HERE, '..')

export const DEFAULT_TOOL_MAPPING = [
  'invoke a skill        -> skill tool (or /<name> user invocation)',
  'dispatch a subagent   -> subagent / subagent_fork',
  'todo / task tracking  -> todo_write',
  'read / write / edit   -> read / write / edit',
  'run shell / tests     -> bash',
  'web fetch / search    -> web_fetch / web_search',
  'deliver a file        -> present',
].join(LF)

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const FRONTMATTER_KEYS = new Set(['name', 'description', 'whenToUse', 'when-to-use'])

/** Documented defaults for the plugin's configuration surface. */
const DEFAULTS = {
  providerName: 'superpowers',
  rank: 600,
  sectionName: 'superpowers:using-superpowers',
  sectionOrder: 250,
  injectBootstrap: true,
}

/**
 * Text that must not survive into the bootstrap section. The strict template
 * group rule is the one the host renderer requires: an unregistered {{x}}
 * reaching it throws, while a registered name is silently substituted, so any
 * "{{" in vendor-derived text or an interpolated path is escaped. The wrapper
 * tag rules are defence in depth, not a host requirement: escaping them keeps
 * this section's own <EXTREMELY-IMPORTANT> delimiters unambiguous and its
 * structure intact. The hyphenated upstream tokens <EXTREMELY-IMPORTANT> are
 * deliberately left alone.
 */
const SANITIZE_RULES = [
  ['</EXTREMELY_IMPORTANT>', '<\\/EXTREMELY_IMPORTANT>', 'closing wrapper tag "</EXTREMELY_IMPORTANT>"'],
  ['<EXTREMELY_IMPORTANT>', '<\\EXTREMELY_IMPORTANT>', 'opening wrapper tag "<EXTREMELY_IMPORTANT>"'],
]

/**
 * A run of two or more opening braces. A single split/join pass on '{{' would
 * leave an adjacent pair behind for odd-length runs, so escape every brace in
 * the run: the replacement separates them, which cannot re-form a pair, and
 * the run is maximal, so one pass is already a fixpoint (no loop to bound).
 */
const BRACE_RUN = /\{\{+/g

/**
 * Parse a Markdown file's leading YAML-ish frontmatter.
 *
 * The parser intentionally supports only the scalar key/value subset the
 * superpowers skills use. Values may be single- or double-quoted; quoted
 * values keep colons. Unquoted "true"/"false" become booleans.
 *
 * @param {string} text - raw Markdown file contents.
 * @returns {{ data: Record<string, string | boolean>, body: string }} parsed
 *   frontmatter fields and the remaining body (whole input when absent).
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string') return { data: {}, body: '' }
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)
  if (match === null) return { data: {}, body: source }

  const data = {}
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    if (key === '') continue
    const rawValue = line.slice(separator + 1).trim()
    const value = unquoteValue(rawValue)
    data[key] = isQuoted(rawValue) ? value : value === 'true' ? true : value === 'false' ? false : value
  }
  return { data, body: source.slice(match[0].length) }
}

/**
 * @param {string} value - trimmed frontmatter scalar.
 * @returns {boolean} whether the scalar is wrapped in matching quotes.
 */
function isQuoted(value) {
  if (value.length < 2) return false
  const first = value[0]
  const last = value[value.length - 1]
  return (first === '"' && last === '"') || (first === "'" && last === "'")
}

/**
 * Strip matching quotes from one frontmatter scalar.
 * @param {string} value - trimmed scalar text.
 * @returns {string} the unquoted value.
 */
function unquoteValue(value) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if (first === '"' && last === '"') return value.slice(1, -1).replace(/\\"/g, '"')
    if (first === "'" && last === "'") return value.slice(1, -1).replace(/\\'/g, "'")
  }
  return value
}

/**
 * Characters that would let a vendor-controlled name forge a log line: C0
 * controls (a newline ends the log record, ESC starts a terminal sequence),
 * DEL, C1 controls, and the Unicode line/paragraph separators.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
const CONTROL_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/**
 * Escape control characters in text about to enter a diagnostic. Named
 * escapes keep newline/tab/carriage-return readable; everything else becomes
 * \u{xxxx}, so one warning stays one log line.
 * @param {unknown} value - text about to enter a diagnostic.
 * @returns {string} the text with control characters escaped.
 */
function escapeControlChars(value) {
  return String(value).replace(CONTROL_CHARS, (char) =>
    CONTROL_ESCAPES[char] ?? '\\u{' + char.charCodeAt(0).toString(16).padStart(4, '0') + '}')
}

/**
 * One shared strict decoder: UTF-8 only, no replacement characters. Serving
 * U+FFFD would hide a corrupted skill body as if it were real content.
 */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

/**
 * Read a file as strict UTF-8 and classify the failure instead of collapsing
 * every error into "missing".
 * @param {string} filePath - file to read.
 * @returns {{ ok: true, text: string } | { ok: false, kind: 'missing' | 'unreadable' | 'invalid-utf8', detail: string }} the decoded text, or a failure kind with its cause.
 */
function readUtf8Strict(filePath) {
  let bytes
  try {
    bytes = readFileSync(filePath)
  } catch (error) {
    const code = error?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, kind: 'missing', detail: errorMessage(error) }
    }
    return { ok: false, kind: 'unreadable', detail: errorMessage(error) }
  }
  try {
    return { ok: true, text: UTF8_DECODER.decode(bytes) }
  } catch (error) {
    return { ok: false, kind: 'invalid-utf8', detail: 'not valid UTF-8 (' + errorMessage(error) + ')' }
  }
}

/**
 * Discover superpowers skill candidates under a skills directory.
 *
 * A directory contributes only when it contains a readable SKILL.md whose
 * frontmatter carries a non-empty description; everything else is skipped
 * (invalid entries must not break the catalog).
 *
 * @param {string} skillsDir - directory holding one subdirectory per skill.
 * @param {string} providerName - provider name recorded on each candidate.
 * @param {number} rank - precedence rank recorded on each candidate.
 * @param {(reason: string, entryName: string, detail?: string) => void} [onSkip] - optional
 *   reporter invoked for every entry that is not emitted as a candidate, and
 *   for a skills directory that cannot be read at all (reason
 *   "unreadable-directory", where the detail carries the cause). Skill-level
 *   read failures are classified as "missing-skill-md" (no such file),
 *   "unreadable-skill-md" (exists but cannot be read; detail carries the
 *   cause) and "invalid-utf8" (bytes are not valid UTF-8). Entry names and
 *   details are control-character escaped before reporting, so a crafted
 *   directory name cannot forge a log line.
 * @returns {Array<object>} sorted skill candidates.
 */
export function discoverSkills(skillsDir, providerName, rank, onSkip) {
  const candidates = []
  const skip = (reason, entryName, detail) => {
    try {
      if (typeof onSkip === 'function') {
        onSkip(reason, escapeControlChars(entryName),
          detail === undefined ? undefined : escapeControlChars(detail))
      }
    } catch { /* fail-open: skip reporting must not break discovery */ }
  }
  let entries
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
  } catch (error) {
    skip('unreadable-directory', skillsDir, errorMessage(error))
    return candidates
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory()) {
      skip('not-a-directory', entry.name)
      continue
    }
    const skillDir = join(skillsDir, entry.name)
    const skillPath = join(skillDir, 'SKILL.md')
    const read = readUtf8Strict(skillPath)
    if (!read.ok) {
      const reason = read.kind === 'invalid-utf8'
        ? 'invalid-utf8'
        : read.kind === 'missing' ? 'missing-skill-md' : 'unreadable-skill-md'
      skip(reason, entry.name, read.detail)
      continue
    }
    const { data } = parseFrontmatter(read.text)
    const name = typeof data.name === 'string' && data.name.trim() !== '' ? data.name.trim() : entry.name
    const description = typeof data.description === 'string' ? data.description.trim() : ''
    if (description === '') {
      skip('empty-description', entry.name)
      continue
    }
    if (!SKILL_NAME.test(name)) {
      skip('invalid-name', entry.name)
      continue
    }
    const whenToUse = firstString(data, 'whenToUse', 'when-to-use')
    const metadata = extraMetadata(data)
    candidates.push({
      name,
      description,
      ...whenToUse === undefined ? {} : { whenToUse },
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'superpowers',
      provider: providerName,
      rank,
      locator: skillDir,
      path: skillPath,
      resourceBase: { kind: 'directory', path: skillDir },
      ...metadata === undefined ? {} : { metadata },
    })
  }

  candidates.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return candidates
}

/**
 * Read the first non-empty string field among the given keys.
 * @param {Record<string, unknown>} data - parsed frontmatter.
 * @param {...string} keys - candidate keys in priority order.
 * @returns {string | undefined} the first non-empty string.
 */
function firstString(data, ...keys) {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * Collect frontmatter fields that are not part of the public candidate shape.
 * @param {Record<string, unknown>} data - parsed frontmatter.
 * @returns {Record<string, unknown> | undefined} extra fields, when any.
 */
function extraMetadata(data) {
  const extra = {}
  for (const [key, value] of Object.entries(data)) {
    if (!FRONTMATTER_KEYS.has(key)) extra[key] = value
  }
  return Object.keys(extra).length === 0 ? undefined : extra
}

/**
 * Load a skill body with its frontmatter stripped, refusing invalid UTF-8.
 * @param {string} skillMdPath - absolute path to a SKILL.md file.
 * @returns {{ ok: true, content: string } | { ok: false, kind: 'missing' | 'unreadable' | 'invalid-utf8' | 'empty', detail: string }} the body or a classified failure carrying its cause.
 */
function readSkillBody(skillMdPath) {
  if (typeof skillMdPath !== 'string' || skillMdPath === '') {
    return { ok: false, kind: 'unreadable', detail: 'skill path is not a non-empty string' }
  }
  const read = readUtf8Strict(skillMdPath)
  if (!read.ok) return read
  const body = parseFrontmatter(read.text).body.trim()
  if (body === '') return { ok: false, kind: 'empty', detail: 'skill body is empty' }
  return { ok: true, content: body }
}

/**
 * Load a skill body with its frontmatter stripped.
 * @param {string} skillMdPath - absolute path to a SKILL.md file.
 * @returns {string | undefined} the trimmed body, or undefined when unreadable, invalid UTF-8, or empty.
 */
export function loadSkillBody(skillMdPath) {
  const loaded = readSkillBody(skillMdPath)
  return loaded.ok ? loaded.content : undefined
}

/**
 * Name a failed skill-body load precisely, so an invalid encoding is never
 * confused with a permission error or a missing file.
 * @param {{ kind: string, detail: string }} failure - classified read failure.
 * @param {string} skillMdPath - path the failure refers to.
 * @returns {string} the diagnostic message.
 */
function skillBodyWarning(failure, skillMdPath) {
  if (failure.kind === 'invalid-utf8') {
    return 'dsh-superpowers: skill body is not valid UTF-8 at ' + skillMdPath + ' (' + failure.detail + ')'
  }
  if (failure.kind === 'empty') return 'dsh-superpowers: skill body is empty at ' + skillMdPath
  return 'dsh-superpowers: skill body not readable at ' + skillMdPath + ' (' + failure.detail + ')'
}

/**
 * Resolve plugin configuration against the plugin's own directory.
 * @param {unknown} raw - plugin config row (untrusted; may be absent).
 * @param {string} pluginDir - absolute plugin package directory.
 * @returns {{ skillsDir: string, toolMappingPath: string, providerName: string, rank: number, sectionName: string, sectionOrder: number, injectBootstrap: boolean }} resolved config.
 */
export function resolveConfig(raw, pluginDir) {
  const config = isRecord(raw) ? raw : {}
  const root = nonEmptyString(pluginDir) ? pluginDir : process.cwd()
  return {
    skillsDir: nonEmptyString(config.skillsDir) ? resolve(root, config.skillsDir) : join(root, 'vendor', 'superpowers', 'skills'),
    toolMappingPath: nonEmptyString(config.toolMappingPath) ? resolve(root, config.toolMappingPath) : join(root, 'references', 'dsh-tools.md'),
    providerName: nonEmptyString(config.providerName) ? config.providerName : DEFAULTS.providerName,
    rank: Number.isFinite(config.rank) ? config.rank : DEFAULTS.rank,
    sectionName: nonEmptyString(config.sectionName) ? config.sectionName : DEFAULTS.sectionName,
    sectionOrder: Number.isFinite(config.sectionOrder) ? config.sectionOrder : DEFAULTS.sectionOrder,
    injectBootstrap: typeof config.injectBootstrap === 'boolean' ? config.injectBootstrap : DEFAULTS.injectBootstrap,
  }
}

/**
 * Build the skill provider backed by a vendored superpowers skills tree.
 *
 * Discovery and body loads are fail-open: an unreadable tree yields an empty
 * catalog, and every anomaly is logged through the supplied logger.
 *
 * @param {{ skillsDir: string, providerName: string, rank: number }} config - resolved provider config.
 * @param {{ warn?: (message: string) => void } | undefined} logger - host logger.
 * @returns {{ name: string, list: Function, get: Function }} the skill provider.
 */
export function createSkillsProvider({ skillsDir, providerName, rank }, logger) {
  const warn = safeSink(pickWarnMethod(logger))
  const reportAnomalies = createAnomalyReporter(warn)

  return {
    name: providerName,
    async list(options) {
      throwIfAborted(options)
      const anomalies = []
      try {
        if (!existsSync(skillsDir)) {
          anomalies.push(`dsh-superpowers: superpowers skills directory not found at ${skillsDir}; run "dsh plugin --profile web exec dsh-superpowers update-skills" to vendor the skills`)
          reportAnomalies(anomalies)
          return []
        }
        const candidates = discoverSkills(skillsDir, providerName, rank, (reason, entryName, detail) => {
          if (reason === 'unreadable-directory') {
            anomalies.push(`dsh-superpowers: skills directory unreadable at ${skillsDir} (${detail})`)
            return
          }
          const cause = (reason === 'unreadable-skill-md' || reason === 'invalid-utf8') && detail
            ? ' (' + detail + ')'
            : ''
          anomalies.push(`dsh-superpowers: skipped skill entry (${reason}) ${entryName} under ${skillsDir}` + cause)
        })
        const nameCounts = new Map()
        for (const candidate of candidates) nameCounts.set(candidate.name, (nameCounts.get(candidate.name) ?? 0) + 1)
        for (const [skillName, entries] of nameCounts) {
          if (entries > 1) {
            // The host dedups colliding names and logs its own warning; this one
            // names the collision from the plugin side.
            anomalies.push(`dsh-superpowers: duplicate skill name "${skillName}" (${entries} entries); one will be ignored`)
          }
        }
        if (candidates.length === 0) anomalies.push(`dsh-superpowers: no skills discovered under ${skillsDir}`)
        reportAnomalies(anomalies)
        return candidates
      } catch (error) {
        anomalies.push(`dsh-superpowers: skill discovery failed: ${errorMessage(error)}`)
        reportAnomalies(anomalies)
        return []
      }
    },
    async get(candidate, options) {
      throwIfAborted(options)
      try {
        const skillMdPath = nonEmptyString(candidate?.path)
          ? candidate.path
          : join(String(candidate?.locator ?? ''), 'SKILL.md')
        const loaded = readSkillBody(skillMdPath)
        if (!loaded.ok) {
          warn(skillBodyWarning(loaded, skillMdPath))
          return undefined
        }
        return { ...candidate, content: loaded.content }
      } catch (error) {
        if (isAbortError(error)) throw error
        warn(`dsh-superpowers: failed to load skill body: ${errorMessage(error)}`)
        return undefined
      }
    },
  }
}

/** @returns {boolean} whether the value is a plain object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @returns {boolean} whether the value is a non-empty string. */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Wrap a warning sink so a throwing sink can never escape into the host.
 * @param {unknown} sink - candidate warning function.
 * @returns {(message: string) => void} a sink that never throws.
 */
function safeSink(sink) {
  return function warn(message) {
    try {
      if (typeof sink === 'function') sink(message)
    } catch { /* fail-open: logging must never break the host */ }
  }
}

/**
 * Read a logger's warn method without letting a hostile getter escape.
 * @param {unknown} logger - host logger (untrusted; may be absent).
 * @returns {((message: string) => void) | undefined} the bound warn method.
 */
function pickWarnMethod(logger) {
  try {
    return logger && typeof logger.warn === 'function' ? logger.warn.bind(logger) : undefined
  } catch {
    return undefined
  }
}

/**
 * Build a logger view whose warn/info calls can never throw at the host.
 * @param {unknown} logger - host logger (untrusted; may be absent or hostile).
 * @returns {{ warn: (message: string) => void, info: (message: string) => void }} safe logger.
 */
function createSafeLogger(logger) {
  const call = (level, message) => {
    try {
      const method = logger && typeof logger[level] === 'function' ? logger[level] : undefined
      if (typeof method === 'function') method.call(logger, message)
    } catch { /* fail-open: logging must never break the host */ }
  }
  return {
    warn(message) { call('warn', message) },
    info(message) { call('info', message) },
  }
}

/**
 * Build a per-message anomaly reporter with recovery reset: each distinct
 * message is reported once while it persists, and again after it disappears
 * and reappears. Each call passes the anomalies currently present.
 * @param {(message: string) => void} warn - non-throwing warning sink.
 * @returns {(messages: Iterable<string>) => void} report the current anomalies.
 */
function createAnomalyReporter(warn) {
  let active = new Set()
  return function reportAnomalies(messages) {
    const current = new Set(messages)
    for (const message of current) {
      if (!active.has(message)) warn(message)
    }
    active = current
  }
}

/** Abort a provider lookup when the caller's signal is already aborted. */
function throwIfAborted(options) {
  const signal = options?.signal
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('skill lookup aborted')
  }
}

/** @returns {boolean} whether the error is an abort. */
function isAbortError(error) {
  return error instanceof Error && error.name === 'AbortError'
}

/** @returns {string} a human-readable error message. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Compose the always-on using-superpowers bootstrap for DSH.
 * @param {unknown} skillsDir - vendored skills directory.
 * @param {unknown} toolMappingPath - DSH tool-mapping reference file.
 * @returns {string | null} the bootstrap text, or null when the skill is absent or empty.
 */
export function composeBootstrap(skillsDir, toolMappingPath) {
  return composeBootstrapResult(skillsDir, toolMappingPath).text
}

/**
 * Appended to every bootstrap anomaly that re-vendoring the skills fixes, so
 * the warning names the command that repairs it.
 */
const UPDATE_SKILLS_HINT = '; run "dsh plugin --profile web exec dsh-superpowers update-skills" to vendor the skills'

/**
 * Compose the bootstrap and collect every anomaly observed while doing so.
 * Sanitising vendor-derived text is a no-op on clean text (invariant I1).
 * @param {unknown} skillsDir - vendored skills directory.
 * @param {unknown} toolMappingPath - DSH tool-mapping reference file.
 * @returns {{ text: string | null, anomalies: string[] }} composed text and anomalies.
 */
function composeBootstrapResult(skillsDir, toolMappingPath) {
  if (!nonEmptyString(skillsDir)) return { text: null, anomalies: [] }
  const usingPath = join(skillsDir, 'using-superpowers', 'SKILL.md')
  const using = readUtf8Strict(usingPath)
  if (!using.ok) {
    if (using.kind === 'missing') {
      return { text: null, anomalies: ['dsh-superpowers: no bootstrap; missing ' + usingPath + UPDATE_SKILLS_HINT] }
    }
    return {
      text: null,
      anomalies: ['dsh-superpowers: no bootstrap; unreadable ' + usingPath + ' (' + using.detail + ')' + UPDATE_SKILLS_HINT],
    }
  }
  const body = parseFrontmatter(using.text).body.trim()
  if (body === '') {
    return { text: null, anomalies: ['dsh-superpowers: no bootstrap; empty using-superpowers body at ' + usingPath] }
  }
  const anomalies = []
  let mapping = DEFAULT_TOOL_MAPPING
  if (nonEmptyString(toolMappingPath)) {
    const readMapping = readUtf8Strict(toolMappingPath)
    if (!readMapping.ok) {
      anomalies.push('dsh-superpowers: tool mapping not readable at ' + toolMappingPath +
        ' (' + readMapping.detail + '); using the built-in mapping')
    } else {
      const mapped = readMapping.text.trim()
      if (mapped === '') {
        anomalies.push('dsh-superpowers: tool mapping is empty at ' + toolMappingPath + '; using the built-in mapping')
      } else {
        mapping = mapped
      }
    }
  }
  const safeSkillsDir = sanitizeBootstrapText(skillsDir, anomalies)
  const safeBody = sanitizeBootstrapText(body, anomalies)
  const safeMapping = sanitizeBootstrapText(mapping, anomalies)
  const text = [
    '<EXTREMELY_IMPORTANT>',
    'superpowers:using-superpowers bootstrap for dsh',
    '',
    'You have superpowers.',
    '',
    'The using-superpowers skill content is included below and is already loaded for this DSH session. Follow it now. Do not try to load using-superpowers again.',
    '',
    safeBody,
    '',
    '## Loading Superpowers Skills on DSH',
    '',
    'Superpowers skills are registered with the DSH skill registry. Invoke one with the skill tool by name (for example skill(brainstorming)). If a lookup returns not found, read the skill file directly at ' + join(safeSkillsDir, '<name>', 'SKILL.md') + '.',
    '',
    'The superpowers skills directory is: ' + safeSkillsDir,
    '',
    safeMapping,
    '</EXTREMELY_IMPORTANT>',
  ].join(LF)
  return { text, anomalies }
}

/**
 * Neutralize host-renderer-significant tokens in bootstrap text, whether it
 * comes from the vendored tree or from an interpolated config path.
 * @param {string} text - text about to become part of the bootstrap section.
 * @param {string[]} anomalies - collector, one entry per distinct neutralization.
 * @returns {string} the sanitized text.
 */
function sanitizeBootstrapText(text, anomalies) {
  let sanitized = text
  for (const [from, to, label] of SANITIZE_RULES) {
    if (!sanitized.includes(from)) continue
    sanitized = sanitized.split(from).join(to)
    anomalies.push(neutralizedMessage(label))
  }
  if (BRACE_RUN.test(sanitized)) {
    BRACE_RUN.lastIndex = 0
    sanitized = sanitized.replace(BRACE_RUN, (run) => run.replace(/\{/g, '\\{'))
    anomalies.push(neutralizedMessage('strict template group "{{"'))
  }
  return sanitized
}

/**
 * @param {string} label - what was neutralized.
 * @returns {string} the anomaly message for one distinct neutralization.
 */
function neutralizedMessage(label) {
  return 'dsh-superpowers: neutralized ' + label + ' in bootstrap text'
}

/**
 * Build the assembly-time text provider for the bootstrap system-prompt
 * section. The provider re-reads the vendor tree on every call and is
 * fail-open: a missing, empty or unreadable bootstrap contributes no text and
 * is reported through a deduplicated anomaly channel that resets after the
 * anomaly clears, so the provider self-heals.
 *
 * @param {{ skillsDir: string, toolMappingPath: string } | null | undefined} config - resolved config.
 * @param {(message: string) => void} [warn] - host warning sink.
 * @returns {() => string} the section text provider.
 */
export function createBootstrapProvider(config, warn) {
  const warnFn = safeSink(warn)
  const reportAnomalies = createAnomalyReporter(warnFn)
  let skillsDir
  let toolMappingPath
  try {
    skillsDir = isRecord(config) && nonEmptyString(config.skillsDir) ? config.skillsDir : undefined
    toolMappingPath = isRecord(config) && nonEmptyString(config.toolMappingPath) ? config.toolMappingPath : undefined
  } catch {
    skillsDir = undefined
    toolMappingPath = undefined
  }

  return function bootstrapText() {
    try {
      if (skillsDir === undefined) {
        reportAnomalies(['dsh-superpowers: bootstrap composition failed: skillsDir is not a non-empty string'])
        return ''
      }
      const { text, anomalies } = composeBootstrapResult(skillsDir, toolMappingPath)
      reportAnomalies(anomalies)
      return text === null ? '' : text
    } catch (error) {
      reportAnomalies(['dsh-superpowers: bootstrap composition failed: ' + errorMessage(error)])
      return ''
    }
  }
}

/**
 * Read ctx.logger without letting a hostile getter escape.
 * @param {unknown} ctx - Cordis context (untrusted; may be absent).
 * @returns {unknown} the host logger, when reachable.
 */
function readLogger(ctx) {
  try {
    return ctx ? ctx.logger : undefined
  } catch {
    return undefined
  }
}

/**
 * Cordis plugin entry: register the skill provider and the bootstrap
 * system-prompt section. Fail-open and logged; never throws into the loop:
 * untrusted config and host seams are resolved defensively and every log call
 * goes through a wrapper that swallows hostile logger behaviour.
 * @param {object} ctx - Cordis context.
 * @param {unknown} raw - plugin config row.
 */
export function apply(ctx, raw) {
  const logger = createSafeLogger(readLogger(ctx))
  let config
  try {
    config = resolveConfig(raw, PLUGIN_DIR)
  } catch (error) {
    logger.warn('dsh-superpowers: invalid config; using defaults (' + errorMessage(error) + ')')
    config = resolveConfig(undefined, PLUGIN_DIR)
  }

  try {
    const skills = ctx && ctx.skills
    if (skills && typeof skills.registerProvider === 'function') {
      const providerConfig = { skillsDir: config.skillsDir, providerName: config.providerName, rank: config.rank }
      skills.registerProvider(function () { return createSkillsProvider(providerConfig, logger) })
    } else {
      logger.warn('dsh-superpowers: skills seam unavailable; provider not registered (declare skills in inject)')
    }
  } catch (error) {
    logger.warn('dsh-superpowers: failed to register skill provider: ' + errorMessage(error))
  }

  if (config.injectBootstrap) {
    try {
      const prompt = ctx && ctx.systemPrompt
      if (prompt && typeof prompt.section === 'function') {
        const section = {
          name: config.sectionName,
          order: config.sectionOrder,
          text: createBootstrapProvider(config, logger.warn),
        }
        if (typeof ctx.effect === 'function') ctx.effect(function () { return prompt.section(section) })
        else prompt.section(section)
      } else {
        logger.warn('dsh-superpowers: systemPrompt.section unavailable; bootstrap section not registered (declare systemPrompt in inject)')
      }
    } catch (error) {
      logger.warn('dsh-superpowers: failed to register bootstrap section: ' + errorMessage(error))
    }
  }
  logger.info('dsh-superpowers: skillsDir=' + config.skillsDir + ' vendor=' + (existsSync(config.skillsDir) ? 'present' : 'MISSING'))
}
