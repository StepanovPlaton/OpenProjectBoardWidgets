# 🧩 OpenProject Board Widgets

> **OpenProject Board Widgets** — расширение для **Google Chrome** и **Firefox**, которое обогащает карточки досок OpenProject через REST API.

---

## 🚀 О проекте

- **Виджеты на карточках** досок OpenProject
- **Приоритет** — цветной кружок `P1…P5` (ниже число = выше приоритет)
- **Отдел в заголовке** карточки (`#id - Department`) — кликабельный: выбор отдела из списка или placeholder «выбрать отдел»
- **Story Points** — бейдж с оценкой
- **CI (GitHub)** — бейдж успешных/проваленных проверок по PR
- **Review AI (GitHub Copilot)** — маленькая иконка после CI с цветом по статусу (зелёный/жёлтый/красный), поле и ID статусов настраиваются
- **Возвраты в доработку** — счётчик переходов из done-статусов обратно в работу (по activities)
- **Блокеры** — проверка всех связей work package:
  - ✅ если связанные задачи в «готовых» статусах (или связей нет)
  - ❌ если есть незакрытые зависимости
- **Время в колонке** — компактно: `18ч`, `23д` (по activities)
- **Уведомления** — синяя точка / `@` на карточке, тосты о новых уведомлениях, mark-as-read при открытии задачи
- **Сводка по колонке** — сумма SP и число карточек в заголовке
- **Быстрые фильтры** на доске (отдел / исполнитель / спринт)
- **Улучшенный Обзор** work package — связи и GitHub PR
- Скрытие нативной цветной полоски **только на карточке** (статусы колонок и Обзора не трогаем)
- Двухэшелонная загрузка + общее хранилище work packages (без повторных запросов за один id)
- Настройки в popup, хранятся в `storage.sync`
- Сборка под **Chrome (MV3)** и **Firefox (MV3)**

---

## ✨ Возможности

| Виджет / фича        | Что делает                                                                 |
| -------------------- | -------------------------------------------------------------------------- |
| Приоритет            | Кружок с позицией приоритета и цветом                                      |
| Отдел                | Кликабельный отдел в шапке: выбор/смена из списка, placeholder при пустом  |
| Story Points         | Оценка из выбранного поля                                                  |
| CI                   | `успешные/всего` этапов GitHub по связанным PR                             |
| Review AI            | Иконка Copilot после CI, цвет по ID опции кастомного поля (6/7/8)          |
| Возвраты             | Сколько раз задача уходила из done (QA / Done / ПРИНЯТО…) обратно в работу |
| Блокеры              | Анализирует **все** relations                                              |
| Время в колонке      | Пребывание в текущем статусе (`5м` / `18ч` / `23д`)                        |
| Уведомления          | Точка или `@` на карточке; тост при новом уведомлении; read при открытии   |
| Заголовок колонки    | Сумма SP + число карточек                                                  |
| Обзор                | Redesign Overview + секции Связи / GitHub                                  |
| Фильтры              | Быстрый фильтр доски по отделу, assignee, спринту                          |

### Загрузка данных

1. **Эшелон 1 (быстрый)** — поля самой задачи (приоритет, SP, отдел): один batch `filters=id`, сразу на карточки.
2. **Эшелон 2 (ленивый)** — blockers, activities, GitHub CI: параллельно и независимо, не блокирует первый проход.
3. **Уведомления** — отдельный poll (раз в ~30 с).

**Хранилище WP** в service worker: TTL ~5 минут + dedupe in-flight. Уже загруженный `#15` не запрашивается снова, даже если он нужен как связанная задача для `#16`. Новые карточки на доске подхватываются сразу (их ещё нет в store). После DnD статус обновляется принудительно (`force`).

---

## 📝 Подготовка

### Требования к ОС и среде

