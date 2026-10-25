"use strict";
// Schlanker Modbus-TCP-Client ohne fremde Abhängigkeiten.
// Eine Verbindung je easyE4 (die easyE4 bedient höchstens zwei Modbus-TCP-Clients gleichzeitig),
// immer nur eine Anfrage gleichzeitig. Die Warteschlange davor liegt in scheduler.js.

const net = require("net");
const EventEmitter = require("events");

// Modbus-Exception-Codes
const EXCEPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 11];

function netError(code, message) {
    const e = new Error(message || code);
    e.code = code;
    e.network = true;
    return e;
}

class ModbusTcpClient extends EventEmitter {
    constructor(host, port, opts) {
        super();
        this.host = host;
        this.port = port;
        this.idleClose = (opts && opts.idleClose) || 30000; // ruhende Verbindung nach 30 s schließen
        this.connectTimeout = (opts && opts.connectTimeout) || 3000;
        this.socket = null;
        this.connecting = null;
        this.tid = Math.floor(Math.random() * 0xffff);
        this.pending = null; // { tid, resolve, reject, timer }
        this.buf = Buffer.alloc(0);
        this.idleTimer = null;
        this.closed = false;
    }

    // Verbindung herstellen (falls nötig)
    connect() {
        if (this.closed) return Promise.reject(netError("ECLOSED", "closed"));
        if (this.socket && !this.socket.destroyed && !this.connecting) return Promise.resolve(false);
        if (this.connecting) return this.connecting;
        // Korrektur 1.0.2: Jeder Verbindungsversuch kümmert sich nur um sich selbst.
        // Vorher konnte das verspätete "close" einer alten, abgebrochenen Verbindung den neuen Versuch
        // zurücksetzen – dessen Promise wurde dann nie erfüllt und alle Anfragen blieben hängen.
        const attempt = new Promise((resolve, reject) => {
            let settled = false;
            const s = net.createConnection({ host: this.host, port: this.port });
            s.setNoDelay(true);
            const failAttempt = (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(t);
                if (this.connecting === attempt) this.connecting = null;
                reject(err);
            };
            const t = setTimeout(() => {
                s.destroy();
                failAttempt(netError("ETIMEDOUT", "connect timeout"));
            }, this.connectTimeout);
            s.once("connect", () => {
                if (settled) return s.destroy();
                settled = true;
                clearTimeout(t);
                this.socket = s;
                this.buf = Buffer.alloc(0);
                if (this.connecting === attempt) this.connecting = null;
                s.setKeepAlive(true, 10000);
                resolve(true);
            });
            s.on("data", (d) => { if (this.socket === s) this._onData(d); });
            s.on("error", (err) => {
                // auf "error" folgt immer "close"; offene Anfragen beendet der close-Handler
                failAttempt(netError(err.code || "ECONN", err.message));
            });
            s.on("close", () => {
                failAttempt(netError("ECONNRESET", "closed"));
                if (this.socket !== s) return; // alte Verbindung: die aktuelle nicht anfassen
                this.socket = null;
                this._fail(netError("ECONNRESET", "connection closed"));
            });
        });
        this.connecting = attempt;
        return attempt;
    }

    _fail(err) {
        const p = this.pending;
        if (!p) return;
        this.pending = null;
        clearTimeout(p.timer);
        p.reject(err);
    }

    _onData(d) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
        while (this.buf.length >= 7) {
            const len = this.buf.readUInt16BE(4);
            if (len < 2 || len > 260) {
                // kaputter Datenstrom: Verbindung neu aufbauen
                this.buf = Buffer.alloc(0);
                this._fail(netError("EBADFRAME", "invalid frame"));
                if (this.socket) this.socket.destroy();
                return;
            }
            if (this.buf.length < 6 + len) return;
            const frame = this.buf.subarray(0, 6 + len);
            this.buf = this.buf.subarray(6 + len);
            const tid = frame.readUInt16BE(0);
            const p = this.pending;
            if (!p || p.tid !== tid) continue; // verspätete Antwort auf eine abgelaufene Anfrage
            this.pending = null;
            clearTimeout(p.timer);
            p.resolve(Buffer.from(frame.subarray(7)));
        }
    }

    _armIdle() {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (!this.pending && this.socket) this.socket.end();
        }, this.idleClose);
        if (this.idleTimer.unref) this.idleTimer.unref();
    }

    _send(unit, pdu, timeout) {
        return new Promise((resolve, reject) => {
            if (!this.socket || this.socket.destroyed) return reject(netError("ECONNRESET", "not connected"));
            if (this.pending) return reject(new Error("busy"));
            this.tid = (this.tid + 1) & 0xffff;
            const head = Buffer.alloc(7);
            head.writeUInt16BE(this.tid, 0);
            head.writeUInt16BE(0, 2);
            head.writeUInt16BE(pdu.length + 1, 4);
            head.writeUInt8(unit & 0xff, 6);
            const timer = setTimeout(() => {
                if (this.pending && this.pending.timer === timer) {
                    this.pending = null;
                    // Nach einer ausgebliebenen Antwort ist der Datenstrom unsicher: neu verbinden
                    if (this.socket) this.socket.destroy();
                    reject(netError("ETIMEDOUT", "timeout"));
                }
            }, timeout);
            this.pending = { tid: this.tid, resolve, reject, timer };
            this.socket.write(Buffer.concat([head, pdu]));
        });
    }

    // Eine Anfrage senden; liefert die Antwort-PDU (ohne Kopf). Modbus-Exceptions werden zu Fehlern mit .exception
    request(unit, pdu, timeout) {
        clearTimeout(this.idleTimer);
        return this.connect()
            .then((fresh) => this._send(unit, pdu, timeout).catch((err) => {
                // ruhende Verbindung wurde von der easyE4 geschlossen: einmal neu verbinden
                if (!fresh && err.network && err.code === "ECONNRESET") {
                    return this.connect().then(() => this._send(unit, pdu, timeout));
                }
                throw err;
            }))
            .then((res) => {
                this._armIdle();
                if (res.length < 1) throw netError("EBADFRAME", "empty");
                if (res[0] === (pdu[0] | 0x80)) {
                    const e = new Error("exception " + res[1]);
                    e.exception = res[1];
                    e.fc = pdu[0];
                    throw e;
                }
                if (res[0] !== pdu[0]) throw netError("EBADFRAME", "function code mismatch");
                return res;
            }, (err) => {
                this._armIdle();
                throw err;
            });
    }

    close() {
        this.closed = true;
        clearTimeout(this.idleTimer);
        this._fail(netError("ECLOSED", "closed"));
        if (this.socket) this.socket.destroy();
        this.socket = null;
    }
}

