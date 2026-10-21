---
name: tg-search
description: >-
  Управление десктопным приложением TG Search через CLI tgs: тематики и правила Jev,
  лиды, источники, цепочки, ИИ-менеджер, автопилот, рассылки, импорт CSV.
  Triggers: tg search, тематика для поиска лидов, правило для Jev, найди лидов в Telegram,
  настрой цепочку сообщений, ИИ-менеджер, рассылка по чатам, импорт чатов csv.
---

# TG Search control skill

TG Search — macOS-приложение: ищет сообщения в Telegram (TDLib), квалифицирует лиды через **Jev** (поле `criteria` проекта) или LLM, ведёт переписку вручную, цепочкой, ИИ-менеджером или автопилотом. Все исходящие сообщения ограничены дневным лимитом и паузой на аккаунт.

## Модель объектов

| Термин | В API | Смысл |
|--------|--------|--------|
| Тематика | `projects` | Проект: кого ищем, оффер, **criteria** = правило Jev |
| Источник | `sources` | Чат/канал в тематике (candidate / active / rejected) |
| Лид | `leads` | Сообщение с score 0–100, label, status |
| Цепочка | `project.sequence` | Шаги outreach до ответа лида |
| ИИ-менеджер | `project.manager` | Диалог после ответа лида (OpenAI-compatible) |
| Автопилот | `project.autopilot` | Фон: обновление источников, скан, автоответы |
| Рассылка | `broadcasts` | Периодический пост оффера в выбранные чаты |
| Аккаунты | `accounts` | Рабочие Telegram-аккаунты и лимиты |

Точные JSON-формы: [references/types.md](references/types.md).

## Проверка, что приложение запущено

```bash
tgs status --pretty
```

Если ошибка «Приложение TG Search не запущено — откройте его» — попросите пользователя открыть приложение на Mac.

Список методов API:

```bash
tgs methods --pretty
```

Универсальный вызов (аргументы — JSON; слова без кавычек передаются как строки):

```bash
tgs call projects.list
tgs call projects.create '{"name":"...","task":"clients",...}'
```

События прогресса (SSE → JSON lines):

```bash
tgs events --seconds 120
```

## Рецепты

### 1. Создать тематику из описания пользователя

1. Сформулируйте `criteria` по-русски: что **подходит** (явный запрос, бюджет, сроки) и что **отсекаем** (реклама конкурентов, вакансии не по профилю, спам).
2. Заполните `target`, `offer`, `task`, `accountIds` (из `tgs status`), `geo`, `languages`.
3. Создайте проект:

```bash
tgs call projects.create '{
  "name": "Клиенты на автоматизацию",
  "task": "clients",
  "target": "владельцы бизнеса, которым нужна автоматизация",
  "offer": "разработка ботов и интеграций",
  "criteria": "Подходит: явный запрос на разработку, интеграцию, бота. Не подходит: вакансии, реклама услуг конкурентов, общие обсуждения без запроса.",
  "geo": ["RU"],
  "languages": ["ru"],
  "accountIds": [1],
  "materials": [],
  "keywords": [],
  "sequence": [],
  "manager": { "enabled": false, "baseUrl": "", "apiKey": "", "model": "", "prompt": "", "replyDelaySec": 60, "maxReplies": 8 }
}'
```

4. Ключевые слова (опционально):

```bash
tgs call projects.suggestKeywords '{"task":"clients","target":"...","offer":"...","geo":["RU"],"languages":["ru"],"materials":[]}'
tgs call projects.update <id> '{"keywords":["..."]}'
```

5. Поиск источников и скан:

```bash
tgs call sources.discover <projectId>
tgs call sources.scan <projectId>
```

### 2. Список и отбор лидов

```bash
tgs leads <projectId> --min 70 --status new --pretty
tgs call leads.feedback <leadId> '"up"'
```

### 3. Импорт чатов из CSV

Первая колонка — ссылка или @username (заголовок опционален).

```bash
tgs import <projectId> /path/to/chats.csv --pretty
```

### 4. Цепочка сообщений

Обновите `sequence` у проекта (шаг 0 — первое сообщение; дальше только пока лид молчит):

