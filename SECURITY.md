# Security policy

## Scope

agent-token-monitor reads local log files and serves a dashboard on `127.0.0.1` only. It makes no network calls and has no telemetry. Relevant issues include:

- a way to make the product write to a harness directory (R-15);
- a way to reach the local server from another host or origin;
- path traversal or reading files outside the configured log roots;
- credentials or real harness logs committed to the repository.

## Reporting a vulnerability

Please do not open a public issue with exploit details. Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**.

Include the version or commit, steps to reproduce and the impact. Reports are handled on a best-effort basis.

## Supported versions

The project is in early development. Only the latest commit on `main` is supported.

## Sharing output

Dashboard screenshots and the JSON API can include session titles, subagent descriptions and project paths. Review them before posting them in an issue.
