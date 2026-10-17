# omp-roundtable

Roundtable delivers ordered GitHub issues through isolated OMP seats, durable local protocol state, source-confirmed effects, and fresh independent gates.

## Starting a coordinator

A roundtable starts from the issue it delivers, never from a switch inside a session. The issue carries one link:

```
http://127.0.0.1:47591/tern/<owner>/<repo>/issues/<number>?cwd=<absolute local checkout>
```

Install the extension as an omp plugin (`omp plugin install omp-roundtable`), then install the link launcher once — from any omp session with `/roundtable-launcher install`, or from the package CLI with `omp-roundtable-launcher install`. `install` writes `~/Library/LaunchAgents/com.ohmyomp.roundtable-launcher.plist` and leaves `127.0.0.1:47591` answering; `uninstall` removes it and `status` reports it.

The launcher holds no state of its own. It reads the link, calls Tern, and returns one page naming exactly one outcome: `launched` (a coordinator tab now runs `omp --roundtable <owner>/<repo>#<number>` in the link's `cwd`), `focused` (a live block already runs that exact reference and was focused instead), `rejected` (unsupported frontend, malformed path or number, a `cwd` that is not an existing absolute directory, or a request that is not a user's click navigation), or `frontendFailed` (Tern's own output). Only `Sec-Fetch-Mode: navigate` with `Sec-Fetch-User: ?1` is served, because any page can GET `127.0.0.1` and GitHub drops Referer on the https→http hop; the click is the operator's authorization. The port and the `tern` frontend are part of the published link contract.

## The coordinator

`--roundtable` is the whole identity. From `session_start` the process's Main is the coordinator for that issue and stays it for the process's life: it receives one startup message naming the issue and every saved active agenda, reads the issue completely, then calls `roundtable` itself with a strict `{"input": ...}` object — `convene` with `mode` `plan` or `execute` for new work, `resume` with a confirmation that the original process ended for a saved active agenda. Owner and gate seats of the current agenda use `tickets` and `reply`. Ending a coordinator means ending its omp process.

Without the flag the extension registers nothing else: no active `roundtable` tool, no timers, no roundtable state.

The controller persists accepted replies and external-write intents before returning, then executes and confirms each effect separately. An unfinished agenda stays in `roundtable.dataDir`, and the next coordinator for that issue resumes it.
