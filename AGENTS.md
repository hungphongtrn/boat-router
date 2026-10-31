# Repository guidance

Keep machine starts disabled by default. Preserve durable idempotency keys, webhook tombstones, ownership checks, and reset verification. Do not log credentials, request bodies, or JIT configurations. Reset failure diagnostics may include the bounded, redacted command output. Run the tests, syntax checks, and dry build before proposing a deployment.