// ------------------------------------------------------------------------------------------------ PDUs
// addr = Modbus-Register-Nr. wie in der Eaton-Tabelle. off = Abzug für die Telegramm-Adresse:
// 0 = Register-Nr. direkt (so arbeitet die easyE4 tatsächlich, gemessen 22.10.2026), 1 = Register-Nr. - 1 (Eaton-Doku).

function readPdu(fc, addr, count, off) {
    const b = Buffer.alloc(5);
    b[0] = fc;
    b.writeUInt16BE(addr - (off === undefined ? 0 : off), 1);
    b.writeUInt16BE(count, 3);
    return b;
}
function writeCoilPdu(addr, on, off) {
    const b = Buffer.alloc(5);
    b[0] = 5;
    b.writeUInt16BE(addr - (off === undefined ? 0 : off), 1);
    b.writeUInt16BE(on ? 0xff00 : 0x0000, 3);
    return b;
}
function writeCoilsPdu(addr, bits, off) {
    const n = Math.ceil(bits.length / 8);
    const b = Buffer.alloc(6 + n);
    b[0] = 15;
    b.writeUInt16BE(addr - (off === undefined ? 0 : off), 1);
    b.writeUInt16BE(bits.length, 3);
    b[5] = n;
    bits.forEach((v, i) => { if (v) b[6 + (i >> 3)] |= 1 << (i & 7); });
    return b;
}
function writeRegPdu(addr, value, off) {
    const b = Buffer.alloc(5);
    b[0] = 6;
    b.writeUInt16BE(addr - (off === undefined ? 0 : off), 1);
    b.writeUInt16BE(value & 0xffff, 3);
    return b;
}
function writeRegsPdu(addr, values, off) {
    const b = Buffer.alloc(6 + values.length * 2);
    b[0] = 16;
    b.writeUInt16BE(addr - (off === undefined ? 0 : off), 1);
    b.writeUInt16BE(values.length, 3);
    b[5] = values.length * 2;
    values.forEach((v, i) => b.writeUInt16BE(v & 0xffff, 6 + i * 2));
    return b;
}
// Antwort von FC1-4 in ein Feld umwandeln (Bits 0/1 bzw. Worte 0..65535)
function parseRead(fc, res, count) {
    const n = res[1];
    if (res.length < 2 + n) throw netError("EBADFRAME", "short response");
    const out = [];
    if (fc === 1 || fc === 2) {
        if (n < Math.ceil(count / 8)) throw netError("EBADFRAME", "short response");
        for (let i = 0; i < count; i++) out.push((res[2 + (i >> 3)] >> (i & 7)) & 1);
    } else {
        if (n < count * 2) throw netError("EBADFRAME", "short response");
        for (let i = 0; i < count; i++) out.push(res.readUInt16BE(2 + i * 2));
    }
    return out;
}

// Bausteine mit fester Adressierung
function builders(off) {
    return {
        readPdu: (fc, addr, count) => readPdu(fc, addr, count, off),
        writeCoilPdu: (addr, on) => writeCoilPdu(addr, on, off),
        writeCoilsPdu: (addr, bits) => writeCoilsPdu(addr, bits, off),
        writeRegPdu: (addr, value) => writeRegPdu(addr, value, off),
        writeRegsPdu: (addr, values) => writeRegsPdu(addr, values, off),
    };
}

module.exports = {
    builders,
    ModbusTcpClient, EXCEPTIONS, readPdu, writeCoilPdu, writeCoilsPdu, writeRegPdu, writeRegsPdu, parseRead,
};
