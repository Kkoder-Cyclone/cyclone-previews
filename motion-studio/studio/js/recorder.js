// recorder.js — video export through the browser's MediaRecorder (WebM). The studio plays the
// scene from 0 in real time and records the 3D canvas only (the marks over it stay out of the
// video). Sim time follows the wall clock, so a slow device gives fewer frames, never a slower film.
// Stage 2: frame-exact export through WebCodecs.

class StudioRecorder {
    static supported() {
        return typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
    }

    static mime() {
        const list = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
        for (const m of list) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
        return '';
    }

    // canvas -> Promise<Blob>; stop() ends it early. fps — capture rate.
    constructor(canvas, fps) {
        this.canvas = canvas;
        this.fps = fps || 30;
        this.chunks = [];
        this.rec = null;
        this.done = null;
    }

    start() {
        const stream = this.canvas.captureStream(this.fps);
        const mime = StudioRecorder.mime();
        this.rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8000000 } : undefined);
        this.done = new Promise((resolve, reject) => {
            this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
            this.rec.onstop = () => {
                for (const tr of stream.getTracks()) tr.stop();
                resolve(new Blob(this.chunks, { type: mime || 'video/webm' }));
            };
            this.rec.onerror = (e) => reject(e);
        });
        this.rec.start(250);
        return this.done;
    }

    stop() {
        if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
        return this.done;
    }
}
