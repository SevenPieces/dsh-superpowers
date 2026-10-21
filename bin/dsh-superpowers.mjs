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
 * Match the userinfo part of a URL (scheme://<userinfo>@host). The userinfo
 * class excludes whitespace and '/', and is greedy, so a password containing
 * '@' is masked whole: the last '@' before the next '/' ends the userinfo.
 */
const URL_USERINFO = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/]+@/g;

/**
 * Mask URL userinfo, which can carry a token or a password, in text about to
 * be logged. Plain URLs (no userinfo) and scp-like ssh remotes are unchanged.
 * @param {string} text - text that may embed URLs with credentials.
 * @returns {string} the text with every URL userinfo replaced by "***".
 */
export function redactCredentials(text) {
  if (typeof text !== 'string' || text === '') return text;
  return text.replace(URL_USERINFO, '$1***@');
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

function runGit(args, cwd, env) {
  return spawnSync('git', args, {
    cwd,
    env: env ?? process.env,
    stdio: 'inherit',
  });
}

function runGitCapture(args, cwd, env) {
  return spawnSync('git', args, {
    cwd,
    env: env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

function fail(message) {
  throw new Error(message);
}

/**
 * One-line cause for a failed captured git call, without inventing a reason.
 * Credentials embedded in a remote URL are masked before the line is logged.
 */
function gitFailureCause(result) {
  if (result.error) return redactCredentials(result.error.message);
  const detail = (result.stderr ?? '')
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .find((line) => line !== '');
  return detail === undefined ? `git exited ${result.status ?? 'null'}` : redactCredentials(detail);
}

/**
 * Clone on first run, fetch tags, and check out the newest tag.
 * @param {string} vendorDir - vendor checkout directory.
 * @param {string} [repoUrl] - source repository URL, used for the first-run
 *   clone only (later runs fetch tags from the checkout's origin). Defaults to
 *   REPO_URL; an empty or non-string override is rejected rather than cloned.
 * @returns {number} 0 on success; throws on any failed git step.
 */
export function updateSkills(vendorDir, repoUrl = REPO_URL) {
  if (typeof repoUrl !== 'string' || repoUrl.trim() === '') {
    fail('repoUrl must be a non-empty string')
  }
  if (existsSync(vendorDir) && !isGitCheckout(vendorDir)) {
    fail(`vendor directory exists but is not a git checkout: ${vendorDir}\n` +
      'Remove it or pass a different --dir, then retry.');
  }

  if (!isGitCheckout(vendorDir)) {
    mkdirSync(dirname(vendorDir), { recursive: true });
    console.error(`[dsh-superpowers] cloning ${redactCredentials(repoUrl)} -> ${vendorDir}`);
    const clone = runGit(['clone', '--depth', '1', repoUrl, vendorDir], dirname(vendorDir));
    if (clone.status !== 0) {
      fail(`git clone failed (exit ${clone.status ?? 'null'}) for ${redactCredentials(repoUrl)}`);
    }
  }

  console.error('[dsh-superpowers] fetching tags');
  const fetch = runGit(['fetch', '--tags', '--force', 'origin'], vendorDir);
  if (fetch.status !== 0) {
    fail(`git fetch --tags failed (exit ${fetch.status ?? 'null'}) in ${vendorDir}`);
  }

  const tagList = runGitCapture(['tag', '--sort=-v:refname'], vendorDir);
  const tag = (tagList.stdout ?? '').split(String.fromCharCode(10)).map((line) => line.trim()).find((line) => line !== '') ?? '';
  if (tagList.status !== 0 || tag === '') {
    fail(`could not resolve the newest tag from ${vendorDir}`);
  }

  const rev = runGitCapture(['rev-list', '-n', '1', tag], vendorDir);
  const hash = (rev.stdout ?? '').trim();
  if (rev.status !== 0 || hash === '') {
    fail('could not resolve the commit for tag ' + tag);
  }

  console.error(`[dsh-superpowers] checking out ${tag}`);
  const checkout = runGit(['checkout', '--force', tag], vendorDir);
  if (checkout.status !== 0) {
    fail(`git checkout ${tag} failed (exit ${checkout.status ?? 'null'}) in ${vendorDir}`);
  }

  console.log(`Resolved superpowers tag: ${tag}`);
  console.log(`Commit: ${hash}`);
  return 0;
}

/**
 * Print path/exists/git/tag/skill dirs. Never mutates the checkout, never
 * throws (exit 0 is informational): unreadable inputs are named on stderr as
 * "dsh-superpowers: ..." diagnostics.
 */
export function status(vendorDir) {
  const pathExists = existsSync(vendorDir);
  const isGit = isGitCheckout(vendorDir);
  let tag = null;
  if (isGit) {
    const described = runGitCapture(['describe', '--tags', '--always'], vendorDir);
    if (described.status === 0) {
      tag = (described.stdout ?? '').trim() || null;
    } else {
      // Keep the n/a line, but say why: a failed describe is not "no tags".
      console.error(`dsh-superpowers: could not read the tag in ${vendorDir} (${gitFailureCause(described)})`);
    }
  }
  const skillsDir = skillsDirFor(vendorDir);
  let skills = [];
  if (existsSync(skillsDir)) {
    const { entries, error } = readSkillEntries(skillsDir);
    if (error) {
      console.error(`dsh-superpowers: skills directory unreadable at ${skillsDir} (${error.message})`);
    } else {
      skills = skillDirsFromEntries(skillsDir, entries);
    }
  }

  console.log(`vendor dir: ${vendorDir}`);
  console.log(`exists: ${pathExists ? 'yes' : 'no'}`);
  console.log(`git: ${isGit ? 'yes' : 'no'}`);
  console.log(`tag: ${tag ?? 'n/a'}`);
  console.log(`skill dirs: ${skills.length}`);
  if (skills.length > 0) {
    console.log(`skills: ${skills.join(', ')}`);
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
    console.error(`dsh-superpowers: ${error.message}`);
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
    console.error(`dsh-superpowers: ${error.message}`);
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
