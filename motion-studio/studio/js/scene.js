// scene.js — the studio scene as DATA and the command set that edits it.
// One JSON document is the single source of truth for the AI, the human and the player:
// the AI sends a list of short commands, the human's mouse/finger edits become the same
// commands, and StudioCommands.apply() validates each one against the schema before it
// touches the document. No eval, no Function(), no code from the outside: a command is a
// plain object, every field is checked by type and range, unknown fields are rejected.

/** @satisfies {Record<string, any>} */
const StudioSchema = {
    VERSION: 1,
    MAX_OBJECTS: 24,
    MAX_PATH_POINTS: 64,
    MAX_KEYFRAMES: 400,
    MAX_SHOTS: 24,
    MAX_DURATION: 60,
    WORLD_MIN: -2000,
    WORLD_MAX: 12400,
    ID_RE: /^[a-z][a-z0-9_-]{0,31}$/,
    OBJECT_TYPES: ['person', 'crate', 'cone', 'barrier'],
    OUTFITS: ['runner', 'chaser'],
    CAMERA_MODES: ['follow', 'static', 'flyby'],
    TRANSITIONS: ['cut', 'smooth'],
    // Animated properties (keyframes): target kind -> prop -> [min, max]
    KEY_PROPS: {
        object: { speed: [0, 1200], weave: [0, 200] },
        behavior: { aggression: [0, 1], lane: [-400, 400], maxSpeed: [0, 1400] },
        camera: {}
    },
    // Parameters (set_param): kind -> param -> spec
    PARAMS: {
        object: {
            name: { type: 'string', max: 40 },
            outfit: { type: 'enum', values: ['runner', 'chaser'] },
            path: { type: 'id' },
            start: { type: 'number', min: 0, max: 100000 },
            speed: { type: 'number', min: 0, max: 1200 },
            weave: { type: 'number', min: 0, max: 200 },
            x: { type: 'number', min: -2000, max: 12400 },
            y: { type: 'number', min: -2000, max: 12400 },
            heading: { type: 'number', min: -360, max: 360 },
            scale: { type: 'number', min: 0.3, max: 3 }
        },
        behavior: {
            hunter: { type: 'id' },
            prey: { type: 'id' },
            aggression: { type: 'number', min: 0, max: 1 },
            gap: { type: 'number', min: 50, max: 6000 },
            minGap: { type: 'number', min: 40, max: 3000 },
            maxSpeed: { type: 'number', min: 50, max: 1400 },
            accel: { type: 'number', min: 50, max: 4000 },
            lane: { type: 'number', min: -400, max: 400 },
            delay: { type: 'number', min: 0, max: 60 }
        },
        scene: {
            name: { type: 'string', max: 60 },
            duration: { type: 'number', min: 1, max: 60 },
            blend: { type: 'number', min: 0, max: 3 }
        }
    },
    SHOT_FIELDS: {
        follow: {
            target: { type: 'id', required: true },
            distance: { type: 'number', min: 100, max: 6000, def: 620 },
            height: { type: 'number', min: 20, max: 6000, def: 300 },
            angle: { type: 'number', min: -360, max: 360, def: 0 },
            lookAhead: { type: 'number', min: -2000, max: 3000, def: 220 },
            lookHeight: { type: 'number', min: 0, max: 1000, def: 110 },
            smooth: { type: 'number', min: 0, max: 3, def: 0.35 },
            fov: { type: 'number', min: 15, max: 100, def: 50 }
        },
        static: {
            eye: { type: 'vec3', required: true },
            target: { type: 'id' },
            look: { type: 'vec3' },
            smooth: { type: 'number', min: 0, max: 3, def: 0.2 },
            fov: { type: 'number', min: 15, max: 100, def: 45 }
        },
        flyby: {
            keys: { type: 'flykeys', required: true },
            target: { type: 'id' },
            lookHeight: { type: 'number', min: 0, max: 1000, def: 100 },
            fov: { type: 'number', min: 15, max: 100, def: 50 }
        }
    },

    // An empty but valid document.
    empty() {
        return {
            version: StudioSchema.VERSION,
            name: 'Новая сцена',
            duration: 10,
            world: { type: 'city', seed: 7 },
            objects: [],
            paths: [],
            keyframes: [],
            behaviors: [],
            camera: { blend: 0.7, shots: [] }
        };
    },

    clone(doc) {
        return JSON.parse(JSON.stringify(doc));
    },

    // Light structural check of a whole document (loading a file). Returns [] or error strings.
    check(doc) {
        const errs = [];
        if (!doc || typeof doc !== 'object') return ['документ не объект'];
        if (!(doc.duration > 0 && doc.duration <= StudioSchema.MAX_DURATION)) errs.push('длина сцены вне 1–60 с');
        for (const k of ['objects', 'paths', 'keyframes', 'behaviors']) if (!Array.isArray(doc[k])) errs.push('нет списка ' + k);
        if (!doc.camera || !Array.isArray(doc.camera.shots)) errs.push('нет списка camera.shots');
        return errs;
    }
};

