# DSH tool mapping for superpowers skills

When a superpowers skill names an abstract action, use the DSH tool on the right:

invoke a skill        -> skill tool (or /<name> user invocation)
dispatch a subagent   -> subagent / subagent_fork
todo / task tracking  -> todo_write
read / write / edit   -> read / write / edit
run shell / tests     -> bash
web fetch / search    -> web_fetch / web_search
deliver a file        -> present

The skill bodies themselves never name a specific tool; this mapping is DSH-specific.