| Требование | Значение |
| ---------- | -------- |
| ОС | Windows 10+, macOS 12+, или современный Linux (x64 / arm64) |
| Node.js | **≥ 18** (проверено на **24.12.0**) |
| npm | **≥ 9** (идёт вместе с Node.js; проверено на **11.6.2**) |
| Сеть | доступ к npm registry для установки зависимостей |
| Доп. системные утилиты | не нужны (`zip` / Visual Studio не требуются) |

Другие инструменты сборки (Vite, TypeScript, `@crxjs/vite-plugin`) ставятся локально через `npm` — отдельно устанавливать их не нужно.

### Установка Node.js и npm

1. Скачайте LTS с [https://nodejs.org/](https://nodejs.org/) (или установите через `nvm` / `fnm` / пакетный менеджер ОС).
2. Проверьте версии:

```bash
node -v   # ожидается v18+ (например v24.12.0)
npm -v    # ожидается 9+ (например 11.6.2)
```

3. Клонируйте / распакуйте исходники и перейдите в корень репозитория (рядом с `package.json`).
4. Установите зависимости **по lockfile** (предпочтительно):

```bash
npm ci
```

Если `npm ci` недоступен по какой-то причине:

```bash
npm install
```

---

## 🛠 Сборка

Скрипты в `package.json` выполняют все технические шаги (проверка TypeScript, Vite-бандл, адаптация Firefox-манифеста, упаковка zip).

Собрать сразу оба браузера:

```bash
npm run build
```

Или по отдельности:

```bash
npm run build:chrome
npm run build:firefox
```

Результат:

| Браузер | Папка           |
| ------- | --------------- |
| Chrome  | `dist/chrome/`  |
| Firefox | `dist/firefox/` |

Упаковать в zip (пути внутри архива с `/`, пригодно для AMO):

```bash
npm run pack
# или
npm run pack:chrome
npm run pack:firefox
```

Архивы появятся как `dist/chrome.zip` и `dist/firefox.zip`.

### Что делает `npm run build:firefox`

1. `tsc --noEmit` — проверка типов.
2. `BROWSER=firefox vite build` — production-сборка в `dist/firefox/` (CRXJS + Vite).
3. `node scripts/adapt-firefox-manifest.mjs` — правка `manifest.json` под Gecko:
   - `browser_specific_settings.gecko.id`
   - `strict_min_version`
   - `data_collection_permissions`
   - `background.scripts` вместо `service_worker`
   - удаление `use_dynamic_url` из `web_accessible_resources`

### Dev-режим

```bash
npm run dev
# или явно
npm run dev:chrome
npm run dev:firefox
```

Затем загрузите unpacked-сборку из `dist/chrome` или `dist/firefox` (CRXJS пишет dev-build в `outDir`).

---

## 🔍 AMO source review — reproduce the Firefox build

These steps produce an extension package equivalent to the signed/uploaded Firefox build.

### Environment

- **OS:** Windows 10+, macOS, or Linux
- **Node.js:** 18 or newer (verified with Node **24.12.0**)
- **npm:** 9 or newer (verified with npm **11.6.2**; bundled with Node.js)
- No other global build tools are required

Install Node.js from https://nodejs.org/ (LTS), then confirm:

```bash
node -v
npm -v
```

### Build steps (exact copy)

1. Extract the submitted source archive.
2. Open a terminal in the project root (directory that contains `package.json`).
3. Install dependencies from the lockfile:

```bash
npm ci
```

4. Build the Firefox extension:

```bash
npm run build:firefox
```

5. (Optional) Create the zip for AMO / comparison:

```bash
npm run pack:firefox
```

### Output

| Artifact | Path |
| -------- | ---- |
| Unpacked extension | `dist/firefox/` (contains `manifest.json` at the root) |
| Zip package | `dist/firefox.zip` |

The contents of `dist/firefox/` (or `dist/firefox.zip`) are the built add-on. Compare them to the uploaded XPI/ZIP: same `manifest.json` fields, same bundled assets under `assets/`, same content/popup entry files. Asset hashes in filenames may differ only if dependency versions differ; use `npm ci` with the included `package-lock.json` for a bit-identical toolchain.

### Build script summary

| Command | Purpose |
| ------- | ------- |
| `npm ci` | Install exact dependency versions from `package-lock.json` |
| `npm run build:firefox` | Typecheck + Vite/CRXJS production build + Firefox manifest adapt |
| `npm run pack:firefox` | Zip `dist/firefox/*` with forward-slash paths |

---

## 🎯 Установка

### Google Chrome / Chromium / Edge

1. Откройте `chrome://extensions` (для Edge — `edge://extensions`)
2. Включите **Developer mode**
3. **Load unpacked** → выберите папку `dist/chrome`
4. Откройте popup расширения → укажите **Base URL** и **API token**
5. Нажмите **Проверить**, затем **Сохранить**
6. Откройте доску OpenProject и обновите страницу (`F5`)

### Firefox

1. Откройте `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…**
3. Выберите файл `dist/firefox/manifest.json`
4. Дальше так же: Base URL → API token → **Проверить** → **Сохранить**
5. Обновите страницу доски

> Для постоянной установки в Firefox удобнее подписать `.zip` через [AMO](https://addons.mozilla.org/developers/) или использовать self-distribution. Временная загрузка сбрасывается при перезапуске браузера.

---

## ⚙️ Настройки

Настройки хранятся в `chrome.storage.sync` / storage API браузера.

| Настройка                 | Назначение                                              |
| ------------------------- | ------------------------------------------------------- |
| Base URL / token          | Подключение к OpenProject API                           |
| Скрыть нативную полоску   | Только полоска на карточке (не статусы колонок/Обзора)  |
| Новый дизайн Обзора       | Compact redesign вкладки Overview                       |
| Расширенный Обзор         | Секции Связи и GitHub PR                                |
| Приоритет                 | Вкл/выкл виджет приоритета                              |
| Поле отдела / Мой отдел   | Custom field + быстрый фильтр; клик по отделю на карточке меняет значение |
| Story Points / поле SP    | Вкл/выкл и имя поля                                     |
| Review AI                 | Поле статуса + ID опций зелёный/жёлтый/красный (по умолч. customField8: 6/7/8) |
| Блокеры                   | Вкл/выкл проверки связей                                |
| Статусы «готово»          | По одному на строку — для блокеров **и** возвратов      |
| Treat closed as done      | Учитывать `isClosed` для блокеров                       |
| Возвраты в доработку      | Счётчик возвратов из done                               |
| Уведомления               | Бейджи на карточках + тосты                             |
| Время в колонке           | Компактный формат (`д` / `ч` / `м`)                     |
| Очистить кэш              | Сброс store WP и прочих кэшей service worker            |

---

## 📁 Структура

```text
op-plugin/
├── manifest.config.ts      # общий MV3-манифест
├── vite.config.ts          # Vite + @crxjs/vite-plugin
├── scripts/
│   ├── adapt-firefox-manifest.mjs
│   └── pack-extension.mjs
├── src/
│   ├── background/         # API, WP-store, messaging, кэши
│   │   ├── index.ts
│   │   └── store.ts        # общее хранилище work packages
│   ├── content/            # виджеты на доске, колонки, уведомления, overview
│   ├── popup/              # настройки
│   └── shared/             # типы, settings, API-клиент, виджет-логика
└── dist/
    ├── chrome/
    └── firefox/
```

---

## 📜 Скрипты npm

| Команда                 | Описание                           |
| ----------------------- | ---------------------------------- |
| `npm run dev`           | Dev-сборка (Chrome по умолчанию)   |
| `npm run build`         | Production-сборка Chrome + Firefox |
| `npm run build:chrome`  | Только Chrome → `dist/chrome`      |
| `npm run build:firefox` | Только Firefox → `dist/firefox`    |
| `npm run pack`          | Zip-архивы обеих сборок            |
| `npm run pack:chrome`   | `dist/chrome.zip`                  |
| `npm run pack:firefox`  | `dist/firefox.zip`                 |
