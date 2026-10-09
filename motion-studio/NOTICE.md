# Студия движения — чужой код и лицензии

Студия движения построена на наборе **ArcEngine**.

- Источник: https://github.com/xaidan777/ArcEngine, снимок от 09.10.2026, коммит `16fc587a26bf98a686c16ccc48bfba7b3a131a4b`.
- Автор: Tearevo (xaidan777). Лицензия MIT, текст — файл `LICENSE` в корне. Файл `LICENSE` не меняем и не удаляем.

| Компонент | Где лежит | Лицензия | Текст лицензии |
|---|---|---|---|
| ArcEngine (код `js/`, `tools/`, `tests/`, `_utils/`, `claude/`, `unity/`) | корень | MIT, © 2026 Tearevo | `LICENSE`, копия `LICENSES/arcengine-LICENSE.txt` |
| Babylon.js 9.26.0 | `libs/babylon.js`, `libs/babylonjs.loaders.min.js`, `*.d.ts` | Apache-2.0, © The Babylon.js team | `LICENSES/babylonjs-LICENSE.txt`, `LICENSES/babylonjs-NOTICE.txt` (оригиналы `.md` из репозитория Babylon.js рядом) |
| simplex-noise.js | `libs/simplex-noise.js` | MIT, © 2018 Jonas Wagner | в начале файла, копия `LICENSES/simplex-noise-LICENSE.txt` |
| Шрифты Unbounded и Manrope | `studio/fonts/` | SIL OFL 1.1 | `studio/fonts/OFL-*.txt` |
| Cyclone Icons | `studio/icons/cyclone-sprite.svg` | собственность команды Kkoder | — |
| Код студии (`studio/`, `studio.html`, `tools/make-chase-characters.mjs`, `tools/build-studio.mjs`) | `studio/` | команда Kkoder; генератор персонажей основан на `tools/make-character.mjs` из ArcEngine (MIT) | `LICENSE` для заимствованной части |

## Решения «Финансов и права» от 09.10.2026

1. Папку `assets/` из ArcEngine мы **не берём**: у ассетов нет лицензии. IT удалил её из копии. Модели, город и текстуры студия создаёт кодом. Чужие ассеты — только с лицензией CC0.
2. Одна основа — Babylon.js (Apache-2.0) внутри ArcEngine. Библиотеку three.js не подключаем и не смешиваем.
3. Theatre.js не берём. Шкалу времени и камеру IT написал сам.

Пример игры ArcEngine (`index.html`) и его тесты ссылаются на `assets/`. Без папки пример запускается, но показывает ровную землю без моделей. Студию это не затрагивает.
Подробный отчёт о лицензиях хранит команда Kkoder во внутренней документации.

В интерфейсе студии есть пункт «Лицензии» (подвал экрана). Он открывает `licenses.html` со ссылками на эти файлы.
