"use strict";
// Operanden der easyE4 <-> Modbus-Register (ohne Node-RED-Abhängigkeit, damit einzeln testbar).
// Quelle: Eaton Online-Dokumentation easyE4 (v900), "Modbus TCP Map" und "easyE4 als Modbus TCP Server".
//
// Register-Nummern wie in der Eaton-Tabelle. Die easyE4 erwartet sie im Telegramm direkt (MW1 = 1001, am Gerät
// gemessen 22.10.2026); die Eaton-Doku nennt "Nummer - 1" – das ist im Gerätedialog als Adressierung wählbar.
// Worte werden Big-Endian übertragen; 32-Bit-Werte liegen in zwei Registern, das niederwertige zuerst.
// Merker überschneiden sich: MW1 = MB1 (niederwertig) + MB2, MD1 = MW1 (niederwertig) + MW2, M1..M16 = Bits von MW1.

// Firmware-Stufen, die die nutzbaren Register bestimmen
const FW = { OLD: 0, V140: 140, V240: 240 };
function fwLevel(v) {
    const s = String(v === undefined || v === null ? "" : v).trim();
    if (s === "old" || s === "0") return FW.OLD;
    if (s === "1.40" || s === "140") return FW.V140;
    return FW.V240; // Standard: aktuelle Geräte
}

// Operanden. reg: Register, bit: Coil/Discrete Input, via: aus Merker-/NET-Worten abgeleitet
const OPS = {
    I: { cls: "bit", fc: 2, max: 128, write: false },
    Q: { cls: "bit", fc: 1, max: 128, write: false },
    ID: { cls: "bit", fc: 2, max: 96, write: false },
    M: { cls: "bit", fc: 1, max: 1024, write: true },
    N: { cls: "bit", fc: 1, max: 512, write: true },
    IA: { cls: "analog", fc: 4, max: 512, write: false },
    QA: { cls: "analog", fc: 3, max: 128, write: false },
    MB: { cls: "byte", fc: 3, max: 2044, write: true },
    MW: { cls: "word", fc: 3, max: 1022, write: true },
    MD: { cls: "dword", fc: 3, max: 511, write: true },
    NB: { cls: "byte", fc: 3, max: 64, write: true },
    NW: { cls: "word", fc: 3, max: 32, write: true },
    ND: { cls: "dword", fc: 3, max: 16, write: true },
};
const ALIASES = { AI: "IA", AO: "QA", O: "Q" };
const OP_RE = /^(IA|QA|AI|AO|ID|MB|MW|MD|NB|NW|ND|I|Q|O|M|N)$/;

function fail(key, args) {
    const e = new Error(key);
    e.e4 = { key, args: args || {} };
    return e;
}

function normType(t) {
    const u = String(t || "").trim().toUpperCase();
    return ALIASES[u] || u;
}

// Höchster Index je nach Firmware
function maxIndex(type, fw) {
    const def = OPS[type];
    if (!def) return 0;
    switch (type) {
        case "M": return fw >= FW.V240 ? 1024 : 512;
        case "MB": return fw >= FW.V240 ? 2044 : 1024;
        case "MW": return fw >= FW.V240 ? 1022 : 512;
        case "MD": return fw >= FW.V240 ? 511 : 256;
        case "IA": return fw >= FW.V240 ? 512 : 48;
        case "QA": return fw >= FW.V240 ? 128 : 48;
        default: return def.max;
    }
}

function checkIndex(type, n, fw) {
    const max = maxIndex(type, fw);
    if (!Number.isInteger(n) || n < 1 || n > max) {
        throw fail(max < OPS[type].max ? "indexRangeFw" : "indexRange", { what: type, max });
    }
}

// Register eines Merker-/NET-Wortes (1-basiert). Liefert { fc, addr, area }
function wordReg(type, n) {
    if (type === "MW") return n <= 512 ? { fc: 3, addr: 1000 + n, area: "MW" } : { fc: 3, addr: 46000 + n, area: "MW2" };
    return { fc: 3, addr: 2000 + n, area: "NW" }; // NW
}

