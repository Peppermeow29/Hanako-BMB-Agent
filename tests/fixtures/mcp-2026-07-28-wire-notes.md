# MCP 2026-07-28 wire format notes

Pinned from the published specification on 2026-07-30. Every item below carries its
source URL. This file is the reference for the dual-track HTTP client tests and
implementation; do not write protocol fields from memory, change this file first.

Terminology used by the spec itself:

- **Modern** = revisions that carry version / identity / capabilities as per-request
  metadata (`2026-07-28` and later).
- **Legacy** = revisions that establish a session with an `initialize` handshake
  (`2025-11-25` and earlier).
- **Dual-era** = an implementation supporting both.

Source: <https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning>

---

## (1) What a stateless request must carry

Source: <https://modelcontextprotocol.io/specification/2026-07-28/basic> (`_meta` section)

There is no `initialize` and no session. Every request carries protocol metadata in
`params._meta` under reserved `io.modelcontextprotocol/*` keys:

| Key | Type | Required |
| --- | --- | --- |
| `io.modelcontextprotocol/protocolVersion` | `string` | Yes |
| `io.modelcontextprotocol/clientInfo` | `Implementation` | No (SHOULD send) |
| `io.modelcontextprotocol/clientCapabilities` | `ClientCapabilities` | Yes |
| `io.modelcontextprotocol/logLevel` | `LoggingLevel` | No |

A request missing a required field is malformed: the server must reject with JSON-RPC
`-32602` (Invalid params), and on HTTP the status must be `400 Bad Request`.

Servers SHOULD put `io.modelcontextprotocol/serverInfo` in each result's `_meta`.

`_meta` key naming: optional dotted prefix ending in `/`; any prefix whose second label
is `modelcontextprotocol` or `mcp` is reserved for MCP.

### HTTP protocol version header

Source: <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http> (Protocol Version Header)

Every POST must include `MCP-Protocol-Version`, e.g. `MCP-Protocol-Version: 2026-07-28`.
Its value **must match** `_meta["io.modelcontextprotocol/protocolVersion"]` in the body;
on mismatch the server returns `400` with a `HeaderMismatch` error (`-32020`).

Other HTTP rules on the modern track:

- Every JSON-RPC message is its own POST to the single MCP endpoint.
- `Accept` must list both `application/json` and `text/event-stream`.
- A request gets back either `Content-Type: application/json` or a request-scoped SSE
  stream; the client must support both.
- The GET stream endpoint and protocol-level sessions (`Mcp-Session-Id`, HTTP DELETE,
  `Last-Event-ID` resumption) are **removed** in this revision.
- Servers do not send JSON-RPC requests on any stream any more.

Full worked example of a modern `tools/call` (headers + body) is on the streamable-http
page linked above.

## (2) Failure / non-support signals

Sources:
<https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning> (Protocol Version Negotiation),
<https://modelcontextprotocol.io/specification/2026-07-28/basic> (Error Codes),
<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http> (Server Validation, Backward Compatibility)

MCP-specification error codes (sub-range `-32020`..`-32099` is reserved for the spec):

| Code | Name |
| --- | --- |
| `-32020` | `HeaderMismatch` |
| `-32021` | `MissingRequiredClientCapability` |
| `-32022` | `UnsupportedProtocolVersion` |

