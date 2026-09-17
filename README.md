# dsh-superpowers

A standalone out-of-tree DSH plugin that ports the superpowers skill library:
- registers a skill provider over the vendored https://github.com/obra/superpowers checkout, and
- registers the using-superpowers bootstrap as a system-prompt section whose text provider is re-composed from disk at each prompt assembly.

Runtime source is vendor-only and independent of any other harness install.

Tested with DSH 0.1.5-rc.1.

## Install

dsh plugin --profile web add ~/.dsh/plugins/dsh-superpowers

## Update the skills

dsh plugin --profile web exec dsh-superpowers update-skills

Or directly: node bin/dsh-superpowers.mjs update-skills
Status: node bin/dsh-superpowers.mjs status (prints the vendor path, whether it exists, whether it is a git checkout, the tag, and the skill dirs count; it writes a stderr diagnostic when the tag or the skills directory cannot be read)

A skills-content upgrade takes effect on the next model request, without reloading the plugin: the bootstrap section provider re-reads the vendor tree at each assembly, and each skill body is re-read on every lookup. The harness does cache the discovered catalog (skill names and descriptions) until that cache is invalidated, so adding, removing or renaming a skill directory may not show up in an already-running session until then.

Changing the plugin's own code (lib/, bin/) is different. The plugin row is mounted once when the dsh process loads, and reloading the profile patch re-composes the row tree without replacing already-imported source modules, so a code change needs a dsh process restart before it runs (unless a profile explicitly enables module-reload HMR); the skills-content promise above does not apply to it.

## Config (optional, via the profile patch row)

skillsDir, toolMappingPath, providerName, rank, sectionName, sectionOrder, injectBootstrap.

A relative skillsDir or toolMappingPath resolves against the plugin directory, not the process working directory; absolute paths are used as given.

sectionName is the system-prompt section name and sectionOrder its numeric placement (default 250). The bootstrap is a system-prompt section evaluated at each assembly, not a session-start user message. Set injectBootstrap: false to register no section.

## Failure behavior

Fail-open and logged: a missing vendor checkout yields an empty catalog plus a ctx.logger warning telling you to run update-skills, and the bootstrap section contributes empty text with its own deduplicated warning naming the same command. When the vendor tree later appears, both recover on their own. No silent failures, no network at boot.

Outage and skip warnings are deduplicated per distinct message while the condition persists, and are emitted again if the condition clears and recurs, so a second outage is not silent; a failed body load is reported on each failed lookup. Discovery reports every entry it skips (missing SKILL.md, empty description, invalid frontmatter name, non-directory entry) instead of dropping it quietly - entries whose name starts with a dot are the one deliberate exception, and are ignored silently - and an empty SKILL.md body is never served as skill content.

Vendor-derived text is neutralised before it enters the always-on section: the plugin's own <EXTREMELY_IMPORTANT> delimiters and strict {{...}} template groups found inside a skill body or the tool mapping are escaped, so an upstream change cannot break out of the wrapper or break prompt assembly. The hyphenated upstream tokens are left untouched.

A throwing host logger can no longer break plugin activation or prompt assembly: every log call goes through a wrapper that swallows the failure.

## Known limitations

- Catalog freshness. A running session caches the discovered skill names and descriptions. Editing an existing skill body takes effect on the next lookup, and the bootstrap is recomposed at every prompt assembly, but adding, removing or renaming a skill directory - or changing a description - becomes visible only to a new session, until the harness invalidates its catalog.
- Tag selection is by version sort, prereleases included. update-skills checks out the highest tag under git tag --sort=-v:refname, so v6.4.0-rc1 would win over v6.3.0. This is deliberate and pinned by a test.
- Neutralisation is literal. Only the plugin's own underscore delimiters and strict {{...}} template groups are escaped, and the escape is never undone, so the model sees a backslash in the rare case where vendor text contained one of those sequences. Case or whitespace variants of the delimiter are not matched. The hyphenated upstream tokens are deliberately left untouched.
- "skill dirs" is not the catalog size. status counts directories containing a SKILL.md; registration additionally requires a valid frontmatter name and a non-empty description, so the two numbers can differ.
- The test suite drives the plugin's own seams with host doubles rather than the real DSH packages. Host-level behaviour (catalog caching, prompt assembly) is therefore covered by inspection and by the plugin's guarantees about its own inputs, not by the suite itself.
- One test is install-path bound: the frozen composition check pins the exact bytes of the bootstrap for the real vendor tree, and that text embeds the absolute skills directory, so it passes only at the path it was frozen at - a copy of the checkout elsewhere reports 80/81 with that single test failing, while the plugin itself behaves identically anywhere.