// Lese-Plan für einen einzelnen Operanden: welche Register/Bits und wie daraus der Wert entsteht.
// Ergebnis: { key, type, index, parts: [{fc, addr, area}], decode(values[]) }
function operand(type, index, fw) {
    type = normType(type);
    const def = OPS[type];
    if (!def) throw fail("unknownType", { type });
    checkIndex(type, index, fw);
    const key = type + index;
    const one = (fc, addr, area, decode) => ({ key, type, index, parts: [{ fc, addr, area }], decode: decode || ((v) => v[0]) });
    switch (type) {
        case "I": return one(2, index, "I");
        case "Q": return one(1, index, "Q");
        case "ID": return one(2, 3000 + index, "ID");
        case "M": return index <= 512 ? one(1, 1000 + index, "M") : one(1, 56000 + index, "M2");
        case "N": return one(1, 2000 + index, "N");
        case "MW": case "NW": {
            const r = wordReg(type, index);
            return one(r.fc, r.addr, r.area);
        }
        case "MB": case "NB": {
            const w = wordReg(type === "MB" ? "MW" : "NW", Math.ceil(index / 2));
            const hi = index % 2 === 0;
            return one(w.fc, w.addr, w.area, (v) => (hi ? v[0] >> 8 : v[0] & 0xff));
        }
        case "MD": case "ND": {
            const wt = type === "MD" ? "MW" : "NW";
            const lo = wordReg(wt, 2 * index - 1);
            const hi = wordReg(wt, 2 * index);
            return {
                key, type, index,
                parts: [lo, hi],
                decode: (v) => ((v[1] << 16) | v[0]) | 0, // vorzeichenbehaftet, wie in easySoft
            };
        }
        case "IA": case "QA": {
            const fc = type === "IA" ? 4 : 3;
            if (fw >= FW.V240) {
                const base = type === "IA" ? 42000 : 40000;
                return {
                    key, type, index,
                    parts: [{ fc, addr: base + 2 * index - 1, area: type + "32" }, { fc, addr: base + 2 * index, area: type + "32" }],
                    decode: (v) => ((v[1] << 16) | v[0]) | 0,
                };
            }
            if (fw >= FW.V140) {
                const base = type === "IA" ? 6500 : 6000;
                return {
                    key, type, index,
                    parts: [{ fc, addr: base + 2 * index - 1, area: type + "32" }, { fc, addr: base + 2 * index, area: type + "32" }],
                    decode: (v) => ((v[1] << 16) | v[0]) | 0,
                };
            }
            return one(fc, index, type, (v) => (v[0] << 16) >> 16); // 16 Bit mit Vorzeichen
        }
    }
    throw fail("unknownType", { type });
}

// Uhr der easyE4 (Register 5000..5005: Sekunde, Minute, Stunde, Tag, Monat, Jahr)
function clock() {
    const parts = [];
    for (let a = 5000; a <= 5005; a++) parts.push({ fc: 3, addr: a, area: "RTC" });
    return {
        key: "CLOCK", type: "CLOCK", index: 0, parts,
        decode: (v) => {
            const year = v[5] < 100 ? 2000 + v[5] : v[5];
            return { year, month: v[4], day: v[3], hour: v[2], minute: v[1], second: v[0] };
        },
    };
}

// Bereich, z. B. MW1..MW8 -> mehrere Einzeloperanden
function range(type, start, end, fw) {
    type = normType(type);
    if (!OPS[type]) throw fail("unknownType", { type });
    checkIndex(type, start, fw);
    checkIndex(type, end, fw);
    if (end < start) throw fail("rangeOrder", {});
    if (end - start >= 2048) throw fail("rangeTooLong", { max: 2048 });
    const out = [];
    for (let i = start; i <= end; i++) out.push(operand(type, i, fw));
    return out;
}

// Text wie "MW3", "Q1", "AI2", "MW1-MW8", "MW1..8", "M1-16", "CLOCK" in Operanden umwandeln
function parseOne(text, fw) {
    const s = String(text).trim().toUpperCase().replace(/\s+/g, "");
    if (!s) return [];
    if (s === "CLOCK" || s === "UHR" || s === "RTC") return [clock()];
    let m = /^([A-Z]+)(\d+)(?:(?:-|\.\.)([A-Z]*)(\d+))?$/.exec(s);
    if (!m || !OP_RE.test(m[1]) || (m[3] && normType(m[3]) !== normType(m[1]))) throw fail("badOperand", { text: String(text).trim() });
    const start = parseInt(m[2], 10);
    if (m[4] === undefined) return [operand(m[1], start, fw)];
    return range(m[1], start, parseInt(m[4], 10), fw);
}

