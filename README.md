# 🧩 OpenProject Board Widgets

> **OpenProject Board Widgets** — расширение для **Google Chrome** и **Firefox**, которое обогащает карточки досок OpenProject через REST API.

---

## 🚀 О проекте

- **Виджеты на карточках доски** OpenProject
- **Приоритет** — цветной кружок `P1…P5` (ниже число = выше приоритет)
- **Отдел в заголовке** карточки (`#id - Project - Department`)
- **Story Points** — бейдж с оценкой
- **Блокеры** — проверка всех связей work package:
  - ✅ если связанные задачи в «готовых» статусах (или связей нет)
  - ❌ если есть незакрытые зависимости
- **Время в колонке** — сколько карточка уже стоит в текущем статусе (по activities)
- **Быстрые фильтры** на доске (отдел / исполнитель)
- **Улучшенный Обзор** work package — связи и GitHub PR
- Скрытие нативной цветной полоски карточки
- Настройки в popup, хранятся в `storage.sync`
- Сборка под **Chrome (MV3)** и **Firefox (MV3)**

---

## ✨ Возможности

| Виджет          | Что делает                                  |
| --------------- | ------------------------------------------- |
| Приоритет       | Кружок с позицией приоритета и цветом       |
| Отдел           | Добавляет отдел в заголовок карточки        |
| Story Points    | Показывает оценку из выбранного поля        |
| Блокеры         | Анализирует **все** relations               |
| Время в колонке | Считает пребывание в текущем статусе        |
| Обзор           | Redesign вкладки Overview + связи / PR      |
| Фильтры         | Быстрый фильтр доски по отделу или assignee |

---

## 📝 Подготовка

1. Установите **Node.js 18+**
2. Клонируйте репозиторий
3. Установите зависимости:

```bash
npm install
```

---

## 🛠 Сборка

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

Упаковать в zip:

```bash
npm run pack
# или
npm run pack:chrome
npm run pack:firefox
```

Архивы появятся как `dist/chrome.zip` и `dist/firefox.zip`.

### Dev-режим

```bash
npm run dev
# или явно
npm run dev:chrome
npm run dev:firefox
```

Затем загрузите unpacked-сборку из `dist/chrome` или `dist/firefox` (CRXJS пишет dev-build в `outDir`).

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

| Настройка               | Назначение                         |
| ----------------------- | ---------------------------------- |
| Base URL / token        | Подключение к OpenProject API      |
| Скрыть нативную полоску | CSS-оверлей поверх цветной полоски |
| Приоритет               | Вкл/выкл виджет приоритета         |
| Поле отдела             | Например `customField2`            |
| Мой отдел               | Быстрый фильтр доски               |
| Поле SP                 | Например `storyPoints`             |
| Done-статусы            | По одному имени статуса на строку  |
| Treat closed as done    | Учитывать `isClosed`               |
| Формат времени          | `short` / `full`                   |
| Новый дизайн Обзора     | Redesign вкладки Overview          |
| Расширенный Обзор       | Связи и GitHub PR                  |

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
│   ├── background/         # API, кэш, messaging
│   ├── content/            # виджеты на доске и overview
│   ├── popup/              # настройки
│   └── shared/             # типы, settings, API-клиент
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
