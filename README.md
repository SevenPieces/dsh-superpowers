# dsh-superpowers

A standalone out-of-tree DSH plugin that ports the superpowers skill library:
- registers a skill provider over the vendored https://github.com/obra/superpowers checkout, and
- registers the using-superpowers bootstrap as a system-prompt section whose text provider is re-composed from disk at each prompt assembly.

Runtime source is vendor-only and independent of any other harness install.

Tested with dsh-v0.2.1-rc.2

## Install

dsh plugin --profile web add ~/.dsh/plugins/dsh-superpowers

## Update the skills

dsh plugin --profile web exec dsh-superpowers update-skills

Or directly: node bin/dsh-superpowers.mjs update-skills
Status: node bin/dsh-superpowers.mjs status (prints the vendor path, whether it exists, whether it is a git checkout, the tag, and the skill dirs count; it writes a stderr diagnostic when the tag or the skills directory cannot be read, masking URL userinfo (user:password@) in a remote URL)

Only URL userinfo is masked: a token carried in a query string or fragment of a remote URL (for example ?token=...) is not detected or removed.

The command checks out the newest tag by version sort and does not pin a commit or verify a signature: whatever the upstream repository publishes at that tag becomes the skills and bootstrap text this plugin loads. Treat update-skills as a trust decision and review the checkout (`git -C vendor/superpowers log -1`, `git -C vendor/superpowers diff <old-tag> <new-tag>`) if provenance matters to you.

The profile-mutating form (`dsh plugin ... exec`) needs write access to the installed profile. In a sandbox that makes the profile read-only (for example a workspace-write sandbox) that write is rejected and the update does not run; use the bin directly with a checkout directory you can write:

```
node bin/dsh-superpowers.mjs update-skills --dir <writable vendor checkout>
```

Each git step this CLI runs - clone, fetch, tag lookup, checkout, and status's describe - is bounded by a timeout: five minutes by default, overridable with a positive-integer `DSH_SUPERPOWERS_GIT_TIMEOUT_MS`. Git's own output is captured and reprinted with control and bidi characters escaped, so vendor-controlled ref text cannot rewrite the terminal. A timed-out step kills the direct git child; processes it spawned may briefly survive. Captured output is bounded at 16 MiB per step, so a large tag set is accepted while pathological output fails closed.

A skills-content upgrade takes effect on the next model request, without reloading the plugin: the bootstrap section provider re-reads the vendor tree at each assembly, and each skill body is re-read on every lookup. The harness does cache the discovered catalog (skill names and descriptions) until that cache is invalidated, so adding, removing or renaming a skill directory may not show up in an already-running session until then.

Changing the plugin's own code (lib/, bin/) is different. The plugin row is mounted once when the dsh process loads, and reloading the profile patch re-composes the row tree without replacing already-imported source modules, so a code change needs a dsh process restart before it runs (unless a profile explicitly enables module-reload HMR); the skills-content promise above does not apply to it.

## Config (optional, via the profile patch row)

skillsDir, toolMappingPath, providerName, rank, sectionName, sectionOrder, injectBootstrap.

A relative skillsDir or toolMappingPath resolves against the plugin directory, not the process working directory; absolute paths are used as given.

The composed bootstrap embeds the absolute vendored skills directory twice - the direct-read path pattern and the directory line - so that local path reaches the model provider as part of the always-on prompt. The frozen composition test replaces those occurrences with `<SKILLS_DIR>` before asserting length and sha256, which is what makes it install-path independent.

sectionName is the system-prompt section name and sectionOrder its numeric placement (default 250). The bootstrap is a system-prompt section evaluated at each assembly, not a session-start user message. Set injectBootstrap: false to register no section.

## Failure behavior

Fail-open and logged, but the two channels recover differently. A missing vendor checkout yields an empty skill catalog plus a ctx.logger warning telling you to run update-skills, and the bootstrap section contributes empty text with its own deduplicated warning naming the same command. When the vendor tree later appears the bootstrap self-heals on the next prompt assembly, because its text provider re-reads disk; the skill catalog does not, because the harness caches discovered skill names and descriptions for the session. A newly vendored or changed catalog therefore becomes visible only after the host invalidates that cache or in a new session. No silent failures, no network at boot.

Outage and skip warnings are deduplicated per distinct message while the condition persists, and are emitted again if the condition clears and recurs, so a second outage is not silent; a failed body load is reported on each failed lookup. Discovery reports every entry it skips (missing SKILL.md, unreadable SKILL.md with its cause, invalid UTF-8, empty description, invalid frontmatter name, non-directory entry) instead of dropping it quietly - entries whose name starts with a dot are the one deliberate exception, and are ignored silently - and an empty SKILL.md body is never served as skill content. Control characters in a skipped entry name or cause are escaped in the warning, so a crafted directory name cannot forge a log line.

File reads are strict UTF-8: a SKILL.md or bootstrap that is not valid UTF-8 is treated as unreadable, named with its cause in a warning, and never served as prompt or skill content, so a corrupted file cannot silently become U+FFFD replacement text.

Vendor-derived text is neutralised before it enters the always-on section: the plugin's own <EXTREMELY_IMPORTANT> delimiters and strict {{...}} template groups found inside a skill body or the tool mapping are escaped, so an upstream change cannot break out of the wrapper or break prompt assembly. The hyphenated upstream tokens are left untouched.

A throwing host logger can no longer break plugin activation or prompt assembly: every log call goes through a wrapper that swallows the failure.

## Tests

npm test

The suite derives its external facts from the checkout under vendor/superpowers: the expected tag comes from `git -C vendor/superpowers describe --tags` and the expected skill-dir count from the directories on disk, so running update-skills does not require editing those expectations. The frozen composition check is path-normalized: it replaces the absolute skills directory with `<SKILLS_DIR>` before asserting length and sha256, so the same checkout passes at any install path. That normalized hash changes only when the composed inputs change - the vendored using-superpowers body or the tool mapping in references/ - not when the checkout moves.

## Known limitations

- Catalog freshness. A running session caches the discovered skill names and descriptions. Editing an existing skill body takes effect on the next lookup, and the bootstrap is recomposed at every prompt assembly, but adding, removing or renaming a skill directory - or changing a description - becomes visible only to a new session, until the harness invalidates its catalog.
- Tag selection is by version sort, prereleases included. update-skills checks out the highest tag under git tag --sort=-v:refname, so v6.4.0-rc1 would win over v6.3.0. This is deliberate and covered by the suite.
- Neutralisation is literal. Only the plugin's own underscore delimiters and strict {{...}} template groups are escaped, and the escape is never undone, so the model sees a backslash in the rare case where vendor text contained one of those sequences. Case or whitespace variants of the delimiter are not matched. The hyphenated upstream tokens are deliberately left untouched.
- "skill dirs" is not the catalog size. status counts directories containing a SKILL.md; registration additionally requires a valid frontmatter name and a non-empty description, so the two numbers can differ.
- The test suite drives the plugin's own seams with host doubles rather than the real DSH packages. Host-level behaviour (catalog caching, prompt assembly) is therefore covered by inspection and by the plugin's guarantees about its own inputs, not by the suite itself.