/** @satisfies {Record<string, any>} */
const StudioCommands = {
    // The command set. Each entry: what it does (shown to the AI in stage 2) and the handler.
    LIST: ['add_object', 'remove_object', 'set_path', 'move_point', 'set_keyframe', 'remove_keyframe',
        'set_camera', 'remove_shot', 'add_behavior', 'remove_behavior', 'set_param', 'set_duration'],

    // Parse what the prompt field holds: a JSON array of commands, one command object, or
    // { "commands": [...] }. JSON.parse only — the text is never executed.
    parse(text) {
        let data;
        try { data = JSON.parse(String(text || '').trim()); } catch (e) {
            return { ok: false, error: 'это не JSON: ' + (e && e.message ? e.message : 'ошибка разбора') };
        }
        if (data && !Array.isArray(data) && Array.isArray(data.commands)) data = data.commands;
        if (data && !Array.isArray(data) && typeof data === 'object') data = [data];
        if (!Array.isArray(data)) return { ok: false, error: 'нужен список команд' };
        if (data.length > 100) return { ok: false, error: 'больше 100 команд за раз' };
        return { ok: true, commands: data };
    },

    // Apply one command to a COPY of the document. -> { ok, doc, error, summary }
    apply(doc, cmd) {
        if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return this._fail('команда не объект');
        const name = cmd.cmd;
        if (typeof name !== 'string' || this.LIST.indexOf(name) < 0) return this._fail('неизвестная команда «' + String(name).slice(0, 30) + '»');
        const next = StudioSchema.clone(doc);
        try {
            const summary = this['_' + name](next, cmd);
            return { ok: true, doc: next, summary: summary || name };
        } catch (e) {
            return this._fail(e && e.message ? e.message : String(e));
        }
    },

    // Apply a list: valid commands go in, invalid ones are reported and skipped.
    applyAll(doc, cmds) {
        let cur = doc;
        const results = [];
        for (const c of cmds) {
            const r = this.apply(cur, c);
            results.push({ cmd: c && c.cmd, ok: r.ok, text: r.ok ? r.summary : r.error });
            if (r.ok) cur = r.doc;
        }
        return { doc: cur, results };
    },

    _fail(msg) { return { ok: false, doc: null, error: msg }; },

    // --- field checks -----------------------------------------------------------------
    _allowed(cmd, keys) {
        for (const k of Object.keys(cmd)) if (k !== 'cmd' && keys.indexOf(k) < 0) throw new Error('лишнее поле «' + k + '»');
    },
    _id(v, what) {
        if (typeof v !== 'string' || !StudioSchema.ID_RE.test(v)) throw new Error(what + ': нужен код из латиницы, цифр, «_» или «-», до 32 знаков');
        return v;
    },
    _num(v, min, max, what) {
        if (typeof v !== 'number' || !isFinite(v)) throw new Error(what + ': нужно число');
        if (v < min || v > max) throw new Error(what + ': число вне ' + min + '…' + max);
        return v;
    },
    _str(v, max, what) {
        if (typeof v !== 'string') throw new Error(what + ': нужна строка');
        return v.slice(0, max);
    },
    _point(p, what) {
        if (!Array.isArray(p) || p.length !== 2) throw new Error(what + ': точка — [x, y]');
        return [this._num(p[0], StudioSchema.WORLD_MIN, StudioSchema.WORLD_MAX, what + ' x'), this._num(p[1], StudioSchema.WORLD_MIN, StudioSchema.WORLD_MAX, what + ' y')];
    },
    _vec3(p, what) {
        if (!Array.isArray(p) || p.length !== 3) throw new Error(what + ': нужно [x, y, высота]');
        return [this._num(p[0], StudioSchema.WORLD_MIN, StudioSchema.WORLD_MAX, what + ' x'),
            this._num(p[1], StudioSchema.WORLD_MIN, StudioSchema.WORLD_MAX, what + ' y'),
            this._num(p[2], 0, 8000, what + ' высота')];
    },
    _spec(spec, v, what) {
        switch (spec.type) {
            case 'number': return this._num(v, spec.min, spec.max, what);
            case 'string': return this._str(v, spec.max, what);
            case 'id': return this._id(v, what);
            case 'enum':
                if (spec.values.indexOf(v) < 0) throw new Error(what + ': одно из ' + spec.values.join(', '));
                return v;
            case 'vec3': return this._vec3(v, what);
            case 'flykeys': {
                if (!Array.isArray(v) || v.length < 2 || v.length > 16) throw new Error(what + ': от 2 до 16 точек пролёта');
                return v.map((k, i) => {
                    if (!k || typeof k !== 'object') throw new Error(what + ' ' + i + ': точка — объект');
                    for (const f of Object.keys(k)) if (['t', 'eye', 'look'].indexOf(f) < 0) throw new Error(what + ' ' + i + ': лишнее поле «' + f + '»');
                    const o = { t: this._num(k.t, 0, 60, 'время точки'), eye: this._vec3(k.eye, 'камера') };
                    if (k.look != null) o.look = this._vec3(k.look, 'взгляд');
                    return o;
                }).sort((a, b) => a.t - b.t);
            }
        }
        throw new Error('схема: неизвестный тип');
    },
    _find(list, id) { return list.find(x => x.id === id) || null; },
    _kindOf(doc, id) {
        if (id === 'scene') return 'scene';
        if (id === 'camera') return 'camera';
        if (this._find(doc.objects, id)) return 'object';
        if (this._find(doc.behaviors, id)) return 'behavior';
        if (this._find(doc.paths, id)) return 'path';
        return null;
    },
    _idFree(doc, id) {
        if (id === 'scene' || id === 'camera' || this._kindOf(doc, id)) throw new Error('код «' + id + '» уже занят');
    },

    // --- commands ---------------------------------------------------------------------
    _add_object(doc, c) {
        this._allowed(c, ['id', 'type', 'name', 'outfit', 'path', 'start', 'speed', 'weave', 'x', 'y', 'heading', 'scale']);
        const id = this._id(c.id, 'id');
        this._idFree(doc, id);
        if (doc.objects.length >= StudioSchema.MAX_OBJECTS) throw new Error('больше ' + StudioSchema.MAX_OBJECTS + ' объектов нельзя');
        const type = c.type || 'person';
        if (StudioSchema.OBJECT_TYPES.indexOf(type) < 0) throw new Error('type: одно из ' + StudioSchema.OBJECT_TYPES.join(', '));
        const o = { id, type, name: c.name != null ? this._str(c.name, 40, 'name') : id };
        const P = StudioSchema.PARAMS.object;
        for (const k of ['outfit', 'path', 'start', 'speed', 'weave', 'x', 'y', 'heading', 'scale']) {
            if (c[k] != null) o[k] = this._spec(P[k], c[k], k);
        }
        if (type === 'person' && !o.outfit) o.outfit = 'chaser';
        if (o.path && !this._find(doc.paths, o.path)) throw new Error('путь «' + o.path + '» не найден');
        doc.objects.push(o);
        return 'добавлен объект ' + id;
    },
    _remove_object(doc, c) {
        this._allowed(c, ['id']);
        const id = this._id(c.id, 'id');
        const i = doc.objects.findIndex(o => o.id === id);
        if (i < 0) throw new Error('объект «' + id + '» не найден');
        doc.objects.splice(i, 1);
        doc.behaviors = doc.behaviors.filter(b => b.hunter !== id && b.prey !== id);
        doc.keyframes = doc.keyframes.filter(k => k.target !== id);
        doc.camera.shots = doc.camera.shots.filter(s => s.target !== id || s.mode === 'static');
        for (const s of doc.camera.shots) if (s.target === id) delete s.target;
        return 'удалён объект ' + id;
    },
    _set_path(doc, c) {
        this._allowed(c, ['id', 'points']);
        const id = this._id(c.id, 'id');
        if (!Array.isArray(c.points) || c.points.length < 2 || c.points.length > StudioSchema.MAX_PATH_POINTS) throw new Error('points: от 2 до ' + StudioSchema.MAX_PATH_POINTS + ' точек');
        const points = c.points.map((p, i) => this._point(p, 'точка ' + i));
        const p = this._find(doc.paths, id);
        if (p) p.points = points;
        else {
            this._idFree(doc, id);
            doc.paths.push({ id, points });
        }
        return 'путь ' + id + ': ' + points.length + ' точек';
    },
    _move_point(doc, c) {
        this._allowed(c, ['path', 'index', 'x', 'y']);
        const p = this._find(doc.paths, this._id(c.path, 'path'));
        if (!p) throw new Error('путь «' + c.path + '» не найден');
        const i = this._num(c.index, 0, p.points.length - 1, 'index');
        if (Math.round(i) !== i) throw new Error('index: нужно целое');
        p.points[i] = this._point([c.x, c.y], 'точка');
        return 'путь ' + p.id + ': точка ' + i + ' сдвинута';
    },
    _keyTarget(doc, target, prop) {
        const kind = this._kindOf(doc, this._id(target, 'target'));
        if (!kind || !StudioSchema.KEY_PROPS[kind]) throw new Error('цель «' + target + '» не найдена');
        const range = StudioSchema.KEY_PROPS[kind][prop];
        if (!range) throw new Error('у цели «' + target + '» нет анимируемого свойства «' + prop + '»');
        return range;
    },
    _set_keyframe(doc, c) {
        this._allowed(c, ['target', 'prop', 't', 'value', 'from']);
        const range = this._keyTarget(doc, c.target, c.prop);
        const t = this._num(c.t, 0, doc.duration, 't');
        const value = this._num(c.value, range[0], range[1], c.prop);
        // "from": move an existing key (drag on the timeline) instead of adding a new one.
        if (c.from != null) {
            const from = this._num(c.from, 0, StudioSchema.MAX_DURATION, 'from');
            const k = doc.keyframes.find(k => k.target === c.target && k.prop === c.prop && Math.abs(k.t - from) < 0.005);
            if (!k) throw new Error('ключ в ' + from + ' с не найден');
            doc.keyframes = doc.keyframes.filter(x => x === k || !(x.target === c.target && x.prop === c.prop && Math.abs(x.t - t) < 0.005));
            k.t = Math.round(t * 1000) / 1000;
            k.value = value;
        } else {
            const old = doc.keyframes.find(k => k.target === c.target && k.prop === c.prop && Math.abs(k.t - t) < 0.005);
            if (old) old.value = value;
            else {
                if (doc.keyframes.length >= StudioSchema.MAX_KEYFRAMES) throw new Error('слишком много ключей');
                doc.keyframes.push({ target: c.target, prop: c.prop, t: Math.round(t * 1000) / 1000, value });
            }
        }
        doc.keyframes.sort((a, b) => (a.target + a.prop).localeCompare(b.target + b.prop) || a.t - b.t);
        return 'ключ ' + c.target + '.' + c.prop + ' = ' + value + ' в ' + t.toFixed(2) + ' с';
    },
    _remove_keyframe(doc, c) {
        this._allowed(c, ['target', 'prop', 't']);
        this._keyTarget(doc, c.target, c.prop);
        const t = this._num(c.t, 0, StudioSchema.MAX_DURATION, 't');
        const n = doc.keyframes.length;
        doc.keyframes = doc.keyframes.filter(k => !(k.target === c.target && k.prop === c.prop && Math.abs(k.t - t) < 0.005));
        if (doc.keyframes.length === n) throw new Error('ключ не найден');
        return 'ключ удалён';
    },
    _set_camera(doc, c) {
        const mode = c.mode;
        if (StudioSchema.CAMERA_MODES.indexOf(mode) < 0) throw new Error('mode: одно из ' + StudioSchema.CAMERA_MODES.join(', '));
        const fields = StudioSchema.SHOT_FIELDS[mode];
        this._allowed(c, ['t', 'mode', 'transition', 'from'].concat(Object.keys(fields)));
        const t = this._num(c.t != null ? c.t : 0, 0, doc.duration, 't');
        const shot = { t: Math.round(t * 1000) / 1000, mode };
        if (c.transition != null) {
            if (StudioSchema.TRANSITIONS.indexOf(c.transition) < 0) throw new Error('transition: cut или smooth');
            shot.transition = c.transition;
        }
        for (const [k, spec] of Object.entries(fields)) {
            if (c[k] != null) shot[k] = this._spec(spec, c[k], k);
            else if (spec.required) throw new Error('для режима ' + mode + ' нужно поле «' + k + '»');
        }
        if (shot.target && this._kindOf(doc, shot.target) !== 'object') throw new Error('цель камеры «' + shot.target + '» не найдена');
        if (mode === 'static' && !shot.target && !shot.look) throw new Error('неподвижной камере нужна цель target или точка look');
        const from = c.from != null ? this._num(c.from, 0, StudioSchema.MAX_DURATION, 'from') : t;
        doc.camera.shots = doc.camera.shots.filter(s => Math.abs(s.t - from) >= 0.005 && Math.abs(s.t - t) >= 0.005);
        if (doc.camera.shots.length >= StudioSchema.MAX_SHOTS) throw new Error('слишком много ракурсов');
        doc.camera.shots.push(shot);
        doc.camera.shots.sort((a, b) => a.t - b.t);
        return 'камера с ' + t.toFixed(2) + ' с: ' + StudioText.cameraMode(mode);
    },
    _remove_shot(doc, c) {
        this._allowed(c, ['t']);
        const t = this._num(c.t, 0, StudioSchema.MAX_DURATION, 't');
        const n = doc.camera.shots.length;
        doc.camera.shots = doc.camera.shots.filter(s => Math.abs(s.t - t) >= 0.005);
        if (doc.camera.shots.length === n) throw new Error('ракурс не найден');
        return 'ракурс удалён';
    },
    _add_behavior(doc, c) {
        this._allowed(c, ['id', 'type', 'hunter', 'prey', 'aggression', 'gap', 'minGap', 'maxSpeed', 'accel', 'lane', 'delay']);
        const id = this._id(c.id, 'id');
        this._idFree(doc, id);
        if (c.type !== 'chase') throw new Error('type: пока есть только chase (погоня)');
        const P = StudioSchema.PARAMS.behavior;
        const b = { id, type: 'chase', hunter: this._id(c.hunter, 'hunter'), prey: this._id(c.prey, 'prey'),
            aggression: 0.6, gap: 900, minGap: 260, maxSpeed: 760, accel: 900, lane: 0, delay: 0.5 };
        if (!this._find(doc.objects, b.hunter)) throw new Error('преследователь «' + b.hunter + '» не найден');
        if (!this._find(doc.objects, b.prey)) throw new Error('цель «' + b.prey + '» не найдена');
        if (b.hunter === b.prey) throw new Error('объект не может гнаться сам за собой');
        if (doc.behaviors.some(x => x.hunter === b.hunter)) throw new Error('у «' + b.hunter + '» уже есть поведение');
        for (const k of ['aggression', 'gap', 'minGap', 'maxSpeed', 'accel', 'lane', 'delay']) if (c[k] != null) b[k] = this._spec(P[k], c[k], k);
        doc.behaviors.push(b);
        return 'погоня ' + b.hunter + ' → ' + b.prey;
    },
    _remove_behavior(doc, c) {
        this._allowed(c, ['id']);
        const id = this._id(c.id, 'id');
        const n = doc.behaviors.length;
        doc.behaviors = doc.behaviors.filter(b => b.id !== id);
        if (doc.behaviors.length === n) throw new Error('поведение «' + id + '» не найдено');
        doc.keyframes = doc.keyframes.filter(k => k.target !== id);
        return 'поведение ' + id + ' удалено';
    },
    _set_param(doc, c) {
        this._allowed(c, ['target', 'param', 'value']);
        const target = c.target === 'scene' ? 'scene' : this._id(c.target, 'target');
        const kind = this._kindOf(doc, target);
        const specs = kind ? StudioSchema.PARAMS[kind] : null;
        if (!specs) throw new Error('цель «' + target + '» не найдена');
        const spec = specs[c.param];
        if (!spec) throw new Error('у «' + target + '» нет параметра «' + c.param + '»');
        const value = this._spec(spec, c.value, c.param);
        if (kind === 'scene') {
            if (c.param === 'blend') doc.camera.blend = value;
            else doc[c.param] = value;
        } else {
            const rec = this._find(kind === 'object' ? doc.objects : doc.behaviors, target);
            if ((c.param === 'hunter' || c.param === 'prey') && !this._find(doc.objects, value)) throw new Error('объект «' + value + '» не найден');
            if (c.param === 'path' && !this._find(doc.paths, value)) throw new Error('путь «' + value + '» не найден');
            rec[c.param] = value;
        }
        return target + '.' + c.param + ' = ' + value;
    },
    _set_duration(doc, c) {
        this._allowed(c, ['value']);
        doc.duration = this._num(c.value, 1, StudioSchema.MAX_DURATION, 'value');
        doc.keyframes = doc.keyframes.filter(k => k.t <= doc.duration);
        doc.camera.shots = doc.camera.shots.filter(s => s.t < doc.duration);
        return 'длина сцены ' + doc.duration + ' с';
    }
};

// Undo / redo over whole-document snapshots: the AI's commands and the human's drags share it.
class StudioHistory {
    constructor(doc) {
        this.doc = doc;
        this.past = [];
        this.future = [];
        this.limit = 120;
    }
    push(next) {
        this.past.push(this.doc);
        if (this.past.length > this.limit) this.past.shift();
        this.future = [];
        this.doc = next;
    }
    undo() {
        if (!this.past.length) return false;
        this.future.push(this.doc);
        this.doc = this.past.pop();
        return true;
    }
    redo() {
        if (!this.future.length) return false;
        this.past.push(this.doc);
        this.doc = this.future.pop();
        return true;
    }
}
