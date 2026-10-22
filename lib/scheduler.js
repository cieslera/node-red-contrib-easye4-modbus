"use strict";
// Gemeinsame Warteschlange je easyE4 (Adresse:Port):
// - nie mehr als eine Anfrage gleichzeitig
// - Mindestpause zwischen Anfragen (gap)
// - nach einem Verbindungsfehler wachsende Pause (1 s, 2 s, 4 s ... max. 10 s)
// - Aufträge mit gleichem Schlüssel werden zusammengefasst (neuester Auftrag gewinnt)

const MAX_QUEUE = 200;

function createScheduler() {
    const queue = [];
    let busy = false;
    let lastEnd = 0;
    let backoff = 0;
    let timer = null;
    const s = {
        gaps: new Map(),
        get gap() { let g = 0; s.gaps.forEach((v) => { g = Math.max(g, v); }); return g; },
        get backoff() { return backoff; },
        add(job) {
            return new Promise((resolve, reject) => {
                if (job.key) {
                    const waiting = queue.find((j) => j.key === job.key);
                    if (waiting) {
                        waiting.run = job.run;
                        waiting.waiters.push({ resolve, reject });
                        return;
                    }
                }
                if (queue.length >= MAX_QUEUE) return reject(Object.assign(new Error("queue"), { queueFull: true }));
                job.waiters = [{ resolve, reject }];
                if (job.urgent) queue.unshift(job);
                else queue.push(job);
                pump();
            });
        },
        drop(filter, err) {
            for (let i = queue.length - 1; i >= 0; i--) {
                if (filter(queue[i])) queue.splice(i, 1)[0].waiters.forEach((w) => w.reject(err));
            }
        },
        get length() { return queue.length; },
    };
    function pump() {
        if (busy || queue.length === 0) return;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        const wait = Math.max(0, lastEnd + s.gap + (queue[0].urgent ? 0 : backoff) - Date.now());
        if (wait > 0) {
            timer = setTimeout(() => { timer = null; pump(); }, wait);
            return;
        }
        busy = true;
        const job = queue.shift();
        Promise.resolve()
            .then(() => job.run())
            .then((res) => {
                backoff = 0;
                job.waiters.forEach((w) => w.resolve(res));
            }, (err) => {
                if (err && err.network) backoff = Math.min(backoff ? backoff * 2 : 1000, 10000);
                job.waiters.forEach((w) => w.reject(err));
            })
            .finally(() => {
                busy = false;
                lastEnd = Date.now();
                pump();
            });
    }
    return s;
}

module.exports = { createScheduler, MAX_QUEUE };
