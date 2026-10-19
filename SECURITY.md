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

Keys that were previously saved as plaintext may already be exposed, so the settings page shows a reminder to rotate them at each vendor console (Volcengine Ark Coding Plan, DeepSeek, OpenAI, Volcengine ASR).

AI Discussion is local-first, but local data can contain sensitive audio, transcripts, and discussion exports.

Never commit:

- `.env`
- `.local-data/`
- real audio recordings (the documented Kokoro-generated fictional demo WAV is the sole public exception)
- SQLite databases
- exported discussion packages containing private conversations
- API keys, tokens, or third-party credentials
