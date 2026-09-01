Provides access to a single folder, files/. It creates a docker container with a single folder mounted. It disallows symlink traversal for this process. It exposes:

- create_file: gets filename (with path), file content (optional), and creates the file.
- read_file: gets filename (with path), an optional "show_line_numbers" (defaults to false), and returns the file contents.
- search_and_replace: gets a regex pattern string and a substitution string (supporting e.g. \1 for the first capturing group and so on), and obviously the filename.
- edit_file: gets "before", "after". It finds "before" in the text and changes it to "after". If multiple matches are found, it gives an error message stating that a wider before block might be necessary.
- edit_lines: gets "replace_line_start", "replace_line_end", "text". It deletes the lines from start to end and replaces them with the given text.
- shell: gives shell access inside a docker with only this folder mounted and no symlink traversal.

ADDITIONAL SETTINGS
the files/ folder. Only one.

## ASSUMPTIONS
- File operations (create/read/edit/search_and_replace/edit_lines) run directly on the host inside the sandbox root, with symlink-traversal protection enforced per path component. Only the `shell` functionality actually spawns a docker container mounting the folder read-write at /sandbox.
- dockerExecutable is an additional setting (default "docker") so podman etc. work; also dockerImage and timeoutMs.
- search_and_replace uses JS regex flavor with $1-style substitutions (not \1).
- edit_lines lines are 1-indexed and inclusive.
