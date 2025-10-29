# Repository Guidelines

## Project Structure & Module Organization
Source TypeScript lives in `src/`, with the CLI entry point in `src/index.ts`, command handlers in `src/commands/`, services in `src/services/`, configuration helpers in `src/config/`, and utilities in `src/utils/`. Tests mirror this layout inside `src/__tests__/`, grouping integration suites in `integration.test.ts` and nested folders such as `src/__tests__/services/`. Build output lands in `dist/` after a compile, runtime caches persist under `data/`, and operational playbooks sit in `docs/`.

## Build, Test, and Development Commands
Run `npm install` once, then `npm run build` compiles TypeScript to `dist/`. Use `npm run dev` for a ts-node run during local development, or `npm start -- <subcommand>` to execute the bundled CLI (for example, `npm start -- agents`). `npm test` executes the Jest suite, `npm run test:watch` keeps tests rerunning on file changes, and `npm run test:coverage` produces LCOV coverage. `npm run lint` checks ESLint rules and `npm run format` applies Prettier across `src/**/*.ts`.

## Coding Style & Naming Conventions
The project targets Node.js ≥18 and TypeScript 5; maintain strict typing and prefer centralized interfaces in `src/types/`. Indentation is two spaces, with camelCase for variables and functions, PascalCase for classes and enums, and kebab-case for CLI subcommands. Always run Prettier and ESLint before opening a PR, resolve warnings instead of suppressing them, and keep import paths explicit as enforced by `tsconfig.json`.

## Testing Guidelines
Add unit tests alongside related code in `src/__tests__/`, naming files `*.test.ts` and matching folder depth to the implementation (e.g., tests for `src/services/trading.ts` belong in `src/__tests__/services/trading.test.ts`). Structure suites with descriptive `describe` blocks, rely on Jest spies or fixtures from `src/__tests__/utils/`, and reset state in `beforeEach`. Extend integration coverage in `src/__tests__/integration.test.ts` for end-to-end flows and ensure `npm run test:coverage` stays at or above the current baseline when adding features.

## Commit & Pull Request Guidelines
Recent history favors concise, imperative commit subjects (for example, `Update README.md`); stay under ~72 characters and expand details in the body when needed, referencing issues with `#<id>`. Commit only logically grouped changes and update documentation together with code. Pull requests should describe the change, list manual verification commands (such as sample `npm start` runs), include screenshots of notable CLI output, and link any updated files under `docs/` so reviewers can trace operational impacts.

## Configuration & Security Tips
Clone `.env.example` to `.env` and set `TRADING_EXCHANGE` to either `binance` or `bybit`; provide the matching `*_API_KEY`/`*_API_SECRET`, or fall back to the shared `EXCHANGE_API_KEY`/`EXCHANGE_API_SECRET` pair. Always keep secrets local and favor testnet flags (`BINANCE_TESTNET`, `BYBIT_TESTNET`) or `--risk-only` runs before trading live funds. Review `docs/` guidance (for example, `docs/logging.md`) before enabling Telegram or logging integrations, and rotate tokens if they appear in shared logs.
