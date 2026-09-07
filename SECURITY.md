# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through the repository's
GitHub Security Advisory page. Do not include credentials, private source code,
or sensitive run artifacts in a public issue.

## Security model

Pi packages execute with the permissions of the Pi process. This project does
not provide a sandbox for workers. Review the source before installation, use
least-privilege credentials, and run concurrent writable workers only in a
checkout where overlapping edits are acceptable.
