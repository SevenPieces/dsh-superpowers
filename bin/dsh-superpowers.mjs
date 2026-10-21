#!/usr/bin/env node
// dsh-superpowers vendor management CLI.
//
// Commands:
//   update-skills   Clone https://github.com/obra/superpowers on first run, then
//                   fetch tags and check out the newest tag.
//   status          Print the vendor path, whether it exists, whether it is a
//                   git checkout, the checked-out tag, and the skill dirs
//                   (subdirectories containing SKILL.md).
//
// Options:
//   --dir <vendorDir>  Vendor checkout directory.
//                      Default: <pluginDir>/vendor/superpowers
//   -h, --help         Show usage.
//
// Constraints: ESM, node:* builtins only, no bare imports.
// The vendored tree is never edited by this command; it only clones/fetches/checks out.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_URL = 'https://github.com/obra/superpowers';

/**
 * One UTF-16 code unit of the scheme character set the original pattern used:
 * ASCII letters, digits, '+', '-' and '.'.
 * @param {number} code - UTF-16 code unit.
 * @returns {boolean} whether it may appear inside a scheme.
 */
function isSchemeChar(code) {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2d || code === 0x2e;
}

/**
 * @param {number} code - UTF-16 code unit.
 * @returns {boolean} whether it is an ASCII letter, the only legal first scheme unit.
 */
function isAsciiLetter(code) {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}

/**
 * One code unit allowed in URL userinfo by the original [^\s/] class: every
 * character except '/' and the ECMAScript \s set (tab/LF/VT/FF/CR, space,
 * NBSP, OGHAM SPACE MARK, U+2000-200A, LS/PS, U+202F, U+205F, U+3000, U+FEFF).
 * @param {number} code - UTF-16 code unit.
 * @returns {boolean} whether userinfo may contain it.
 */
function isUserinfoChar(code) {
  if (code === 0x2f) return false; // '/'
  if (code >= 0x09 && code <= 0x0d) return false; // tab, LF, VT, FF, CR
  if (code === 0x20 || code === 0xa0 || code === 0x1680) return false; // space, NBSP, OGHAM SPACE MARK
  if (code >= 0x2000 && code <= 0x200a) return false; // en/em and other spaces
  if (code === 0x2028 || code === 0x2029 || code === 0x202f ||
    code === 0x205f || code === 0x3000 || code === 0xfeff) return false;
  return true;
}

/**
 * Mask URL userinfo, which can carry a token or a password, in text about to
 * be logged. Plain URLs (no userinfo) and scp-like ssh remotes are unchanged.
 *
 * Semantics match the original scheme://<userinfo>@ pattern: the scheme starts
 * with an ASCII letter and otherwise uses [a-zA-Z0-9+.-]; userinfo is the run
 * of non-whitespace, non-'/' characters and is greedy, so the last '@' in that
 * run is the delimiter (a password may contain '@').
 *
 * Fast path: without both "://" and "@" no match is possible, so the text is
 * returned untouched after two native O(n) scans.
 *
 * The scanner is linear: each '://' occurrence is visited at most once, the
 * scheme run is walked back, the userinfo segment is scanned once while
 * tracking the last '@', and after a segment without a usable '@' the scan
 * resumes at the segment end (minus the ':' that could begin a nested '://'),
 * so no segment is rescanned.
 *
 * @param {string} text - text that may embed URLs with credentials.
 * @returns {string} the text with every URL userinfo replaced by "***".
 */
