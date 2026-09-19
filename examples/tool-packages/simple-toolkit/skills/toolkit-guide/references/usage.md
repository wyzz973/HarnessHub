`workspace_overview` returns:

    {"root": "<absolute workspace>", "entries": [{"name": "src", "type": "directory"}], "truncated": false}

`cli_wordcount` returns the managed CLI envelope; its `stdout` holds:

    {"cwd": "<absolute workspace>", "results": [{"path": "README.md", "lines": 10, "words": 80, "bytes": 512}]}

A result with `error` means the path was outside the workspace, missing, not a
regular file or larger than 1 MiB. The tool exits with code 1 in that case.
