# Browser Feedback for Coding Agents — M0

Validation prototype по PRD v0.4: комментарии прямо на работающем `localhost`-приложении → **Fix all** → ваш MCP-агент исправляет → результат проверяется на живой странице → **Accept**.

```
Chrome extension ──Native Messaging──▶ companion host ◀──unix socket── MCP server ◀──stdio── ваш агент
 (pins, panel,      (stdio, без TCP)    (reviews, verify,   (0600)       (wait_for_review,
  capture)                               journal на диске)                inspect_element, …)
```

- **extension/** — MV3, без сборки (Load unpacked). Picker (⌥+click, ↑/↓), комментарии, pins, Review panel, захват DOM/styles/geometry, verification-сигнатуры, Copy as Markdown.
- **companion/** — Node ≥ 18, без зависимостей. `host` (запускает Chrome), `mcp` (запускает агент), `connect`, `status`, `stats`.
- **shared/redact.js** — фильтрация секретов, копируется в обе части (`npm run sync-shared`).

## Как пользоваться (режим копирования — без установки)

1. Расширение: `chrome://extensions` → Developer mode → Load unpacked → папка `extension/`. Работает на `localhost` сразу; другие сайты — «Enable on this site» в popup.
2. На странице: ⌥/Alt+клик по элементу (↑ или «↑ Parent» — блок крупнее), текст правки, Enter. Сколько угодно комментариев. В DevTools device mode: Alt+Shift+C, затем тап.
3. **Copy for Claude** → вставить в Claude (Claude Code, приложение Claude или любой другой агент). В буфере — преамбула («пройдись по каждому комментарию, внеси правки, отчитайся списком») и по каждому комментарию подсказки для поиска кода: React-компонент и файл (в dev-сборке), заголовок секции, текст, test id, размер и ключевые стили. Сгенерированные классы (`css-…`, `r-…`) не попадают. Преамбула всегда на английском (расширение международное); комментарии остаются на вашем языке, и Claude просят отвечать на нём же.
4. Комментарии получают статус **Sent to Claude**. Когда страница обновится (HMR), расширение само замечает изменение элемента: **Changed — check** с тем, что поменялось. Дальше **Accept** или **Reopen**.

## Опционально: Claude Code правит сам (Fix all)

Одна фраза для Claude Code (есть на приветственной странице и в popup) ставит локальный helper: native messaging host, MCP-сервер и хуки-«звонок». Тогда появляется кнопка **Fix all**: review уходит в сессию Claude Code напрямую, без копирования, с проверкой результата на странице. Подробности — [`INSTALL.md`](INSTALL.md); диагностика — `node ~/.browser-feedback/app/bin/browser-feedback.js status`.

## Тесты

```bash
npm install          # playwright-core для e2e
npm test             # unit + интеграция реальных процессов host ↔ MCP (45 тестов; e2e: копирование, интеграция, touch)
npm run test:e2e     # полный цикл в настоящем Chromium с расширением и native host
```

E2E использует Chromium из `/opt/pw-browsers/chromium` (или `CHROMIUM_PATH`), `HEADED=1` — с окном.

## Статус M0 (PRD §35.1)

| # | Критерий | Статус |
|---|---|---|
| 1 | Выбор элемента и комментарий с pin сразу после установки | ✅ e2e |
| 2 | Несколько комментариев в Review panel | ✅ e2e |
| 3 | Подключение localhost к директории проекта | ✅ `connect`, «Add origin» в панели |
| 4 | Определение, запущен ли dev server | ✅ в popup (на самой странице расширение не работает, если сервер лежит) |
| 5 | Review → MCP-агент через Attach mode | ✅ e2e |
| 6 | Агент получает instruction + browser context | ✅ instruction и `<page-data>` разделены |
| 7 | Отдельные статусы комментариев | ✅ |
| 8 | Изменение через HMR, extension переживает reload/HMR | ✅ re-anchoring; reload в e2e; verify ждёт стабилизации DOM и повторяет запрос после full reload |
| 9 | Verification на живой странице | ✅ exists/removed + before/after diff свойств |
| 10 | `Fixed` только если verification прошёл | ✅ + агент сам видел изменение через `inspect_element`/`screenshot` (§27.2) |
| 11 | Явный Accept | ✅ |
| 12 | Copy as Markdown без companion | ✅ |
| 13 | Credentials и sensitive data не попадают в контекст | ✅ redaction в extension и повторно в companion; значения input не захватываются |
| 14 | Companion не слушает TCP | ✅ только Native Messaging + unix socket 0600 в каталоге 0700 |
| 15 | В проект не добавляется файлов | ✅ всё в `~/.browser-feedback` |

Метрики для K1 пишутся локально (`metrics.jsonl`, только числа): комментариев на review, время Fix all → первое видимое изменение (наблюдается расширением), доля Fixed, Accept. `browser-feedback stats` считает медианы.

## Находки и отклонения от PRD

1. **Screenshots: PRD §18 и §30 противоречат друг другу.** `chrome.tabs.captureVisibleTab` требует `activeTab` или `<all_urls>`; host permissions на `localhost` недостаточно (проверено в Chromium 141: *"Either the '<all_urls>' or 'activeTab' permission is required"*). Сейчас: screenshot работает после клика по иконке расширения или shortcut на вкладке (это даёт `activeTab`); без этого панель показывает подсказку, агент получает понятное сообщение, verification работает без screenshots (по DOM/styles). Решение нужно до M1: оставить жест / opt-in `<all_urls>` / context menu (`contextMenus` тоже даёт `activeTab`).
2. **⌥+click выбирает самый глубокий элемент** (`h2`, а не карточку). ↑/↓ работают и при зажатом Alt — это стоит явно показывать в onboarding.
3. **Fixed строже, чем «агент сказал fixed»**: нужен diff before/after *и* чтобы агент сам посмотрел изменённый элемент. Агент, который не вызвал `inspect_element`, получает `Changed — check` и подсказку, как получить `Fixed`.
4. **Таймауты MCP-клиентов.** `wait_for_review` блокируется (по умолчанию 300 с, затем «вызови снова»); шлёт progress-уведомления. У Codex дефолтный tool timeout 60 с — `connect` печатает `tool_timeout_sec`.
5. **Потерянная доставка review** (агент отменил/таймаутнул вызов): если агент ещё ничего не трогал, review доставляется повторно, а не помечается failed.

## Известные ограничения M0

- Transient-состояния (hover-меню) не замораживаются на время комментария.
- Один профиль Chrome одновременно (второй host не поднимает socket и пишет об этом в лог).
- Windows: пути и реестр реализованы, но не проверены (open question §40.7).
- Расширение добавляет элемент `<browser-feedback-root>` в `<html>`; возможны hydration-предупреждения у React-приложений — проверить на реальных Next.js-проектах.
- Diff/undo, follow-up, `Needs input`, source mapping, bundles, Run mode — M1/M2 по PRD.

## Структура

```
extension/   manifest.json, background.js, content/{anchor,capture,ui,main}.js, popup/
companion/   bin/browser-feedback.js, src/{companion,host,mcp,connect,verify,format,…}.js, test/
shared/      redact.js (источник; копии — в extension/lib и companion/src)
e2e/         loop.test.js + fixture
scripts/     sync-shared.mjs, extension-id.mjs
```