// Liste: Komma, Semikolon, Zeilenumbruch oder "+" als Trenner; auch ein Feld von Texten
function parseList(src, fw) {
    const items = Array.isArray(src) ? src : String(src || "").split(/[,;\n+]/);
    const out = [];
    const seen = new Set();
    for (const t of items) {
        for (const op of parseOne(t, fw)) {
            if (seen.has(op.key)) continue;
            seen.add(op.key);
            out.push(op);
        }
    }
    if (out.length === 0) throw fail("noOperands", {});
    return out;
}

// ------------------------------------------------------------------------------------------------ Lese-Planung
// Fasst die Register aller Operanden zu möglichst wenigen Anfragen zusammen.
// Nur innerhalb desselben Bereichs (area) und mit kleinen Lücken, weil die easyE4 eine ganze Anfrage
// ablehnt, sobald eine einzige Adresse darin nicht freigegeben ist.
const LIMIT = { bit: 512, reg: 125 };
const MAX_GAP = { bit: 16, reg: 4 };

function planReads(ops, opts) {
    const gapBit = opts && opts.noGaps ? 0 : MAX_GAP.bit;
    const gapReg = opts && opts.noGaps ? 0 : MAX_GAP.reg;
    const byArea = new Map();
    for (const op of ops) {
        for (const p of op.parts) {
            const k = p.fc + "|" + p.area;
            if (!byArea.has(k)) byArea.set(k, { fc: p.fc, area: p.area, addrs: new Set() });
            byArea.get(k).addrs.add(p.addr);
        }
    }
    const reqs = [];
    for (const a of byArea.values()) {
        const isBit = a.fc === 1 || a.fc === 2;
        const limit = isBit ? LIMIT.bit : LIMIT.reg;
        const gap = isBit ? gapBit : gapReg;
        const list = [...a.addrs].sort((x, y) => x - y);
        let cur = null;
        for (const addr of list) {
            if (cur && addr - (cur.addr + cur.count - 1) - 1 <= gap && addr - cur.addr + 1 <= limit) {
                cur.count = addr - cur.addr + 1;
            } else {
                cur = { fc: a.fc, area: a.area, addr, count: 1 };
                reqs.push(cur);
            }
        }
    }
    return reqs;
}

// Werte aus den Antworten den Operanden zuordnen. data: Map "fc|addr" -> Wert
function decodeAll(ops, data) {
    const values = {};
    const missing = [];
    for (const op of ops) {
        const raw = op.parts.map((p) => data.get(p.fc + "|" + p.addr));
        if (raw.some((v) => v === undefined)) {
            missing.push(op.key);
            continue;
        }
        values[op.key] = op.decode(raw);
    }
    return { values, missing };
}

// ------------------------------------------------------------------------------------------------ Schreiben

function toBool(v) {
    if (typeof v === "boolean") return v;
    if (typeof v === "number" && (v === 0 || v === 1)) return v === 1;
    const s = String(v).trim().toLowerCase();
    if (["1", "true", "on", "ein", "an", "yes", "ja"].includes(s)) return true;
    if (["0", "false", "off", "aus", "no", "nein"].includes(s)) return false;
    throw fail("badBool", { value: String(v) });
}
function toInt(v, min, max, what) {
    if (typeof v === "boolean") v = v ? 1 : 0;
    const n = typeof v === "number" ? v : Number(String(v).trim().replace(",", "."));
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
        throw fail("badNumber", { value: String(v), what, min, max });
    }
    return n;
}