`UnsupportedProtocolVersionError` body shape (HTTP status `400`):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32022,
    "message": "Unsupported protocol version",
    "data": {
      "supported": ["2026-07-28", "2025-11-25"],
      "requested": "1900-01-01"
    }
  }
}
```

The client SHOULD pick a mutually supported version from `data.supported` and retry.

`MissingRequiredClientCapability` (`-32021`) carries `data.requiredCapabilities`, also
`400` on HTTP.

Unknown RPC method on a modern HTTP server: `404 Not Found` plus a JSON-RPC error with
code `-32601`. The JSON-RPC body is what distinguishes this from a legacy HTTP+SSE
server's plain `404`.

### Era detection on HTTP (this is the fallback rule we implement)

Try a modern request first. On `400 Bad Request`, inspect the body **before** falling
back, because modern servers also answer `400` for `UnsupportedProtocolVersionError`,
`MissingRequiredClientCapabilityError`, and header-validation failures.

- Body contains a recognized modern JSON-RPC error → server is modern. Retry with an
  advertised supported version or fix the request. **Do not** fall back.
- Body is empty or not a recognized modern JSON-RPC error → fall back to `initialize`
  and continue on the legacy version.

The era is a property of the server, not of a request: clients SHOULD cache it for the
lifetime of the origin (HTTP) or server process (stdio), and MAY persist it, re-probing
if the cached assumption later fails.

Legacy-traffic handling by a modern-only server (informative, explains what we may see):
HTTP GET/DELETE → `405 Method Not Allowed`; `Mcp-Session-Id` → ignored, never minted or
echoed; `Last-Event-ID` → ignored.

## (3) MRTR: `input_required` and `inputResponses`

Sources:
<https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr>,
<https://modelcontextprotocol.io/specification/2026-07-28/server/tools> (Input Required Tool Results),
<https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation>

Every result carries a `resultType`. `"complete"` = final content. `"input_required"` =
the server needs more input. **An absent `resultType` must be treated as `"complete"`**
for backward compatibility with earlier revisions — this is what keeps the legacy track
working unchanged. An unrecognized `resultType` is invalid.
(Source: <https://modelcontextprotocol.io/specification/2026-07-28/basic>, ResultType.)

MRTR replaces server-initiated requests entirely. Servers MUST deliver `roots/list`,
`sampling/createMessage` and `elicitation/create` through MRTR; server-initiated
JSON-RPC requests are no longer supported (breaking change).

`InputRequiredResult` fields:

- `inputRequests` *(optional)*: an `InputRequests` map. Keys are **server-assigned
  string identifiers**, unique within the request. Values are request objects, each with
  `method` and `params`. Allowed methods: `elicitation/create`,
  `sampling/createMessage`, `roots/list`.
- `requestState` *(optional)*: opaque server string. Clients MUST NOT inspect, parse or
  modify it, and MUST echo the exact value back on retry. If absent, the client MUST NOT
  invent one.
- At least one of the two MUST be present.

Example `input_required` response to a `tools/call`:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "resultType": "input_required",
    "inputRequests": {
      "github_login": {
        "method": "elicitation/create",
        "params": {
          "mode": "form",
          "message": "Please provide your GitHub username",
          "requestedSchema": {
            "type": "object",
            "properties": { "name": { "type": "string" } },
            "required": ["name"]
          }
        }
      }
    },
    "requestState": "eyJsb2NhdGlvbiI6Ik5ldyBZb3JrIn0..."
  }
}
```

Retry shape — `inputResponses` and `requestState` sit in **`params`**, alongside the
original `name`/`arguments`, which must be repeated:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "get_weather",
    "arguments": { "location": "New York" },
    "inputResponses": {
      "github_login": { "action": "accept", "content": { "name": "octocat" } }
    },
    "requestState": "eyJsb2NhdGlvbiI6Ik5ldyBZb3JrIn0..."
  }
}
```

Hard client rules:

- The JSON-RPC `id` **MUST differ** between the initial request and the retry; they are
  independent requests.
- `inputResponses` keys correspond to `inputRequests` keys.
- If `inputRequests` is present the client must gather the inputs before retrying; if
  only `requestState` is present the client MAY retry immediately.
- `inputRequests` / `requestState` affect only the retry of that original request.
- `input_required` is only allowed on `prompts/get`, `resources/read` and `tools/call`.

### Elicitation specifics

Client capability declaration, per request, inside
`_meta["io.modelcontextprotocol/clientCapabilities"]`:

```json
{ "elicitation": { "form": {} } }
```

An empty `elicitation: {}` is equivalent to declaring `form` mode only. A client
declaring `elicitation` must support at least one mode. Servers MUST NOT send an
`inputRequests` entry for a capability the client did not declare — so declaring
`elicitation.form` is the precondition for ever receiving `elicitation/create`.

`elicitation/create` params: `mode` (`"form"` | `"url"`; optional, defaults to `form`),
`message` (human-readable reason), plus `requestedSchema` for form mode / `url` for URL
mode. `requestedSchema` is a **flat object with primitive properties only**: string
(with optional `format` of `email`/`uri`/`date`/`date-time`), number/integer, boolean,
and enum forms. Nested structures are intentionally unsupported.

`ElicitResult` (the value placed in `inputResponses`):

```json
{ "action": "accept", "content": { "propertyName": "value" } }
```

`action` is exactly one of `"accept"`, `"decline"`, `"cancel"`. `content` carries the
submitted data only for form-mode `accept`; it is omitted for URL mode and typically
omitted for decline/cancel.

Servers MUST NOT request credentials/secrets via form mode (URL mode exists for that).

## (4) `ttlMs` / `cacheScope` on `tools/list`

Source: <https://modelcontextprotocol.io/specification/2026-07-28/server/tools> (Listing Tools)

Both are **top-level fields of `result`**, siblings of `tools` and `nextCursor`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resultType": "complete",
    "tools": [ /* ... */ ],
    "nextCursor": "next-page-cursor",
    "ttlMs": 300000,
    "cacheScope": "public"
  }
}
```

