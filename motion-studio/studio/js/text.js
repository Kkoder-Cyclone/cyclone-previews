// text.js — every interface string of the studio, in Russian (STE100 по-русски).
// Drafts: GLM (glm-5.3-flash), checked and edited by IT. One word — one meaning:
// «ракурс» — a camera shot on the timeline, «ключ» — a keyframe, «путь» — a path.

/** @satisfies {Record<string, any>} */
const StudioText = {
    S: {
        appTitle: 'Студия движения',
        appSub: 'ИИ и человек правят одну сцену',
        loading: 'Загрузка сцены…',
        play: 'Пуск',
        pause: 'Пауза',
        restart: 'Сначала',
        record: 'Записать ролик',
        recordShort: 'Запись',
        recording: 'Идёт запись',
        recordDone: 'Ролик готов',
        download: 'Скачать ролик',
        noRecorder: 'Этот браузер не умеет записывать видео.',
        undo: 'Отменить',
        redo: 'Вернуть',
        viewScene: 'Камера сцены',
        viewFree: 'Свободная камера',
        tabPrompt: 'Запрос',
        tabScene: 'Сцена',
        tabCamera: 'Камера',
        promptHint: 'Этап 1: вставьте список команд в формате JSON и нажмите «Применить». На этапе 2 сюда подключим ИИ.',
        promptPlaceholder: '[{"cmd": "set_param", "target": "chase1", "param": "aggression", "value": 0.9}]',
        apply: 'Применить',
        example: 'Пример',
        commandsHelp: 'Справка по командам',
        emptyResult: 'Вы ещё не применили команды.',
        okCount: 'Применено: {n}',
        errCount: 'Отклонено: {n}',
        modeFollow: 'Следование',
        modeStatic: 'Неподвижная',
        modeFlyby: 'Пролёт',
        modeHintFollow: 'Камера едет за объектом на заданном расстоянии и высоте.',
        modeHintStatic: 'Камера стоит на месте и поворачивается за объектом.',
        modeHintFlyby: 'Камера летит по точкам пролёта и смотрит на объект.',
        timelineTitle: 'Шкала времени',
        timelineHint: 'Перетащите ключ или ракурс мышкой или пальцем. Нажмите на линейку, чтобы перейти к моменту.',
        pathHint: 'Остановите сцену. Перетащите белые точки пути бегуна мышкой или пальцем.',
        saveJson: 'Скачать JSON',
        loadJson: 'Загрузить JSON',
        resetScene: 'Сбросить сцену',
        keyValue: 'Значение ключа',
        deleteKey: 'Удалить ключ',
        addKey: 'Ключ сейчас',
        addShot: 'Ракурс сейчас',
        deleteShot: 'Удалить ракурс',
        shotStart: 'Начало ракурса, с',
        transition: 'Переход',
        transSmooth: 'Плавный',
        transCut: 'Склейка',
        eyeHere: 'Поставить камеру сюда',
        eyeHereHint: 'Включите свободную камеру, найдите вид и нажмите кнопку.',
        objects: 'Объекты',
        behavior: 'Погоня',
        selectedKey: 'Выбранный ключ',
        selectedShot: 'Ракурс в текущий момент',
        data: 'Данные сцены',
        badgeScene: 'Камера сцены',
        badgeFree: 'Свободная камера: тяните мышкой или пальцем',
        rowCamera: 'Камера',
        fileError: 'Файл не подходит: ',
        p: {
            speed: 'Скорость, см/с', weave: 'Раскачка, см', aggression: 'Агрессия', gap: 'Стартовый разрыв, см',
            minGap: 'Наименьший разрыв, см', maxSpeed: 'Наибольшая скорость, см/с', accel: 'Разгон, см/с²',
            lane: 'Смещение по полосе, см', delay: 'Задержка старта, с', distance: 'Расстояние, см', height: 'Высота, см',
            angle: 'Угол к объекту, °', lookAhead: 'Взгляд вперёд, см', lookHeight: 'Высота взгляда, см',
            smooth: 'Плавность, с', fov: 'Угол обзора, °', x: 'Позиция X, см', y: 'Позиция Y, см', duration: 'Длина сцены, с'
        },
        roles: { person: 'Человек', cone: 'Конус', barrier: 'Ограждение', crate: 'Ящик' },
        // Command reference for the prompt tab: name -> what it does + a short example.
        ref: [
            ['add_object', 'добавить объект: человека, конус, ограждение или ящик', '{"cmd":"add_object","id":"chaser4","type":"person","outfit":"chaser"}'],
            ['remove_object', 'удалить объект', '{"cmd":"remove_object","id":"cone1"}'],
            ['set_path', 'задать путь точками [x, y] в сантиметрах', '{"cmd":"set_path","id":"route","points":[[900,2600],[5200,2600]]}'],
            ['move_point', 'сдвинуть одну точку пути', '{"cmd":"move_point","path":"route","index":3,"x":5000,"y":2700}'],
            ['set_keyframe', 'поставить ключ свойства в момент времени', '{"cmd":"set_keyframe","target":"runner","prop":"speed","t":6,"value":900}'],
            ['remove_keyframe', 'удалить ключ', '{"cmd":"remove_keyframe","target":"runner","prop":"speed","t":6}'],
            ['set_camera', 'задать ракурс камеры с момента t: follow, static или flyby', '{"cmd":"set_camera","t":5,"mode":"follow","target":"runner","angle":90}'],
            ['remove_shot', 'удалить ракурс', '{"cmd":"remove_shot","t":5}'],
            ['add_behavior', 'добавить погоню: кто гонится и за кем', '{"cmd":"add_behavior","id":"chase4","type":"chase","hunter":"chaser4","prey":"runner","aggression":0.8}'],
            ['remove_behavior', 'удалить поведение', '{"cmd":"remove_behavior","id":"chase2"}'],
            ['set_param', 'изменить параметр объекта, погони или сцены', '{"cmd":"set_param","target":"chase1","param":"maxSpeed","value":900}'],
            ['set_duration', 'задать длину сцены в секундах', '{"cmd":"set_duration","value":20}']
        ],
        exampleCmds: [
            { cmd: 'add_object', id: 'chaser4', type: 'person', name: 'Преследователь 4', outfit: 'chaser' },
            { cmd: 'add_behavior', id: 'chase4', type: 'chase', hunter: 'chaser4', prey: 'runner', aggression: 0.9, gap: 2600, maxSpeed: 900, lane: -60, delay: 2.5 },
            { cmd: 'set_keyframe', target: 'runner', prop: 'speed', t: 9.5, value: 800 },
            { cmd: 'set_camera', t: 9.6, mode: 'follow', target: 'runner', angle: 160, distance: 900, height: 420, lookAhead: -700 }
        ]
    },

    t(key, n) {
        const s = this.S[key];
        return n != null && typeof s === 'string' ? s.replace('{n}', String(n)) : s;
    },
    param(k) { return this.S.p[k] || k; },
    cameraMode(m) { return m === 'follow' ? this.S.modeFollow : m === 'static' ? this.S.modeStatic : this.S.modeFlyby; },
    fmtTime(t) { return t.toFixed(1).replace('.', ','); }
};