export function redactCredentials(text) {
  if (typeof text !== 'string' || text === '') return text;
  if (!text.includes('://') || !text.includes('@')) return text;

  let out = '';
  let copied = 0;
  let search = 0;
  while (true) {
    const proto = text.indexOf('://', search);
    if (proto === -1) break;

    // Walk back over the scheme run; the match must start at an ASCII letter.
    let runStart = proto;
    while (runStart > 0 && isSchemeChar(text.charCodeAt(runStart - 1))) runStart -= 1;
    let schemeStart = runStart;
    while (schemeStart < proto && !isAsciiLetter(text.charCodeAt(schemeStart))) schemeStart += 1;
    if (schemeStart >= proto) {
      search = proto + 1;
      continue;
    }

    // Scan the userinfo segment once, remembering the last '@'.
    const userinfoStart = proto + 3;
    let end = userinfoStart;
    let lastAt = -1;
    while (end < text.length) {
      const code = text.charCodeAt(end);
      if (!isUserinfoChar(code)) break;
      if (code === 0x40) lastAt = end;
      end += 1;
    }
    if (lastAt > userinfoStart) {
      out += text.slice(copied, schemeStart) + text.slice(schemeStart, userinfoStart) + '***@';
      copied = lastAt + 1;
      search = copied;
      continue;
    }
    // No usable '@': resume at the segment end so this segment is not
    // rescanned, while still considering a ':' that starts a nested '://'.
    search = Math.max(proto + 1, end - 1);
  }
  if (copied === 0) return text;
  return out + text.slice(copied);
}

/**
 * Characters that could forge or visually reorder a diagnostic line: C0
 * controls, DEL, C1 controls, the Arabic letter mark (U+061C), zero-width and
 * bidirectional marks (U+200B-200F), line/paragraph separators, bidi
 * formatting controls (U+202A-202E, U+2066-2069), and U+FEFF. A ref name,
 * directory name or git error line is vendor-influenced input.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;
const CONTROL_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * Escape control characters before text reaches a log or console line.
 * @param {unknown} value - text about to be printed.
 * @returns {string} the text with control characters escaped.
 */
function escapeControlChars(value) {
  return String(value).replace(CONTROL_CHARS, (char) =>
    CONTROL_ESCAPES[char] ?? '\\u{' + char.charCodeAt(0).toString(16).padStart(4, '0') + '}');
}

/** Environment override for the per-git-step bound. */
const GIT_TIMEOUT_ENV = 'DSH_SUPERPOWERS_GIT_TIMEOUT_MS';
/** Default bound for one git invocation: five minutes. */
const DEFAULT_GIT_TIMEOUT_MS = 300000;

/**
 * Ceiling on each captured git stream. Large legitimate tag sets exceed the
 * spawnSync default of 1 MiB; 16 MiB lifts that without leaving capture
 * unbounded, so pathological output still fails closed with ENOBUFS.
 */
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Flush threshold for replayed git output. Escaped text is accumulated and
 * written in chunks of roughly this size instead of one write per line, so a
 * newline-dense stream cannot turn into millions of stream.write calls.
 */
const GIT_REPLAY_CHUNK_BYTES = 64 * 1024;

/**
 * Resolve the per-git-step timeout. A positive safe integer in
 * DSH_SUPERPOWERS_GIT_TIMEOUT_MS overrides the default; any other value is
 * ignored, so a malformed variable cannot disable the bound.
 * @returns {number} timeout in milliseconds.
 */
function gitTimeoutMs() {
  const raw = process.env[GIT_TIMEOUT_ENV];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^[0-9]+$/.test(trimmed)) {
      const value = Number(trimmed);
      if (Number.isSafeInteger(value) && value > 0) return value;
    }
  }
  return DEFAULT_GIT_TIMEOUT_MS;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = resolve(HERE, '..');
export const DEFAULT_VENDOR_DIR = join(PLUGIN_DIR, 'vendor', 'superpowers');

export const USAGE = `Usage: dsh-superpowers <command> [--dir <vendorDir>]

Commands:
  update-skills   Clone/update the superpowers checkout and check out the newest tag.
  status          Show vendor path, existence, git checkout, tag, and skill dirs.

Options:
  --dir <path>    Vendor checkout directory (default: <pluginDir>/vendor/superpowers).
  -h, --help      Show this message.

Repository: ${REPO_URL}`;

/**
 * Parse a command-line argument vector (without node/script) into
 * { command, vendorDir }. Throws a clear Error for an unknown command, an
 * unknown option, a missing command, or a missing --dir value. '-h'/'--help'
 * anywhere in argv wins: it yields the "help" command (usage on stdout, exit 0).
 */
