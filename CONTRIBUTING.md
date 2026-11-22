# Как помочь проекту

- **Ошибки и идеи:** [Issues](https://github.com/Crying-Soul/ai-suflyor/issues/new/choose). Приложите лог: Настройки → Отладка → «Открыть папку логов».
- **Вопросы:** [Discussions](https://github.com/Crying-Soul/ai-suflyor/discussions).
- **Код:** сборка из исходников описана в [README](README.md#сборка-из-исходников). Перед pull request:
  - ядро: `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (из `core/`);
  - интерфейс: `npm run typecheck`, `npm run lint`, `npm test` (из `ui/`).
- Сообщения коммитов в стиле [Conventional Commits](https://www.conventionalcommits.org/): `feat(core): …`, `fix(ui): …`.
- `cargo test` пересобирает `ui/src/shared/generated/protocol.ts`: закоммитьте его вместе с изменением протокола.
