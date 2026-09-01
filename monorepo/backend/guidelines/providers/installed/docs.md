It allows read-only access to a folder, allowing reading all files inside to learn more about something.
Docs are manually downloaded by the user and setup in the docs/ folder. For example, the user might want to create docs/react; docs/my-app; docs/cooking; whatever they want.

Exposed functionality:
- list_docs: lists the folders in the "docs" folder, which are supposed to be divided by topic
- read_structure: takes a string as argument ("react", "my-app", ...) returns a tree view of the whole doc folder for that topic. the second argument defines whether only directories should be shown, or files too
- read_file: reads one specific file in the docs structure, takes the path of the file and topic (e.g. "react", "reactive-components/buttons.md" opens the file found in docs/react/reactive-components/buttons.md). Disallows ".."
- search: takes a search string, a topic and an optional subpath ("only look into the reactive-components folder") and returns the result of grepping inside that folder for that string, case insensitive. Avoids prompt injection.
- search_regex: same as above, with regex.

both the searches and read_structure by default return an error string if the output is too large, and advise to add a param to allow large output to the request if they're sure they need it. The "allow large output" param can be "head", "tail", "all".


ADDITIONAL SETTINGS
what file size is too big
docs folder(s). They're dynamically linked inside docs/, so the AI can see them all.

## ASSUMPTIONS
- "Avoids prompt injection" interpreted pragmatically: no content is executed, output size caps force explicit opt-in (allow_large_output: head|tail|all), ".." rejected everywhere.
- maxOutputSize additional setting (chars); searches return `file:line: excerpt` lines capped at 500 chars each.
- docsFolder setting points at the dynamically-linked docs/ root.

## IMPLEMENTED
- search_regex and files-provider regex run inside a worker thread with a 5s timeout (ReDoS protection, per user request); plain substring search stays in-process.
