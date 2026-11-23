# TV Corporativa Copilot Instructions

## Project overview

- This is a Node.js 20/TypeScript 5.7 digital-signage CMS and live TV player.
- The backend uses Express 5, SQLite with WAL mode, JWT authentication, WebSockets, and Multer.
- The browser UI under `public/` is plain JavaScript/CSS/HTML, not a frontend framework.
- Keep changes compatible with the current branch. The `feature/go-alternative` branch is a separate implementation and must not be edited or compared as part of this branch unless the task explicitly targets that branch.

## Start with the existing structure

- Add HTTP handlers to `src/routes/` and register each router in `src/app.ts`.
- Put shared configuration in `src/config/index.ts`.
- Put SQLite access in `src/database/connection.ts` and schema changes in `src/database/migrations.ts`.
- Put JWT and role checks in `src/middleware/auth.ts`.
- Put real-time behavior in `src/services/websocket.ts` and shared player/server state in `src/services/`.
- Keep static admin/player code in `public/js/`, styles in `public/css/`, and HTML entry points in `public/`.
- Use `.js` extensions in TypeScript relative imports (for example, `./routes/auth.js`) so NodeNext and Jest resolution work.

## Backend conventions

- Preserve strict TypeScript and ES2022/NodeNext module behavior.
- Use the `db.get`, `db.all`, `db.run`, and `db.exec` helpers for SQLite access. Parameterize every value; never interpolate request or database values into SQL.
- Add non-destructive upgrades to `runMigrations()` using `safeAddColumn()` for existing SQLite databases. Do not assume a fresh database.
- Keep display codes normalized to uppercase and trimmed. Preserve existing public-player response shapes where possible.
- Use `authenticateToken` for protected CMS routes and `requireAdmin` only where administrator-only access is intentional.
- Return JSON errors with a useful Portuguese `error` message and the appropriate 4xx/5xx status. Do not expose passwords, token secrets, SQL details, or stack traces.
- Broadcast relevant display updates through the existing WebSocket service instead of creating a second real-time channel.
- Use `config` for environment-driven paths and settings. Do not hardcode the database or media paths.
- Store uploads through `src/middleware/upload.ts`; keep MIME filtering and the 500 MB limit intact unless a task explicitly changes them.

## Player and offline conventions

- Preserve both `public/player.html` and `public/js/player.js` behavior across 16:9, 9:16, and multi-zone layouts.
- Keep HTML5 video autoplay handling, cross-fade double buffering, Web Audio chime/TTS, WebSocket reloads, RSS/widgets, and the service-worker fallback behavior working.
- When changing cached player assets or cache names, update `public/sw.js` and its precache list consistently.
- Preserve offline-first behavior: network first for GET requests, cache fallback, and cached player assets.
- Keep plain browser APIs and existing DOM patterns; do not introduce a frontend framework or build step for `public/`.

## Database and media safety

- Treat `data/tv_corporativa.db`, SQLite `-wal`/`-shm` files, and `media/` as runtime state. Do not add, delete, or rewrite them unless the task explicitly requires it.
- Do not commit generated SQLite state, uploaded media, `node_modules/`, or `dist/`.
- Keep the WAL and foreign-key settings enabled.
- Avoid destructive migrations or schema replacements. Add seed values idempotently and preserve existing records.

## Testing

- Add or update integration tests under `tests/*.test.ts` with Supertest and the existing `setup.ts`.
- Reuse seed data and authenticated admin tokens rather than creating unrelated setup where the existing fixture is sufficient.
- Cover changed API status codes, response fields, validation, authentication, and cleanup when a test creates or deletes records.
- Run the smallest relevant test during development, for example `npm test -- tests/displays.test.ts`.
- Before completion, run `npm run build` and `npm test` for backend/shared changes. For focused frontend-only changes, at minimum run a relevant browser check or the existing suite if one is available.
- Do not assert or modify the default credentials in tests unless the task explicitly changes authentication or seed behavior.
