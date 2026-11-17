# AGENTS.md — Cloud Android Emulator Runner

Strict rules for AI agents and contributors working in this repository. Follow them for every change.

## 1. Architecture

- **Frontend**: clean HTML, CSS, and Vanilla JS in `/public`. A lightweight Vite setup is acceptable only if the user asks for it. No heavy UI frameworks.
- **Backend**: a Node.js orchestrator in `/server` using Express (or Fastify). It owns session lifecycle and manages Docker containers running **redroid** (Android in a container) plus **ws-scrcpy** (browser video/control bridge).
- **Execution boundary**: real Docker/ADB work must stay behind the `ENABLE_DOCKER` environment flag so the UI can be tested locally without Docker or a Linux host. Redroid needs a Linux host with binder/ashmem kernel modules, not KVM.
- Keep HTTP handlers thin; put Docker, ADB, and session-state logic in small dedicated modules under `/server`.

## 2. Scope of changes

- Make **small, incremental changes**. One feature or fix per change.
- **Never modify unrelated files.** Do not reformat, rename, or "clean up" code outside the requested area.
- Do not introduce new dependencies unless the task requires them; prefer Node.js built-ins.
- Preserve existing naming, structure, and style. Additive changes are preferred over rewrites.

## 3. Security

- **Never hardcode** API keys, Docker socket credentials, tokens, passwords, or host addresses in source files.
- Load all configuration from `.env` via `dotenv`, and commit only `.env.example` (with placeholder values).
- Never commit `.env`, `node_modules/`, `uploads/`, or uploaded APK files. Keep them in `.gitignore`.
- Treat uploaded APKs as untrusted: validate extension, enforce the 100 MB limit, generate server-side session IDs, and delete uploads on session stop/expiry.
- Do not expose the Docker socket to the frontend or over the public internet. Docker execution stays server-side and flag-gated.

## 4. Verification (required before finishing any change)

After creating or editing **any** file:

1. Run syntax checks/linters on every changed JS file (for example `node --check <file>`, or the project's `npm run check` script).
2. Verify the folder structure (`Get-ChildItem -Recurse` / `find . -type f`) and confirm no unrelated files changed.
3. For server changes, start the Node server and confirm it boots without errors; smoke-test affected endpoints when practical.
4. Report exactly which files were created or modified, and the verification results.

## 5. Project layout

```
cloud-android-emulator/
├── AGENTS.md
├── README.md
├── package.json
├── wrangler.toml          # Cloudflare Pages config
├── .env.example           # committed, placeholders only
├── .env                   # local only, gitignored
├── .gitignore
├── .devcontainer/
│   └── devcontainer.json  # Codespaces setup
├── scripts/
│   └── setup-linux.sh     # Docker + binder/ashmem host prep
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── server/
│   ├── server.js
│   ├── sessionStore.js
│   ├── dockerManager.js
│   └── adb.js
└── uploads/               # runtime only, gitignored
```

## 6. MVP behavior

- `POST /api/session/start` accepts one `.apk` upload (max 100 MB), creates a unique session, stores the APK under `uploads/`, and prepares redroid + ws-scrcpy Docker commands. Actual execution only happens when `ENABLE_DOCKER=true`.
- `POST /api/session/:id/action` maps button actions to ADB `input keyevent` commands.
- `POST /api/session/:id/stop` removes the container (if enabled), deletes the APK, and clears session state.
- Default session length is 15 minutes and is configurable via `.env`.