`ttlMs` is a number of milliseconds. `cacheScope` is a string; `"public"` is the value
shown by the spec examples (also on `server/discover`, which carries the same two fields
— source: <https://modelcontextprotocol.io/specification/2026-07-28/server/discover>).
The general caching rules live at
<https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching>.
Both fields are optional; absent means no caching hint.

## (5) `Mcp-Method` / `Mcp-Name` value rules

Source: <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http> (Standard Request Headers, Value Encoding, Case Sensitivity)

| Header | Source field | Required for |
| --- | --- | --- |
| `Mcp-Method` | `method` | All requests |
| `Mcp-Name` | `params.name` or `params.uri` | `tools/call`, `resources/read`, `prompts/get` |

These headers are REQUIRED for compliance. They mirror body values so intermediaries can
route without parsing the body; the **body stays the source of truth** and a server that
parses the body MUST reject mismatches with `400` + `-32020` `HeaderMismatch`. Missing a
required standard header (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) is itself a
`HeaderMismatch` validation failure.

Header *names* are case-insensitive; header *values* (such as method names) are
case-sensitive.

If the `Mcp-Name` value cannot be represented safely as plain ASCII (non-ASCII, control
characters, leading/trailing whitespace), it MUST be sent Base64-encoded with the
sentinel format, and a plain value that happens to look like the sentinel must also be
encoded to avoid ambiguity:

```text
Mcp-Name: =?base64?{Base64EncodedValue}?=
```

The `=?base64?` prefix and `?=` suffix are lowercase and exact.

Related, and not implemented here: `x-mcp-header` annotations in a tool's `inputSchema`
mirror designated primitive arguments into `Mcp-Param-{Name}` headers, with the same
encoding rules. The spec makes client support mandatory and requires clients to exclude
tools whose annotations violate the constraints.

## (6) stdio in this revision — SUBSTANTIVE CHANGE

Sources:
<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio>,
<https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning>,
<https://modelcontextprotocol.io/specification/2026-07-28/server/discover>

stdio does **not** keep the `initialize` lifecycle on the modern track. Findings:

- Framing is unchanged: newline-delimited JSON-RPC, no embedded newlines, `stderr` free
  for logging, nothing but valid MCP messages on `stdout`.
- All request metadata is carried inline in the body `_meta` — there is no header layer,
  so `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` do not apply to stdio.
- The server MUST NOT write JSON-RPC *requests* to `stdout`; server-to-client
  interactions come back as `InputRequiredResult` replies.
- Era detection is an explicit `server/discover` probe with a three-way outcome:
  `DiscoverResult` → modern; a recognized modern error (e.g. `-32022`) → modern but
  version-mismatched, do **not** fall back; any other error or a timeout → legacy, fall
  back to `initialize`. The fallback MUST NOT be keyed to one error code.
- An open stdio process is explicitly **not** a session; clients should not use a
  conversation as the process lifetime boundary, and should restart the process on
  unexpected exit and simply retry in-flight requests.

`DiscoverResult` shape (`server/discover` is mandatory for servers):

```json
{
  "jsonrpc": "2.0",
  "id": "discover-1",
  "result": {
    "resultType": "complete",
    "supportedVersions": ["2026-07-28"],
    "capabilities": { "tools": {}, "resources": {} },
    "_meta": {
      "io.modelcontextprotocol/serverInfo": { "name": "ExampleServer", "version": "1.0.0" }
    },
    "instructions": "…",
    "ttlMs": 3600000,
    "cacheScope": "public"
  }
}
```

**Consequence:** supporting the modern track on stdio is a real behavioural change, not a
comment update. The stdio client is therefore left on the legacy `initialize` path until
that change is designed deliberately.
