module.exports = function (RED) {
    "use strict";
    const EventEmitter = require("events");
    const MB = require("./lib/modbus-tcp.js");
    const MAP = require("./lib/easye4mb-map.js");
    const { createScheduler } = require("./lib/scheduler.js");

    const _ = (key, args) => RED._("easye4mb." + key, args);
    // Fehler in die eingestellte Sprache übersetzen
    function errText(err, tr) {
        tr = tr || _;
        if (err && err.e4) return tr("errors." + err.e4.key, err.e4.args);
        if (err && err.exception) return excText(err.exception, tr, err.fc);
        return err && err.message ? err.message : String(err);
    }
    function excText(code, tr, fc) {
        tr = tr || _;
        const write = [5, 6, 15, 16].includes(fc);
        if (code === 2 && write) return tr("exception.2w");
        if (code === 1 || code === 2 || code === 3 || code === 4 || code === 6) return tr("exception." + code);
        return tr("exception.other", { code });
    }
    function short(s) {
        s = String(s);
        return s.length > 40 ? s.slice(0, 37) + "..." : s;
    }
    function isPlainObject(v) {
        return v !== null && typeof v === "object" && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Date);
    }
    function pad(n) { return String(n).padStart(2, "0"); }
    function clockText(c) {
        return pad(c.day) + "." + pad(c.month) + "." + c.year + " " + pad(c.hour) + ":" + pad(c.minute) + ":" + pad(c.second);
    }

    // ================================================================================ gemeinsame Verbindung je easyE4
    // Die easyE4 bedient höchstens zwei Modbus-TCP-Clients. Deshalb teilen sich alle Einträge mit derselben
    // Adresse:Port eine TCP-Verbindung und eine Warteschlange.
    const links = new Map();
    function getLink(host, port, timeout) {
        const id = host + ":" + port;
        let l = links.get(id);
        if (!l) {
            l = { client: new MB.ModbusTcpClient(host, port, { connectTimeout: timeout }), sched: createScheduler(), users: 0 };
            links.set(id, l);
        }
        l.users++;
        return { id, link: l };
    }
    function releaseLink(id) {
        const l = links.get(id);
        if (!l) return;
        l.users--;
        if (l.users <= 0) {
            l.client.close();
            links.delete(id);
        }
    }

    // Baut die Verbindung auf "dev" auf (Konfigurationsknoten oder ein EventEmitter für den Verbindungstest)
    function setupDevice(dev, config, tr) {
        tr = tr || _;
        dev.host = String(config.host || "").trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
        dev.port = parseInt(config.port, 10) || 502;
        const unit = parseInt(config.unitId, 10);
        dev.unitId = Number.isFinite(unit) && unit >= 0 && unit <= 255 ? unit : 1;
        dev.timeout = Math.min(Math.max(parseInt(config.timeout, 10) || 2000, 200), 30000);
        const gap = parseInt(config.gap, 10);
        dev.gap = Number.isFinite(gap) ? Math.min(Math.max(gap, 0), 5000) : 20;
        dev.fw = MAP.fwLevel(config.firmware);
        // Adressierung: "direct" = Telegramm-Adresse = Register-Nr. (easyE4, gemessen), "minus1" = Register-Nr. - 1
        dev.addressing = config.addressing === "minus1" ? "minus1" : "direct";
        const P = MB.builders(dev.addressing === "minus1" ? 1 : 0);
        dev.problem = null;
        if (!dev.host) dev.problem = tr("errors.noHost");
        else if (dev.port < 1 || dev.port > 65535) dev.problem = tr("errors.badPort");

        dev.state = "unknown";
        dev.watchers = new Set();
        function setState(s) {
            if (dev.state === s) return;
            dev.state = s;
            dev.watchers.forEach((fn) => fn());
        }
        if (dev.problem) {
            dev.on("close", (done) => done && done());
            return;
        }

        const { id: linkId, link } = getLink(dev.host, dev.port, dev.timeout);
        const sched = link.sched;
        const gapToken = {};
        sched.gaps.set(gapToken, dev.gap);
        let closed = false;
        let noFc5 = false; // die easyE4 lehnt FC5 ab: Bits über das zugehörige Wort schreiben
        let noGaps = false; // Anfragen nicht mehr über Lücken hinweg zusammenfassen

        // Eine Anfrage direkt senden (nur innerhalb eines Warteschlangen-Auftrags aufrufen)
        function send(pdu) {
            return link.client.request(dev.unitId, pdu, dev.timeout).then((res) => {
                setState("online");
                return res;
            }, (err) => {
                if (err.exception) {
                    setState("online"); // die easyE4 hat geantwortet, nur nicht mit Daten
                    throw err;
                }
                setState("offline");
                const e = new Error(tr("errors.network", { host: dev.host + ":" + dev.port, msg: err.code || err.message }));
                e.network = true;
                throw e;
            });
        }
        function readRaw(fc, addr, count) {
            return send(P.readPdu(fc, addr, count)).then((res) => MB.parseRead(fc, res, count));
        }

        // Auftrag einreihen. fn bekommt "send"/"readRaw" und läuft ohne andere Anfragen dazwischen.
        dev.job = function (fn, opts) {
            if (closed) return Promise.reject(new Error(tr("errors.closed")));
            const key = opts && opts.key ? dev.host + ":" + dev.port + "|" + dev.unitId + "|" + opts.key : null;
            return sched.add({ key, urgent: !!config.urgent, owner: gapToken, run: () => fn({ send, readRaw, P }) })
                .catch((err) => {
                    if (err.queueFull) throw new Error(tr("errors.queueFull"));
                    throw err;
                });
        };

        // Operanden lesen. Liefert { values, errors: [{key, code, text}], requests }
        dev.readOps = function (ops) {
            const data = new Map();
            const errors = new Map();
            const requests = [];
            const store = (r, vals) => vals.forEach((v, i) => data.set(r.fc + "|" + (r.addr + i), v));
            const reqs = MAP.planReads(ops, { noGaps: noGaps });
            return reqs.reduce((p, r) => p.then(() => dev.job((io) => io.readRaw(r.fc, r.addr, r.count)).then((vals) => {
                requests.push(r);
                store(r, vals);
            }, (err) => {
                if (!err.exception) throw err;
                // Lücken in zusammengefassten Anfragen sind offenbar nicht freigegeben: künftig ohne Lücken planen
                const wanted = new Set();
                ops.forEach((op) => op.parts.forEach((pt) => { if (pt.fc === r.fc && pt.addr >= r.addr && pt.addr < r.addr + r.count) wanted.add(pt.addr); }));
                if (wanted.size < r.count) noGaps = true;
                // Eine einzige nicht freigegebene Adresse lässt die ganze Anfrage scheitern:
                // dann jeden betroffenen Operanden einzeln lesen, um den Schuldigen zu finden.
                const inside = ops.filter((op) => op.parts.some((pt) => pt.fc === r.fc && pt.addr >= r.addr && pt.addr < r.addr + r.count));
                if (r.count === 1 || inside.length <= 1) {
                    inside.forEach((op) => errors.set(op.key, err.exception));
                    return;
                }
                return inside.reduce((q, op) => q.then(() => {
                    const sub = MAP.planReads([op], { noGaps: true });
                    return sub.reduce((q2, s) => q2.then(() => dev.job((io) => io.readRaw(s.fc, s.addr, s.count)).then((v) => {
                        requests.push(s);
                        store(s, v);
                    })), Promise.resolve()).catch((e2) => {
                        if (!e2.exception) throw e2;
                        errors.set(op.key, e2.exception);
                    });
                }), Promise.resolve());
            })), Promise.resolve()).then(() => {
                const okOps = ops.filter((op) => !errors.has(op.key));
                const res = MAP.decodeAll(okOps, data);
                const errs = [...errors.entries()].map(([key, code]) => ({ key, code, text: excText(code, tr, 3) }));
                res.missing.forEach((key) => errs.push({ key, code: 0, text: tr("errors.noValue") }));
                return { values: res.values, errors: errs, requests };
            });
        };

        // Einen Schreib-Plan ausführen (siehe MAP.writePlan)
        dev.writePlan = function (plan) {
            const rmwBit = (io) => io.readRaw(3, plan.wordAddr, 1).then((v) => {
                const w = plan.value ? v[0] | (1 << plan.bit) : v[0] & ~(1 << plan.bit);
                return io.send(io.P.writeRegPdu(plan.wordAddr, w));
            });
            return dev.job((io) => {
                switch (plan.kind) {
                    case "coil":
                        if (noFc5) return rmwBit(io);
                        return io.send(io.P.writeCoilPdu(plan.addr, plan.value)).catch((err) => {
                            if (err.exception !== 1) throw err;
                            noFc5 = true;
                            return rmwBit(io);
                        });
                    case "reg":
                        return io.send(io.P.writeRegPdu(plan.addr, plan.value));
                    case "regs":
                        return io.send(io.P.writeRegsPdu(plan.addr, plan.values));
                    case "byte":
                        // Byte = halbes Merkerwort: Wort lesen, Byte ersetzen, Wort schreiben
                        return io.readRaw(3, plan.addr, 1).then((v) => {
                            const w = plan.high ? (v[0] & 0x00ff) | (plan.value << 8) : (v[0] & 0xff00) | plan.value;
                            return io.send(io.P.writeRegPdu(plan.addr, w));
                        });
                }
                throw new Error("plan " + plan.kind);
            }, { key: plan.key });
        };

        // Uhr stellen (Register 5000..5005). Liest vorher das Jahr, um zwei- oder vierstellig zu schreiben.
        dev.setClock = function (date) {
            return dev.job((io) => io.readRaw(3, 5005, 1).then((v) => {
                const regs = MAP.clockRegs(date, v[0] < 100);
                return io.send(io.P.writeRegsPdu(5000, regs)).then(() => regs);
            }), { key: "CLOCK" });
        };

        dev.on("close", function (done) {
            closed = true;
            sched.drop((job) => job.owner === gapToken, new Error(tr("errors.closed")));
            sched.gaps.delete(gapToken);
            releaseLink(linkId);
            if (done) done();
        });
    }

    function EasyE4MbDeviceNode(config) {
        RED.nodes.createNode(this, config);
        setupDevice(this, config);
    }
    RED.nodes.registerType("easye4mb-device", EasyE4MbDeviceNode);

    // "Verbindung testen" im Gerätedialog: liest die Uhr (oder MW1) der easyE4
    RED.httpAdmin.post("/easye4mb/test", RED.auth.needsPermission("flows.write"), function (req, res) {
        const b = req.body || {};
        const lng = typeof b.lang === "string" && /^[A-Za-z-]{2,10}$/.test(b.lang) ? b.lang : undefined;
        const tr = (key, args) => RED._("easye4mb." + key, Object.assign({}, args, lng ? { lng } : {}));
        const want = b.addressing === "minus1" ? "minus1" : "direct";
        // Uhr bzw. MW1 mit einer bestimmten Adressierung lesen. Ergebnis { clock, mw1 } oder Fehler
        function probe(addressing) {
            const tmp = new EventEmitter();
            setupDevice(tmp, { host: b.host, port: b.port, unitId: b.unitId, timeout: b.timeout, gap: 0, firmware: b.firmware,
                addressing, urgent: true }, tr);
            if (tmp.problem) return Promise.reject(new Error(tmp.problem));
            return tmp.readOps([MAP.clock(), MAP.operand("MW", 1, tmp.fw)])
                .then((r) => {
                    // Uhr nur gelten lassen, wenn sie plausibel ist (bei falscher Adressierung liegt alles ein Register daneben)
                    const c = r.values.CLOCK;
                    const ok = c && c.month >= 1 && c.month <= 12 && c.day >= 1 && c.day <= 31 && c.hour < 24 &&
                        c.minute < 60 && c.second < 60 && c.year >= 2000 && c.year <= 2099;
                    return { clock: ok ? c : undefined, badClock: !!c && !ok, mw1: r.values.MW1 };
                })
                .finally(() => tmp.emit("close", () => {}));
        }
        const text = (r) => (r.clock ? tr("test.okClock", { clock: clockText(r.clock) }) : tr("test.okMw", { value: r.mw1 }));
        probe(want)
            .then((r) => {
                if (r.clock || (r.mw1 !== undefined && !r.badClock)) return res.json({ ok: true, text: text(r) });
                // Nichts lesbar: vielleicht stimmt die Adressierung nicht – die andere probieren
                const other = want === "direct" ? "minus1" : "direct";
                return probe(other).then((r2) => {
                    if (r2.clock || (r2.mw1 !== undefined && !r2.badClock)) {
                        return res.json({ ok: true, warn: true, suggest: other,
                            text: text(r2) + " " + tr("test.switched", { mode: tr("addressing." + other) }) });
                    }
                    res.json({ ok: true, warn: true, text: tr("test.okNoData") });
                });
            })
            .catch((err) => res.json({ ok: false, text: errText(err, tr) }));
    });

    // ================================================================================ gemeinsame Teile der Knoten

    function attach(node, config) {
        const dev = RED.nodes.getNode(config.device);
        if (!dev || dev.problem) {
            const p = !dev ? _("errors.noDevice") : dev.problem;
            node.status({ fill: "red", shape: "ring", text: short(p) });
            node.error(p);
            return null;
        }
        node.e4Text = null;
        node.e4Fill = null;
        function render() {
            if (node.e4Fill === "red") return node.status({ fill: "red", shape: "ring", text: short(node.e4Text) });
            if (dev.state === "offline") return node.status({ fill: "red", shape: "ring", text: _("status.offline") });
            if (node.e4Text !== null) return node.status({ fill: node.e4Fill || "green", shape: "dot", text: short(node.e4Text) });
            if (dev.state === "online") return node.status({ fill: "green", shape: "dot", text: _("status.online") });
            node.status({ fill: "grey", shape: "ring", text: _("status.unknown") });
        }
        node.e4Show = function (fill, text) {
            node.e4Fill = fill;
            node.e4Text = text;
            render();
        };
        dev.watchers.add(render);
        node.on("close", function () { dev.watchers.delete(render); });
        render();
        return dev;
    }
    const int = (v) => parseInt(String(v === undefined ? "" : v).trim(), 10);

    // ================================================================================ easyE4 Modbus lesen

    // Was gelesen wird: { ops } oder { raw: {fc, addr, count} }; null = aus der Nachricht
    function readSpec(config, fw) {
        switch (config.mode || "operand") {
            case "operand":
                return { ops: [MAP.operand(config.opType || "MW", int(config.index), fw)], single: true };
            case "range":
                return { ops: MAP.range(config.opType || "MW", int(config.index), int(config.rangeEnd), fw) };
            case "list":
                return { ops: MAP.parseList(config.list, fw) };
            case "clock":
                return { ops: [MAP.clock()], single: true, clock: true };
            case "raw":
                return { raw: MAP.rawRead(config.fc, config.addr, config.count) };
            case "msg":
                return null;
        }
        throw new Error("mode " + config.mode);
    }
    function specFromMsg(msg, fw) {
        const src = typeof msg.topic === "string" && msg.topic.trim() ? msg.topic
            : typeof msg.payload === "string" || Array.isArray(msg.payload) ? msg.payload : null;
        if (src === null) throw MAP.fail("noElementInMsg", {});
        const ops = MAP.parseList(src, fw);
        return ops.length === 1 ? { ops, single: true, clock: ops[0].type === "CLOCK" } : { ops };
    }

    function EasyE4MbReadNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const dev = attach(node, config);
        if (!dev) return;
        let fixed;
        try {
            fixed = readSpec(config, dev.fw);
        } catch (err) {
            const t = errText(err);
            node.e4Show("red", t);
            node.error(t);
            return;
        }
        const onlyChange = config.onlyChange === true || config.onlyChange === "true";
        // Abfrageintervall: 0 = aus, sonst mindestens 0,1 s
        const iv = Number(String(config.interval === undefined ? "" : config.interval).replace(",", ".")) || 0;
        const interval = iv > 0 ? Math.max(0.1, iv) : 0;
        const last = new Map();
        let running = false;
        let closing = false;
        let timer = null;
        let lastLog = null;

        function changed(topic, payload) {
            if (!onlyChange) return true;
            const s = JSON.stringify(payload);
            if (last.get(topic) === s) return false;
            last.set(topic, s);
            return true;
        }

        function run(msg, spec, send, done) {
            running = true;
            let p;
            if (spec.raw) {
                const r = spec.raw;
                p = dev.job((io) => io.readRaw(r.fc, r.addr, r.count)).then((vals) => ({
                    topic: "FC" + r.fc + ":" + r.addr, payload: r.count === 1 ? vals[0] : vals, errors: [],
                    shown: r.count === 1 ? String(vals[0]) : _("status.values", { n: vals.length }),
                }));
            } else {
                p = dev.readOps(spec.ops).then((r) => {
                    const keys = spec.ops.map((op) => op.key);
                    if (r.errors.length === keys.length) {
                        const e = new Error(r.errors.map((x) => x.key + ": " + x.text).join("; "));
                        e.short = r.errors[0].key + ": " + r.errors[0].text;
                        throw e;
                    }
                    if (spec.single) {
                        const v = r.values[keys[0]];
                        return { topic: keys[0], payload: v, errors: r.errors, shown: spec.clock ? clockText(v) : String(v), clock: spec.clock };
                    }
                    return { topic: keys.join("+"), payload: r.values, errors: r.errors, shown: _("status.values", { n: Object.keys(r.values).length }) };
                });
            }
            p.then((res) => {
                if (res.errors.length) {
                    const t = res.errors.map((x) => x.key + ": " + x.text).join("; ");
                    node.e4Show("yellow", res.errors[0].key + ": " + res.errors[0].text);
                    if (done || t !== lastLog) node.warn(t);
                    lastLog = t;
                } else {
                    node.e4Show("green", res.shown);
                    lastLog = null;
                }
                if (changed(res.topic, res.payload)) {
                    const out = msg || {};
                    out.topic = res.topic;
                    out.payload = res.payload;
                    if (res.clock) {
                        const c = res.payload;
                        out.date = new Date(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
                    }
                    if (res.errors.length) out.errors = res.errors;
                    send(out);
                }
                if (done) done();
            }).catch((err) => {
                if (closing) return;
                const t = errText(err);
                if (!err.network) node.e4Show("red", err.short || t);
                else node.e4Show(null, null);
                if (done) done(new Error(t));
                else if (t !== lastLog) node.error(t, msg); // beim Abfragen denselben Fehler nur einmal melden
                lastLog = t;
            }).finally(() => { running = false; });
        }

        node.on("input", function (msg, send, done) {
            send = send || function () { node.send.apply(node, arguments); };
            done = done || function (err) { if (err) node.error(err, msg); };
            let spec = fixed;
            try {
                if (!spec) spec = specFromMsg(msg, dev.fw);
            } catch (err) {
                const t = errText(err);
                node.e4Show("red", t);
                return done(new Error(t));
            }
            run(msg, spec, send, done);
        });

        if (interval > 0 && fixed) {
            const tick = () => {
                if (!running) run(null, fixed, (m) => node.send(m), null);
            };
            timer = setInterval(tick, interval * 1000);
            setTimeout(tick, 200);
        }
        node.on("close", function () {
            closing = true;
            if (timer) clearInterval(timer);
        });
    }
    RED.nodes.registerType("easye4mb-read", EasyE4MbReadNode);

    // ================================================================================ easyE4 Modbus schreiben

    // Aufträge: [{ label, run(dev) -> Promise }]
    function writeJobs(config, msg, fw) {
        const mode = config.mode || "operand";
        if (mode === "operand") {
            if (msg.payload === undefined) throw MAP.fail("payloadMissing", {});
            const plan = MAP.writePlan(config.opType || "MW", int(config.index), msg.payload, fw);
            return [{ label: plan.key, value: msg.payload, run: (d) => d.writePlan(plan) }];
        }
        if (mode === "clock") {
            const d = MAP.toDate(msg.payload);
            return [{ label: "CLOCK", value: d, run: (dv) => dv.setClock(d) }];
        }
        if (mode === "raw") {
            if (msg.payload === undefined) throw MAP.fail("payloadMissing", {});
            const fc = int(config.fc);
            const addr = int(config.addr);
            if (!Number.isInteger(addr) || addr < 1 || addr > 65536) throw MAP.fail("badAddr", {});
            if (fc === 5) {
                const on = MAP.toBool(msg.payload);
                return [{ label: "FC5:" + addr, value: on, run: (d) => d.job((io) => io.send(io.P.writeCoilPdu(addr, on)), { key: "FC5:" + addr }) }];
            }
            if (fc === 6) {
                const v = MAP.toInt(msg.payload, -32768, 65535, "FC6:" + addr);
                return [{ label: "FC6:" + addr, value: v, run: (d) => d.job((io) => io.send(io.P.writeRegPdu(addr, v < 0 ? v + 65536 : v)), { key: "FC6:" + addr }) }];
            }
            if (fc === 16) {
                const arr = (Array.isArray(msg.payload) ? msg.payload : [msg.payload]).map((x) => {
                    const v = MAP.toInt(x, -32768, 65535, "FC16:" + addr);
                    return v < 0 ? v + 65536 : v;
                });
                if (arr.length < 1 || arr.length > 123) throw MAP.fail("badCount", { max: 123 });
                return [{ label: "FC16:" + addr, value: arr, run: (d) => d.job((io) => io.send(io.P.writeRegsPdu(addr, arr)), { key: "FC16:" + addr }) }];
            }
            throw MAP.fail("badFc", { fc });
        }
        // aus der Nachricht: {MW3: 5, M1: true, CLOCK: "now"} oder topic + payload
        let entries;
        if (isPlainObject(msg.payload)) entries = Object.entries(msg.payload);
        else if (typeof msg.topic === "string" && msg.topic.trim()) {
            if (msg.payload === undefined) throw MAP.fail("payloadMissing", {});
            entries = [[msg.topic, msg.payload]];
        } else throw MAP.fail("noWriteTarget", {});
        if (entries.length === 0) throw MAP.fail("noOperands", {});
        return entries.map(([k, v]) => {
            const ks = String(k).trim().toUpperCase();
            if (ks === "CLOCK" || ks === "UHR" || ks === "RTC") {
                const d = MAP.toDate(v);
                return { label: "CLOCK", value: d, run: (dv) => dv.setClock(d) };
            }
            const pk = MAP.parseKey(k);
            const plan = MAP.writePlan(pk.type, pk.index, v, fw);
            return { label: plan.key, value: v, run: (d) => d.writePlan(plan) };
        });
    }

    function EasyE4MbWriteNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const dev = attach(node, config);
        if (!dev) return;

        node.on("input", function (msg, send, done) {
            send = send || function () { node.send.apply(node, arguments); };
            done = done || function (err) { if (err) node.error(err, msg); };
            let jobs;
            try {
                jobs = writeJobs(config, msg, dev.fw);
            } catch (err) {
                const t = errText(err);
                node.e4Show("red", t);
                return done(new Error(t));
            }
            const results = [];
            jobs.reduce((p, job) => p.then(() => job.run(dev).then(() => {
                results.push({ target: job.label, value: job.value, ok: true });
            }).catch((err) => {
                err.target = job.label;
                throw err;
            })), Promise.resolve())
                .then(() => {
                    const j = jobs[0];
                    const shown = jobs.length === 1
                        ? j.label === "CLOCK" ? _("status.clockSet") : j.label + " = " + (Array.isArray(j.value) ? j.value.join(",") : String(j.value))
                        : _("status.written", { n: jobs.length });
                    node.e4Show("green", shown);
                    msg.success = true;
                    msg.results = results;
                    send(msg);
                    done();
                })
                .catch((err) => {
                    const t = (err.target ? err.target + ": " : "") + errText(err);
                    if (!err.network) node.e4Show("red", t);
                    else node.e4Show(null, null);
                    done(new Error(t));
                });
        });
    }
    RED.nodes.registerType("easye4mb-write", EasyE4MbWriteNode);
};