export function parseArgs(argv, defaultVendorDir = DEFAULT_VENDOR_DIR) {
  if (argv.includes('-h') || argv.includes('--help')) {
    return { command: 'help', vendorDir: defaultVendorDir };
  }

  let vendorDir = defaultVendorDir;
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('-')) {
        throw new Error('option --dir requires a path argument');
      }
      vendorDir = resolve(value);
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    throw new Error('missing command (expected "update-skills" or "status")');
  }
  if (positional.length > 1) {
    throw new Error(`unexpected extra argument: ${positional[1]}`);
  }

  const command = positional[0];
  if (command !== 'update-skills' && command !== 'status' && command !== 'help') {
    throw new Error(`unknown command: ${command} (expected "update-skills" or "status")`);
  }

  return { command, vendorDir };
}

/**
 * Read the entries of skillsDir without throwing, so a caller can choose
 * between silence (entries) and a diagnostic (error).
 */
function readSkillEntries(skillsDir) {
  try {
    return { entries: readdirSync(skillsDir, { withFileTypes: true }), error: null };
  } catch (error) {
    return { entries: null, error };
  }
}

/** Skill dir names among already-read entries (dot-dirs skipped, sorted). */
function skillDirsFromEntries(skillsDir, entries) {
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') &&
      existsSync(join(skillsDir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

/**
 * List skill directory names directly under skillsDir: immediate
 * subdirectories that contain a SKILL.md file. Dot-directories are deliberately
 * ignored (matching lib discoverSkills). Sorted for stable output. An
 * unreadable directory yields [] here; `status` reports that cause on stderr.
 */
export function listSkillDirs(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  const { entries, error } = readSkillEntries(skillsDir);
  if (error) return [];
  return skillDirsFromEntries(skillsDir, entries);
}

/** Resolve the skills directory for a vendor checkout (vendor/skills, or vendor itself). */
export function skillsDirFor(vendorDir) {
  const nested = join(vendorDir, 'skills');
  return existsSync(nested) ? nested : vendorDir;
}

function isGitCheckout(dir) {
  return existsSync(dir) && existsSync(join(dir, '.git'));
}

/**
 * Reprint captured git output on a local stream, escaping control and bidi
 * characters while preserving line structure. LF/CRLF separators are written
 * unchanged (so normal multi-line output stays multi-line); a bare CR is
 * escaped like any other control character. Escaped text is accumulated and
 * flushed in GIT_REPLAY_CHUNK_BYTES-sized chunks, so a newline-dense stream
 * costs a bounded number of writes instead of one per line.
 * @param {NodeJS.WriteStream} stream - destination stream.
 * @param {string | null | undefined} text - captured git output.
 */
function replaySanitized(stream, text) {
  if (typeof text !== 'string' || text === '') return;
  let chunk = '';
  let chunkBytes = 0;
  const append = (value) => {
    if (value === '') return;
    chunk += value;
    chunkBytes += Buffer.byteLength(value);
    if (chunkBytes >= GIT_REPLAY_CHUNK_BYTES) {
      stream.write(chunk);
      chunk = '';
      chunkBytes = 0;
    }
  };
  for (const part of text.split(/(\r?\n)/)) {
    if (part === '') continue;
    if (part === '\n' || part === '\r\n') append(part);
    else append(escapeControlChars(part));
  }
  if (chunk !== '') stream.write(chunk);
}

/**
 * Remove only trailing line terminators from captured git output. A ref name
 * may legally end in a Unicode space (U+00A0, U+3000, U+FEFF), which JS
 * trim() would strip and thereby corrupt the ref.
 * @param {string | null | undefined} text - captured git output.
 * @returns {string} the text without trailing CR/LF characters.
 */
function stripTrailingNewlines(text) {
  return String(text ?? '').replace(/[\r\n]+$/, '');
}

/**
 * Run git with captured streams and replay the output through
 * escapeControlChars. Capture is bounded by GIT_MAX_BUFFER_BYTES: a large
 * legitimate tag set is accepted, while output past the bound fails closed.
 * On a capture-bound overflow (ENOBUFS) the captured text is incomplete, so
 * replay is skipped and the caller's step diagnostic reports the overflow.
 * @param {string[]} args - git arguments.
 * @param {string} cwd - working directory for the step.
 * @param {object} [env] - environment (defaults to process.env).
 * @returns {object} the spawnSync result, with utf8 stdout/stderr.
 */
function runGit(args, cwd, env) {
  // Capture instead of inheriting: git output can echo a vendor-controlled ref
  // name, which must never reach the terminal raw.
  const result = spawnSync('git', args, {
    cwd,
    env: env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: gitTimeoutMs(),
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });
  // ENOBUFS means stdout/stderr are truncated mid-stream: replaying the prefix
  // would print a forged partial log and can trip a stream write error. Skip
  // the replay; the step's failure diagnostic names the overflow instead.
  if (result.error?.code !== 'ENOBUFS') {
    replaySanitized(process.stdout, result.stdout);
    replaySanitized(process.stderr, result.stderr);
  }
  return result;
}

/**
 * Run git with captured streams and no replay, bounded by
 * GIT_MAX_BUFFER_BYTES (16 MiB) so a large tag listing is captured while
 * pathological output still fails closed with ENOBUFS.
 * @param {string[]} args - git arguments.
 * @param {string} cwd - working directory for the step.
 * @param {object} [env] - environment (defaults to process.env).
 * @returns {object} the spawnSync result, with utf8 stdout/stderr.
 */
function runGitCapture(args, cwd, env) {
  return spawnSync('git', args, {
    cwd,
    env: env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: gitTimeoutMs(),
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });
}

function fail(message) {
  throw new Error(message);
}

/**
 * One-line cause for a failed git call, without inventing a reason. A
 * timeout is named explicitly; credentials embedded in a remote URL are
 * masked and control characters are escaped before the line is logged.
 * @param {object} result - result of a runGit/runGitCapture call.
 * @returns {string} one escaped, redacted diagnostic line.
 */
function gitFailureCause(result) {
  if (result?.error?.code === 'ETIMEDOUT') return `timed out after ${gitTimeoutMs()} ms`;
  if (result.error) return escapeControlChars(redactCredentials(result.error.message));
  const detail = (result.stderr ?? '')
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (detail === undefined) return `git exited ${result.status ?? 'null'}`;
  return escapeControlChars(redactCredentials(detail));
}

/**
 * Clone on first run, fetch tags, and check out the newest tag.
 *
 * A repoUrl whose trimmed value starts with "-" is rejected, and the clone
 * argv places "--" before the URL, so a URL can never be parsed as a git
 * option. Every git step is bounded by gitTimeoutMs().
 *
 * @param {string} vendorDir - vendor checkout directory.
 * @param {string} [repoUrl] - source repository URL, used for the first-run
 *   clone only (later runs fetch tags from the checkout's origin). Defaults to
 *   REPO_URL; an empty, non-string or option-like override is rejected rather
 *   than cloned.
 * @returns {number} 0 on success; throws on any failed or timed-out git step.
 */
export function updateSkills(vendorDir, repoUrl = REPO_URL) {
  if (typeof repoUrl !== 'string' || repoUrl.trim() === '') {
    fail('repoUrl must be a non-empty string')
  }
  const cloneUrl = repoUrl.trim()
  if (cloneUrl.startsWith('-')) {
    fail(`repoUrl must not start with "-" after trimming (got ${escapeControlChars(JSON.stringify(cloneUrl))}); pass a repository URL, not an option`)
  }
  const safeVendorDir = escapeControlChars(vendorDir);
  const safeCloneUrl = escapeControlChars(redactCredentials(cloneUrl));
  if (existsSync(vendorDir) && !isGitCheckout(vendorDir)) {
    fail(`vendor directory exists but is not a git checkout: ${safeVendorDir}\n` +
      'Remove it or pass a different --dir, then retry.')
  }

  if (!isGitCheckout(vendorDir)) {
    mkdirSync(dirname(vendorDir), { recursive: true });
    console.error(`[dsh-superpowers] cloning ${safeCloneUrl} -> ${safeVendorDir}`);
    const clone = runGit(['clone', '--depth', '1', '--', cloneUrl, vendorDir], dirname(vendorDir));
    if (clone.status !== 0) {
      fail(`git clone failed (${gitFailureCause(clone)}) for ${safeCloneUrl}`);
    }
  }

  console.error('[dsh-superpowers] fetching tags');
  const fetch = runGit(['fetch', '--tags', '--force', 'origin'], vendorDir);
  if (fetch.status !== 0) {
    fail(`git fetch --tags failed (${gitFailureCause(fetch)}) in ${safeVendorDir}`);
  }

  const tagList = runGitCapture(['tag', '--sort=-v:refname'], vendorDir);
  // Split on CRLF/LF and take the first non-empty line verbatim: trimming a
  // legal ref name that ends in a Unicode space would corrupt it.
  const tag = (tagList.stdout ?? '').split(/\r?\n/).find((line) => line !== '') ?? '';
  if (tagList.status !== 0 || tag === '') {
    fail(`could not resolve the newest tag from ${safeVendorDir} (${gitFailureCause(tagList)})`);
  }
  const safeTag = escapeControlChars(tag);

  const tagRef = 'refs/tags/' + tag;
  const rev = runGitCapture(['rev-list', '-n', '1', tagRef], vendorDir);
  const hash = stripTrailingNewlines(rev.stdout);
  if (rev.status !== 0 || hash === '') {
    fail('could not resolve the commit for tag ' + safeTag + ' (' + gitFailureCause(rev) + ')');
  }

  console.error(`[dsh-superpowers] checking out ${safeTag}`);
  const checkout = runGit(['checkout', '--force', tagRef], vendorDir);
  if (checkout.status !== 0) {
    fail(`git checkout ${safeTag} failed (${gitFailureCause(checkout)}) in ${safeVendorDir}`);
  }

  console.log(`Resolved superpowers tag: ${safeTag}`);
  console.log(`Commit: ${escapeControlChars(hash)}`);
  return 0;
}

/**
 * Print path/exists/git/tag/skill dirs. Never mutates the checkout, never
 * throws (exit 0 is informational): unreadable inputs are named on stderr as
 * "dsh-superpowers: ..." diagnostics.
 */
export function status(vendorDir) {
  const safeVendorDir = escapeControlChars(vendorDir);
  const pathExists = existsSync(vendorDir);
  const isGit = isGitCheckout(vendorDir);
  let tag = null;
  if (isGit) {
    const described = runGitCapture(['describe', '--tags', '--always'], vendorDir);
    if (described.status === 0) {
      tag = stripTrailingNewlines(described.stdout) || null;
    } else {
      // Keep the n/a line, but say why: a failed describe is not "no tags".
      console.error(`dsh-superpowers: could not read the tag in ${safeVendorDir} (${gitFailureCause(described)})`);
    }
  }
  const skillsDir = skillsDirFor(vendorDir);
  const safeSkillsDir = escapeControlChars(skillsDir);
  let skills = [];
  if (existsSync(skillsDir)) {
    const { entries, error } = readSkillEntries(skillsDir);
    if (error) {
      console.error(`dsh-superpowers: skills directory unreadable at ${safeSkillsDir} (${escapeControlChars(error.message)})`);
    } else {
      skills = skillDirsFromEntries(skillsDir, entries);
    }
  }

  console.log(`vendor dir: ${safeVendorDir}`);
  console.log(`exists: ${pathExists ? 'yes' : 'no'}`);
  console.log(`git: ${isGit ? 'yes' : 'no'}`);
  console.log(`tag: ${tag === null ? 'n/a' : escapeControlChars(tag)}`);
  console.log(`skill dirs: ${skills.length}`);
  if (skills.length > 0) {
    console.log(`skills: ${escapeControlChars(skills.join(', '))}`);
  } else if (!isGit) {
    console.log('run "dsh-superpowers update-skills" to create the vendor checkout');
  }
  return 0;
}

/** CLI entry point. Returns the process exit code (0 on success). */
export function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(`dsh-superpowers: ${escapeControlChars(error.message)}`);
    console.error(USAGE);
    return 2;
  }

  if (parsed.command === 'help') {
    console.log(USAGE);
    return 0;
  }

  try {
    return parsed.command === 'update-skills'
      ? updateSkills(parsed.vendorDir)
      : status(parsed.vendorDir);
  } catch (error) {
    console.error(`dsh-superpowers: ${escapeControlChars(error.message)}`);
    return 1;
  }
}

let entry = null;
try {
  entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null;
} catch {
  entry = null;
}
if (entry !== null && import.meta.url === entry) {
  process.exitCode = main();
}
