# Configurable web console bind host

## Problem Statement

The web console currently binds to `127.0.0.1` and only accepts loopback Host headers. A user cannot open it from another device over a trusted network such as Tailscale. This feature adds an opt-in IP bind host while preserving loopback behavior by default.

## Goals

- [ ] Resolve `web.host` to a valid IPv4 or IPv6 address and keep `127.0.0.1` as the default.
- [ ] Carry the resolved host through the CLI, daemon supervisor, web child, and in-process server.
- [ ] Accept requests addressed to local interface IPs and the machine hostname when bound beyond loopback, while keeping the existing token and origin checks.
- [ ] Explain the new config and parameters in README and protocol documentation.

## Out of Scope

| Feature | Reason |
| --- | --- |
| TLS or HTTPS | The requested feature only adds an opt-in bind address. |
| Authentication beyond the existing token | WH-13 keeps the current token and cookie checks. |
| A `web.allowedHosts` list | WH-12 defines the accepted names from local interfaces and the machine hostname. |
| Hostnames in `web.host` | WH-02 accepts only values that `net.isIP` accepts. |
| Changing the default bind host | WH-01 requires `127.0.0.1` by default. |
| `--host` on `review`, `setup`, or `usage` | Those commands inherit `web.host` through `launchWebPage`. |
| Changes to `review.ts` or `usage-routes.ts` URL parsing bases | The requested host behavior is implemented in the shared web launch path. |
| Dependency installation or changes to old feature specs | The implementation uses existing Node APIs and this feature supersedes the old remote-access exclusion. |
| Pushing changes | The requested workflow explicitly forbids pushing. |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| A malformed top-level `web` value | Treat it as an invalid host setting and report the raw JSON value. | This matches `resolveWebPort` handling for malformed `web` sections. | No |
| A valid explicit `ui --host` with invalid configured `web.host` | Use the explicit host and still report the invalid config value. | WH-03 requires the CLI warning and WH-04 makes the flag an override. | No |
| Supervisor host identity | Store the bind host and whether it came from an explicit request, config preference, or no host request. | The child handshake has no host field, and WH-09 plus WH-17 through WH-19 define host reuse and restart rules. | No |
| Host header comparison | Compare the complete host and port case-insensitively. | WH-12 requires case-insensitive matching and the exact console port. | No |
| Wildcard alternate links | Use each non-internal IPv4 interface address and preserve the requested path, query, and token. | WH-14 requires one tokenized link for each such address. | No |
| URL host formatting | Advertise loopback for `127.0.0.1`, `0.0.0.0`, and `::`; bracket other IPv6 hosts. | WH-10 specifies this mapping. | No |
| Loopback warning suppression | Suppress the warning for IPv4 `127.0.0.0/8` and IPv6 `::1`. | WH-15 gives these loopback ranges. | No |
| Documentation verification | Add a focused Vitest check for the required README and protocol text. | The task matrix calls for a test file and Vitest command for each layer. | No |

**Open questions:** none. These choices are recorded in `.specs/features/web-host/run-notes.md`.

## User Stories

### P1: Bind the console to a configured address

**User Story**: As a CodeDeck user, I want to choose an IP address for the console so that I can open it from another trusted device.

**Why P1**: Remote access is the feature goal, and the existing loopback default must remain safe and compatible.

**Acceptance Criteria**:

1. WHEN config has no `web.host` THEN the resolved host SHALL be `127.0.0.1`. <!-- WH-01 -->
2. WHEN `web.host` is a string accepted by `net.isIP` as IPv4 or IPv6 THEN the resolved host SHALL be that string. <!-- WH-02 -->
3. IF `web.host` is present but is not an IP string THEN the resolved host SHALL be `127.0.0.1`, and the CLI SHALL write `Ignoring invalid web.host in config: <JSON value>` to stderr while the daemon SHALL report the same message in its log. <!-- WH-03 -->
4. WHEN `codedeck ui --host <addr>` is given THEN the CLI SHALL use that address instead of the resolved `web.host` for that launch. <!-- WH-04 -->
5. IF `codedeck ui --host <addr>` is given and `<addr>` is not an IP string THEN the CLI SHALL write `--host must be an IP address` to stderr, exit with code 1, and make no daemon request. <!-- WH-05 -->
6. WHEN the daemon starts a web child for a resolved host THEN the child SHALL listen on that host using `--host <addr>`, and parsing child arguments without `--host` SHALL resolve to `127.0.0.1`. <!-- WH-06 -->
7. WHEN the CLI serves in-process after the daemon is unavailable THEN `startWebServer` and `listenWebServer` SHALL listen on the resolved host, defaulting to `127.0.0.1` when the option is absent. <!-- WH-07 -->
8. WHEN daemon autostart starts the web child THEN `autostartWeb` SHALL pass the host resolved from config. <!-- WH-08 -->

