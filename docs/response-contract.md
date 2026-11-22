# Response contract: ok, degraded, failed

Every tool in the ecosystem answers in one of three states, and the state is part
of the shape, not a sentence in prose.

| Status | Meaning | What the caller can do |
|---|---|---|
| `ok` | Did what was asked, in full. | Use the result. |
| `degraded` | Produced something, but lossy, partial, filtered or substituted. | Use it, knowing what is missing. |
| `failed` | Produced nothing usable. | Fix the input or the environment; do not consume the payload. |

## Shape

`hela.pipe` reports the roll-up, and each step reports its own state:

```json
{
  "ok": true,
  "status": "degraded",
  "steps": 2,
  "degraded": [
    { "step": 0, "cell": "hela-mitosis", "tool": "get_skill", "reasons": ["filesOmitted: 20"] }
  ],
  "results": [
    { "step": 0, "status": "degraded", "ok": true, "degraded": ["filesOmitted: 20"] },
    { "step": 1, "status": "ok", "ok": true }
  ]
}
```

`ok` is kept for compatibility. `status` is the axis that carries the truth:
a degraded result is `ok: true` **and** `status: "degraded"`, and it never sets
`isError`. A failure sets `ok: false`, `status: "failed"` and `isError: true`.

## How a cell marks degradation

Any of these on the JSON payload is picked up by the runtime:

- `degraded: true` or `degraded: { reason }`
- `partial: true` or `partial: { reason }`
- `truncated: true`
- `status: "degraded"`
- `warnings: ["…"]` — each entry becomes a reason

Prefer the object form: a reason is required by the contract, and "truncated"
alone does not tell the caller what to do about it.

## The three rules

1. **An assertion requires evidence.** Do not state a conformance level,
   availability, or classification the tool did not establish. "Could not
   verify" is not "verified absent".
2. **Never propagate a failure as input.** `{{prev}}` is never filled with a
   failed step's error payload; with `onError: "continue"` it becomes null so
   the next step fails loudly instead of analysing an error string.
3. **Degraded must be visible in the shape.** A boolean `success` cannot express
   it, which is why it kept being set to `true`.

## Why it matters for piping and generated code

Under `hela.pipe` and under code mode the intermediates stay inside the
execution boundary. A tool that degrades quietly is never seen by anything that
could catch it, and the model reports a confident answer built on a hole. The
`status` field is the only surface on which that hole is visible.