// Schreib-Plan für einen Operanden. Ergebnis:
// { key, kind: "coil"|"reg"|"regs"|"byte", addr, value(s), wordAddr, bit }
function writePlan(type, index, value, fw) {
    type = normType(type);
    const def = OPS[type];
    if (!def) throw fail("unknownType", { type });
    if (!def.write) throw fail("notWritable", { type });
    checkIndex(type, index, fw);
    const key = type + index;
    switch (type) {
        case "M": case "N": {
            const on = toBool(value);
            const addr = type === "N" ? 2000 + index : index <= 512 ? 1000 + index : 56000 + index;
            // Ersatzweg über das Wort, falls die easyE4 FC5 ablehnt: M1..M16 = MW1 Bit 0..15
            const w = wordReg(type === "M" ? "MW" : "NW", Math.ceil(index / 16));
            return { key, kind: "coil", addr, value: on, wordAddr: w.addr, bit: (index - 1) % 16 };
        }
        case "MW": case "NW": {
            let n = toInt(value, -32768, 65535, key);
            if (n < 0) n += 65536;
            return { key, kind: "reg", addr: wordReg(type, index).addr, value: n };
        }
        case "MB": case "NB": {
            let n = toInt(value, -128, 255, key);
            if (n < 0) n += 256;
            const w = wordReg(type === "MB" ? "MW" : "NW", Math.ceil(index / 2));
            return { key, kind: "byte", addr: w.addr, value: n, high: index % 2 === 0 };
        }
        case "MD": case "ND": {
            const n = toInt(value, -2147483648, 4294967295, key) >>> 0;
            const w = wordReg(type === "MD" ? "MW" : "NW", 2 * index - 1);
            return { key, kind: "regs", addr: w.addr, values: [n & 0xffff, n >>> 16] };
        }
    }
    throw fail("notWritable", { type });
}

// Schlüssel wie "MW3" in Typ und Nummer zerlegen
function parseKey(k) {
    const m = /^([A-Za-z]+)(\d+)$/.exec(String(k).trim());
    if (!m || !OP_RE.test(m[1].toUpperCase())) throw fail("badOperand", { text: String(k) });
    return { type: normType(m[1]), index: parseInt(m[2], 10) };
}

// Datum für die Uhr: Date, Zeitstempel (ms), ISO-Text, "now"/leer, oder {year, month, day, hour, minute, second}
function toDate(v) {
    if (v === undefined || v === null || v === "" || v === true || String(v).toLowerCase() === "now") return new Date();
    if (v instanceof Date) {
        if (isNaN(v.getTime())) throw fail("badDate", { value: String(v) });
        return v;
    }
    if (typeof v === "object" && v.year !== undefined) {
        const d = new Date(+v.year, (+v.month || 1) - 1, +v.day || 1, +v.hour || 0, +v.minute || 0, +v.second || 0);
        if (isNaN(d.getTime())) throw fail("badDate", { value: JSON.stringify(v) });
        return d;
    }
    const d = new Date(typeof v === "number" ? v : String(v));
    if (isNaN(d.getTime())) throw fail("badDate", { value: String(v) });
    return d;
}
// Register 5000..5005; twoDigitYear: wenn die easyE4 das Jahr zweistellig liefert, auch so schreiben
function clockRegs(d, twoDigitYear) {
    const y = d.getFullYear();
    return [d.getSeconds(), d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, twoDigitYear ? y % 100 : y];
}

// Freier Zugriff: Funktionscode + Register-Nr. (1-basiert wie in der Eaton-Tabelle)
function rawRead(fc, addr, count) {
    fc = parseInt(fc, 10);
    addr = parseInt(addr, 10);
    count = parseInt(count, 10) || 1;
    if (![1, 2, 3, 4].includes(fc)) throw fail("badFc", { fc });
    const lim = fc <= 2 ? LIMIT.bit : LIMIT.reg;
    if (!Number.isInteger(addr) || addr < 1 || addr > 65536) throw fail("badAddr", {});
    if (count < 1 || count > lim || addr + count - 1 > 65536) throw fail("badCount", { max: lim });
    return { fc, addr, count };
}

module.exports = {
    FW, fwLevel, OPS, normType, maxIndex, operand, clock, range, parseOne, parseList, planReads, decodeAll,
    writePlan, parseKey, toBool, toInt, toDate, clockRegs, rawRead, LIMIT, fail,
};