**Independent Test**: Set `web.host` to a local interface IP, run `codedeck ui --no-open`, and verify the daemon child and CLI URL use that host. Omit `web.host` and verify the URL remains on `127.0.0.1`.

### P1: Preserve the console's request protections

**User Story**: As a user opening the console over a trusted network, I want requests to keep the existing Host, token, cookie, and origin protections.

**Why P1**: Binding beyond loopback must still reject unrelated hosts and unauthenticated actions.

**Acceptance Criteria**:

1. WHILE the bind host is `127.0.0.1` THEN the server SHALL allow exactly `127.0.0.1:<port>` and `localhost:<port>` as Host headers. <!-- WH-11 -->
2. WHILE the bind host is anything other than `127.0.0.1` THEN the server SHALL allow the exact non-wildcard bind address, current local interface addresses, the exact `os.hostname()`, and `<hostname>.<one or more labels>.ts.net` Host names with the exact console port; names such as `<hostname>.evil.com` SHALL be rejected, interface addresses SHALL be evaluated per request through an injectable seam, IPv6 addresses SHALL use brackets, and addresses with a `%` zone SHALL be skipped. <!-- WH-12 -->
3. WHEN a Host header is accepted THEN the server SHALL apply the existing token, cookie, same-origin POST, and `/api/*` checks unchanged; a page GET on a Tailscale IP without a token or cookie SHALL return the existing 403 page body, and a GET with the correct `t` token SHALL return 303 and set the session cookie. <!-- WH-13 -->
4. WHEN `web.ensure` supplies an explicit `host` different from the running child's host THEN the supervisor SHALL stop that child and start a child on the requested host; an omitted `host` SHALL NOT request a move to `127.0.0.1`, and existing port reuse rules SHALL remain unchanged. <!-- WH-09 -->
5. WHEN the bind host is `127.0.0.1`, `0.0.0.0`, or `::` THEN the supervisor and `listenWebServer` SHALL return `http://127.0.0.1:<port>` as the base URL; for any other host they SHALL return `http://<host>:<port>`, with IPv6 in brackets. <!-- WH-10 -->
6. WHEN `web.ensure` supplies a `preferredHost` different from the running child's host AND the child was started for a preferred host or with neither host field THEN the supervisor SHALL stop that child and start a child on `preferredHost`. <!-- WH-17 -->
7. WHEN `web.ensure` supplies a `preferredHost` AND the running child was started for an explicit host THEN the supervisor SHALL keep that explicit bind host. <!-- WH-18 -->
8. WHEN `web.ensure` supplies neither `host` nor `preferredHost` THEN the supervisor SHALL reuse a running child regardless of its bind host, and SHALL start a new child on `127.0.0.1` when none is running. <!-- WH-19 -->
9. WHEN a page GET uses `Host: localhost:<port>` and the bind host is `127.0.0.1`, `0.0.0.0`, or `::` THEN the server SHALL respond with `302` to `http://127.0.0.1:<port>`; for any other bind host it SHALL skip this canonical redirect. <!-- WH-20 -->
10. IF `web.ensure` supplies a `host` or `preferredHost` that `net.isIP` rejects THEN the supervisor SHALL return `WEB_BAD_HOST` before stopping a running child. <!-- WH-21 -->

**Independent Test**: Bind to a wildcard address, send requests with a local interface Host, a hostile Host, and tokenized or untokenized page URLs, and verify the exact response behavior.

### P2: Print usable links and bind errors

**User Story**: As a user launching the console, I want links for local interfaces and clear warnings when the console listens beyond loopback.

**Why P2**: The selected host can be different from the URL host used for wildcard binds, and plain HTTP on a reachable interface needs a clear notice.

**Acceptance Criteria**:

1. WHEN the resolved host is `0.0.0.0` or `::` THEN after the existing `<title> on <url>` line the CLI SHALL print one `Also on http://<ip>:<port><path>?t=<token>` line for each non-internal IPv4 interface address. <!-- WH-14 -->
2. IF the resolved host is outside both IPv4 `127.0.0.0/8` and IPv6 `::1` THEN the CLI SHALL write `Warning: the console listens on <host> over plain HTTP. Anyone who can reach port <port> with the link gets full access; use it only on a trusted network such as Tailscale.` to stderr. <!-- WH-15 -->
3. IF either CLI listen path fails THEN `src/cli/web-launch.ts` SHALL report `Failed to listen on <host>:<port>: <message>`, with IPv6 hosts bracketed, and exit with code 1. <!-- WH-16 -->

