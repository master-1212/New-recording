# Security policy

## Supported version

Only the current production deployment from the `main` branch is supported. Keep the browser and operating system fully updated before processing sensitive recordings.

## Reporting a vulnerability

Do not open a public issue for a vulnerability, suspected credential exposure, or recording disclosure. Use the repository's **Security → Report a vulnerability** form so the report remains private. Include the affected commit, reproduction steps, impact, and whether any secret or recording may have been exposed.

If a credential may have leaked, revoke and rotate it immediately before waiting for a code fix. Never attach real recordings, tokens, private keys, recovery codes, or `.env` files to a report.

## Security boundary

VoiceScope processes recordings locally in the browser. The application has no recording-upload API, user database, or authentication backend. Optional Whisper model files are downloaded from the pinned public model revision; uploaded audio is never included in those requests.

No browser application can protect a recording after the device, browser profile, GitHub/Vercel account, or deployed same-origin JavaScript has been compromised. Use Sensitive Session mode for high-risk audio, FileVault/device encryption, strong account passkeys, and a fully patched operating system.
