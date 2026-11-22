# Безопасность

Уязвимость сообщайте приватно: [Security → Report a vulnerability](https://github.com/Crying-Soul/ai-suflyor/security/advisories/new). Не публикуйте её в Issues.

Ключи API хранятся в `config.json` зашифрованными средствами Windows (DPAPI) и передаются ядру через переменные окружения. Звук и транскрипт остаются на компьютере. Наружу уходят только запросы к выбранной модели.