**Independent Test**: Launch with a wildcard host and verify the base line, alternate links, and warning; occupy a selected host and port and verify the failure names that host.

## Documentation

`README.md` SHALL describe `web.host`, `codedeck ui --host`, the child `--host` argument, and the `host` parameter of `web.ensure`. `docs/protocol.md` SHALL document the same protocol parameter in Portuguese.

## Edge Cases

- Invalid values include non-strings and strings that `net.isIP` rejects.
- A child started with no `--host` must retain the current loopback behavior.
- A host change must restart a running child even when its port selection otherwise permits reuse.
- Host headers with an unlisted name or a wrong port must remain forbidden.
- Hostname matching is limited to the exact machine hostname or one or more labels followed by `.ts.net`.
- A non-wildcard bind address remains accepted as a Host even if it is absent from the current interface list.
- IPv6 zone-scoped interface addresses must not enter the allowlist.
- A failed `--host` validation must occur before starting or contacting the daemon.
- Invalid `web.ensure` host fields must be rejected before a running child is stopped.

## Implicit-requirement sweep

| Dimension | Resolution |
| --- | --- |
| Input validation and bounds | WH-02, WH-03, WH-05, and WH-21 require `net.isIP` validation. |
| Failure and partial-failure states | WH-03, WH-05, WH-16, and WH-21 define invalid config, invalid host requests, and listen failure outcomes. |
| Idempotency and retry | WH-09 and WH-17 through WH-19 define child reuse and restart behavior by host request and start origin. |
| Auth boundaries and rate limits | WH-11 through WH-13 keep the existing Host and token checks; rate limiting is N/A because this feature does not change request authorization behavior. |
| Concurrency and ordering | WH-09 and WH-17 use the existing single-child supervisor transition when the requested host changes. |
| Data lifecycle and expiry | N/A because the feature adds no persisted data. |
| Observability | WH-03 reports invalid config, WH-15 warns about reachable plain HTTP, and WH-16 reports the listen host. |
| External-dependency failure | WH-16 covers OS listen failures; no new external service is introduced. |
| State-transition integrity | WH-09, WH-17 through WH-19, and WH-21 define host transitions, reuse, and validation order. |

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| WH-01 | P1: Bind the console to a configured address | Tasks | Verified |
| WH-02 | P1: Bind the console to a configured address | Tasks | Verified |
| WH-03 | P1: Bind the console to a configured address | Tasks | Verified |
| WH-04 | P1: Bind the console to a configured address | Tasks | Verified |
| WH-05 | P1: Bind the console to a configured address | Tasks | Verified |
| WH-06 | P1: Bind the console to a configured address | Tasks | Verified |
| WH-07 | P1: Bind the console to a configured address | Tasks | Verified |
| WH-08 | P1: Bind the console to a configured address | Tasks | Verified |
| WH-09 | P1: Preserve the console's request protections | Tasks | Implemented |
| WH-10 | P1: Preserve the console's request protections | Tasks | Verified |
| WH-11 | P1: Preserve the console's request protections | Tasks | Verified |
| WH-12 | P1: Preserve the console's request protections | Tasks | Implemented |
| WH-13 | P1: Preserve the console's request protections | Tasks | Verified |
| WH-14 | P2: Print usable links and bind errors | Tasks | Verified |
| WH-15 | P2: Print usable links and bind errors | Tasks | Verified |
| WH-16 | P2: Print usable links and bind errors | Tasks | Verified |
| WH-17 | P1: Preserve the console's request protections | Tasks | Implemented |
| WH-18 | P1: Preserve the console's request protections | Tasks | Implemented |
| WH-19 | P1: Preserve the console's request protections | Tasks | Implemented |
| WH-20 | P1: Preserve the console's request protections | Tasks | Implemented |
| WH-21 | P1: Preserve the console's request protections | Tasks | Implemented |

**Coverage**: 21 requirements, 21 mapped to tasks, 0 unmapped.

## Success Criteria

- [ ] The default bind remains `127.0.0.1` and every WH criterion passes its scoped tests.
- [ ] A Tailscale or local interface address can open the console with the existing token flow.
- [ ] README and protocol documentation describe each requested host setting and parameter.