```bash
tgs call projects.update <projectId> '{
  "sequence": [
    { "delayHours": 0, "mode": "ai", "text": "Коротко представиться и уточнить задачу. Без давления." },
    { "delayHours": 48, "mode": "template", "text": "Добрый день, {name}! По вашему запросу про {request} — актуально ещё?" }
  ]
}'
```

### 5. ИИ-менеджер: настройка и песочница

**Сначала всегда** `manager.test` с вымышленным диалогом. Не включайте `manager.enabled` без явного согласия пользователя.

```bash
tgs call manager.test <projectId> '"Нужен бот для CRM"' '[]' '{
  "enabled": false,
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "",
  "model": "anthropic/claude-haiku-5.5",
  "prompt": "Ты менеджер...",
  "replyDelaySec": 60,
  "maxReplies": 8
}'
```

После одобрения пользователем:

```bash
tgs call projects.update <projectId> '{"manager":{...,"enabled":true}}'
```

### 6. Автопилот (только с подтверждением)

Не включайте `autopilot.enabled` или `autopilot.aiReply` без явного «да» от пользователя. Сначала настройте консервативные лимиты аккаунтов (`accounts.update`).

```bash
tgs call autopilot.set <projectId> '{"enabled":true,"scanIntervalMin":60,"aiReply":false}'
tgs call autopilot.runNow <projectId>
```

### 7. Рассылка по чатам

Создание без `enabled: true` до подтверждения:

```bash
tgs call broadcasts.create '{
  "name": "Оффер в чаты",
  "text": "Текст оффера",
  "accountIds": [1],
  "chatLinks": ["@example_chat"],
  "intervalHours": 48,
  "spin": true
}'
```

### 8. Настройки (без вывода ключей)

```bash
tgs call settings.get
tgs call settings.set '{"handoffNotifyTo":"@username"}'
```

Никогда не печатайте `llmApiKey`, `jevApiKey`, `tgApiHash`, `manager.apiKey` в чат.

### 9. Чат канала (без подписки на канал)

Комментарии к постам канала — его чат обсуждений; лиды пишут там. Вступить только в чат:

```bash
tgs call chats.discussion 1 '"@channel"'          # null — у канала нет чата
tgs call chats.join 1 <chatId из ответа>
tgs call sources.add <projectId> '"@channel"'     # канал как источник = его чат обсуждений
```

### 10. Новости каналов

Каналы читаются без подписки раз в час; Jev оценивает посты по `settings.newsInterests`, в список попадают от 50%.

```bash
tgs call settings.set '{"newsInterests":"ИИ в маркетинге, новые нейросети, Яндекс Директ"}'
tgs call news.addChannel '"@channel"'
tgs call news.runNow                       # прочитать сейчас; вернёт число новых постов
tgs call news.items                        # новые; 'saved' | 'used' | 'all'
tgs call news.draft <itemId> '"review"'    # или "repost" — черновик поста
tgs call news.setStatus <itemId> '"saved"' # saved | used | dismissed
```

### 11. Категории лидов и спам-чаты

```bash
tgs call categories.list                   # у лида categoryId — фильтр «Тематики» во «Входящих»
tgs call spam.chats                        # чаты, из которых вышли: спам и повторы или неделю без сообщений
tgs call spam.blockChat 1 <chatId>         # выйти и заблокировать — только по просьбе пользователя
tgs call spam.unblockChat <chatId>
```

Каналы и чаты, где аккаунт админ, автоматически не блокируются.

## Правила безопасности для Claude

1. **Отправка сообщений**: не включать `autopilot.aiReply`, `manager.enabled`, `broadcasts.enabled` без явного подтверждения пользователя в этом разговоре.
2. **Менеджер**: всегда `manager.test` перед включением.
3. **Лимиты**: не предлагать снимать дневные лимиты и паузы; напоминать о рисках блокировок Telegram.
4. **Секреты**: не выводить API-ключи; не просить пользователя вставлять ключи в команды — они хранятся в приложении.
5. **Ручная отправка**: `messages.send` — только если пользователь явно просит отправить конкретный текст конкретному лиду.

## Полезные команды

```bash
tgs projects --pretty
tgs sources <projectId> --pretty
tgs status --pretty
```
