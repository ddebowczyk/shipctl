# Work package 2 — agent capability and message operation

## Outcome

An external process can target one named Shipctl instance, discover the active
demo capability, and invoke only its declared agent-accessible typed port.

## Required delivery

- Project the active runtime modules' capability definitions and provider
  bindings into a versioned inspection owned by the instance.
- Add strict local-control operations and CLI commands:

  ```text
  shipctl capabilities list --instance <name>
  shipctl capabilities inspect <capability-id> --instance <name>
  shipctl capabilities call <capability-id> <port-id> \
    --instance <name> --input <json-or-file>
  ```

- Resolve a call from capability and port metadata to the current bus route.
  Rust validates agent access, request and response schemas, provider identity,
  and route generation. The caller never supplies module authority.
- Keep errors structured on stdout and payload-redacted where the declaration
  marks fields secret.
- Use the demo module to handle one typed call, publish one typed topic, and
  consume that topic in its own activation. The returned status proves both
  paths ran; no event history is written.

## Acceptance

- The built CLI discovers the capability only while its provider is active in
  the exact named instance.
- A valid call reaches the packaged module and returns a schema-valid response.
- Unknown capability, private port, invalid payload, incompatible contract, and
  inactive provider fail without delivery and with stable codes.
- Topic delivery is live and non-persistent; restarting resets its observed
  count.
- Inspection and calls expose no arbitrary message-send surface.
