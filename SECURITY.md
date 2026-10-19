# Security Policy

## Reporting a Vulnerability

Please report security issues privately instead of opening a public issue.

If this project is hosted under your own fork, use GitHub's private vulnerability reporting when available. Otherwise, contact the maintainer through a private channel and include:

- affected version or commit
- reproduction steps
- impact
- suggested mitigation, if known

## Sensitive Data

AI keys entered in the settings page are stored in the OS credential store (macOS Keychain via the `security` CLI; the Windows DPAPI path is a stub pending real-machine verification). The on-disk `settings.local.json` only keeps `keychain:aimw/<field>` references, never the key itself.

### Desktop shell (Tauri)

The `.app` bundle embeds a Node runtime (`sidecar/node/bin/node`) plus a bundled server
(`sidecar/server/server.mjs`) and its production dependencies under
`Contents/Resources/sidecar/`. The WebView is pointed at `http://127.0.0.1:<port>/` so that
the client and the sidecar share an origin — the client derives its WebSocket URL from
`window.location.host`, so any other scheme/port would silently break `/ws` and `/audio`.

The sidecar listens on loopback only (`APP_HOST=127.0.0.1`); it is not reachable from the
network. Meeting data and the keychain references stay inside the per-user application data
directory, and no model weights are shipped in the bundle — they are downloaded on demand
through the model wizard. `.env`, `.local-data/` and voiceprint `*.pkl` databases are
gitignored and must never be committed.


Keys that were previously saved as plaintext may already be exposed, so the settings page shows a reminder to rotate them at each vendor console (Volcengine Ark Coding Plan, DeepSeek, OpenAI, Volcengine ASR).

AI Discussion is local-first, but local data can contain sensitive audio, transcripts, and discussion exports.

Never commit:

- `.env`
- `.local-data/`
- real audio recordings (the documented Kokoro-generated fictional demo WAV is the sole public exception)
- SQLite databases
- exported discussion packages containing private conversations
- API keys, tokens, or third-party credentials
