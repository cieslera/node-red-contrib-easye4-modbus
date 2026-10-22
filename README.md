# node-red-contrib-easye4-modbus

**[English](#english) | [Deutsch](#deutsch)**

Node-RED nodes for the **Eaton easyE4** via **Modbus TCP** (the easyE4 is the Modbus TCP server).
Read inputs, outputs, markers, NET markers, analog values, diagnostic bits and the clock; write markers and the clock.
No extra dependencies. Operands are entered as in easySoft (`MW3`, `Q1`, `IA2` …) – the register numbers are
looked up automatically from Eaton's "Modbus TCP Map".
Also available: [node-red-contrib-easye4-mqtt](https://flows.nodered.org/node/node-red-contrib-easye4-mqtt) (MQTT, firmware 2.40+)
and [node-red-contrib-easye4-json](https://flows.nodered.org/node/node-red-contrib-easye4-json) (JSON API of the web server).
All three packages can be installed side by side.

Node-RED-Knoten für die **Eaton easyE4** über **Modbus TCP** (die easyE4 ist Modbus-TCP-Server).
Eingänge, Ausgänge, Merker, NET-Merker, Analogwerte, Diagnosebits und die Uhr lesen; Merker und Uhr schreiben.
Ohne zusätzliche Abhängigkeiten. Operanden werden wie in easySoft eingegeben (`MW3`, `Q1`, `IA2` …) – die
Register-Nummern sucht das Paket selbst aus Eatons „Modbus TCP Map“ heraus.
Außerdem gibt es [node-red-contrib-easye4-mqtt](https://flows.nodered.org/node/node-red-contrib-easye4-mqtt) (MQTT, Firmware ab 2.40)
und [node-red-contrib-easye4-json](https://flows.nodered.org/node/node-red-contrib-easye4-json) (JSON-API des Webservers).
Alle drei Pakete können gleichzeitig installiert sein.

> **⚠ Use at your own risk / Benutzung auf eigene Gefahr**
>
> This software controls real machines (writing operands, setting the clock).
> It is provided "as is" under the MIT license, **without any warranty and without any liability** for damage
> to persons, machines, installations or data. Never let safety functions depend on it.
> Unofficial project, not affiliated with or endorsed by Eaton.
>
> Diese Software steuert reale Maschinen (Operanden schreiben, Uhr stellen).
> Sie wird unter der MIT-Lizenz „wie besehen“ bereitgestellt, **ohne Gewährleistung und ohne jegliche Haftung**
> für Schäden an Personen, Maschinen, Anlagen oder Daten. Sicherheitsfunktionen dürfen nie davon abhängen.
> Inoffizielles Projekt, nicht von Eaton.

---

## English

The editor dialogs, help texts and messages are available in English and German.

| Node | Purpose |
|---|---|
| **easyE4 Modbus** (config) | Controller: address, port, unit ID, firmware, with *Test connection* button |
| **easyE4 Modbus read** | Read an operand, a range, a mixed list, the clock or free registers – polled every *x* seconds and/or on input |
| **easyE4 Modbus write** | Write M, MB, MW, MD, N, NB, NW, ND, the clock or free registers (FC5/FC6/FC16) |

### Installation

In Node-RED: *Menu → Manage palette → Install*, search for `node-red-contrib-easye4-modbus`, click *Install*.
Or: `cd ~/.node-red && npm install node-red-contrib-easye4-modbus && node-red-restart`.
An example flow is available under *Menu → Import → Examples*; the matching easyE4 program in Structured Text is
`examples/easye4mb-beispiel.st` in the package folder.

### Setup in easySoft 8

*Project view → Modbus server tab*: tick **Modbus TCP server active**, enable the marker range (marker words, e.g.
MW1–MW16; bits, bytes and double words belong to these words) and, for inputs/outputs, analog values and the clock,
**Enable read I/O and clock data**. Transfer the program. Port 502 (adjustable with firmware 2.30+).

### Operands and registers

| Operand | Read | Write | Register (1-based, as in Eaton's table) |
|---|---|---|---|
| I1–I128 | FC2 | – | 1… |
| Q1–Q128 | FC1 | – | 1… |
| ID1–ID96 | FC2 | – | 3001… |
| M1–M512 (–M1024 FW 2.40+) | FC1 | FC5 | 1001… (56513…) |
| N1–N512 (own device) | FC1 | FC5 | 2001… |
| MW1–MW512 (–MW1022 FW 2.40+) | FC3 | FC6 | 1001… (46513…) |
| MB / MD | FC3 | FC3+FC6 / FC16 | via marker words (MB1/MB2 = MW1, MD1 = MW1+MW2) |
| NW1–NW32, NB1–NB64, ND1–ND16 | FC3 | FC6 / FC16 | 2001… |
| IA / QA | FC4 / FC3 | – | 32 bit: 42001… / 40001… (FW 2.40+), 6501… / 6001… (FW 1.40+); 16 bit: 1… |
| Clock | FC3 | FC16 | 5000–5005 (s, min, h, day, month, year) |

32-bit values: low word first (as specified by Eaton). MD, ND and analog values are signed, MW and MB unsigned.
The register numbers are sent to the easyE4 **directly** (MW1 = address 1001), not "minus 1" as Eaton's documentation
states – checked on a real device. The other variant can be selected in the config node (*Addressing*); *Test
connection* detects a wrong setting.

### Good to know

- The easyE4 serves at most two Modbus TCP clients. All config entries with the same address share **one**
  connection; only one request at a time, a configurable pause between requests (default 20 ms), growing pauses
  while the controller is not reachable, and fast write bursts to the same operand are merged (newest value wins).
- Lists are read with as few requests as possible. If single values are not enabled in easySoft, the others are still
  output and `msg.errors` names the missing ones.
- Writing MB, or a bit when the easyE4 rejects FC5, is done via its marker word (read, change, write).
- Modbus cannot switch RUN/STOP and cannot access function block parameters – use the MQTT or JSON package for that.

### Bugs and questions

Please report bugs on [GitHub Issues](https://github.com/cieslera/node-red-contrib-easye4-modbus/issues).

---

## Deutsch

Editor, Hilfetexte und Meldungen gibt es auf Deutsch und Englisch.

| Knoten | Aufgabe |
|---|---|
| **easyE4 Modbus** (Konfiguration) | Steuerung: Adresse, Port, Unit-ID, Firmware, mit Schaltfläche *Verbindung testen* |
| **easyE4 Modbus lesen** | Einen Operanden, einen Bereich, eine gemischte Liste, die Uhr oder freie Register lesen – alle *x* Sekunden und/oder bei eingehender Nachricht |
| **easyE4 Modbus schreiben** | M, MB, MW, MD, N, NB, NW, ND, die Uhr oder freie Register (FC5/FC6/FC16) schreiben |

### Installation

In Node-RED: *Menü → Palette verwalten → Installation*, nach `node-red-contrib-easye4-modbus` suchen, *Installieren*.
Oder: `cd ~/.node-red && npm install node-red-contrib-easye4-modbus && node-red-restart`.
Ein Beispiel-Flow liegt unter *Menü → Import → Beispiele*; das passende easyE4-Programm in ST ist
`examples/easye4mb-beispiel.st` im Paketordner.

### Einstellungen in easySoft 8

*Ansicht Projekt → Register Modbus-Server*: **Modbus TCP Server aktiv** anhaken, den Merkerbereich freigeben
(Merkerworte, z. B. MW1–MW16; Bits, Bytes und Doppelworte gehören zu diesen Worten) und für Ein-/Ausgänge,
Analogwerte und Uhr **Freigabe E/As und Uhrendaten lesen** anhaken. Programm übertragen. Port 502 (ab Firmware 2.30 einstellbar).

### Operanden und Register

| Operand | Lesen | Schreiben | Register (1-basiert, wie in der Eaton-Tabelle) |
|---|---|---|---|
| I1–I128 | FC2 | – | 1… |
| Q1–Q128 | FC1 | – | 1… |
| ID1–ID96 | FC2 | – | 3001… |
| M1–M512 (–M1024 ab FW 2.40) | FC1 | FC5 | 1001… (56513…) |
| N1–N512 (eigenes Gerät) | FC1 | FC5 | 2001… |
| MW1–MW512 (–MW1022 ab FW 2.40) | FC3 | FC6 | 1001… (46513…) |
| MB / MD | FC3 | FC3+FC6 / FC16 | über die Merkerworte (MB1/MB2 = MW1, MD1 = MW1+MW2) |
| NW1–NW32, NB1–NB64, ND1–ND16 | FC3 | FC6 / FC16 | 2001… |
| IA / QA | FC4 / FC3 | – | 32 Bit: 42001… / 40001… (ab FW 2.40), 6501… / 6001… (ab FW 1.40); 16 Bit: 1… |
| Uhr | FC3 | FC16 | 5000–5005 (s, min, h, Tag, Monat, Jahr) |

32-Bit-Werte: niederwertiges Wort zuerst (so legt es Eaton fest). MD, ND und Analogwerte mit Vorzeichen, MW und MB ohne.
Die Register-Nummern gehen **direkt** an die easyE4 (MW1 = Adresse 1001), nicht „minus 1“, wie es in der Eaton-Doku
steht – an einem echten Gerät geprüft. Die andere Variante ist im Konfigurationsknoten wählbar (*Adressierung*);
*Verbindung testen* erkennt eine falsche Einstellung.

### Gut zu wissen

- Die easyE4 bedient höchstens zwei Modbus-TCP-Clients. Alle Einträge mit derselben Adresse teilen sich **eine**
  Verbindung; immer nur eine Anfrage gleichzeitig, einstellbare Pause zwischen Anfragen (Standard 20 ms), wachsende
  Pausen, solange die Steuerung nicht erreichbar ist, und schnell aufeinanderfolgende Schreibbefehle auf denselben
  Operanden werden zusammengefasst (neuester Wert gewinnt).
- Listen werden mit möglichst wenigen Anfragen gelesen. Sind einzelne Werte in easySoft nicht freigegeben, kommen die
  übrigen trotzdem, und `msg.errors` nennt die fehlenden.
- MB – und ein Bit, falls die easyE4 FC5 ablehnt – wird über das zugehörige Merkerwort geschrieben (lesen, ändern, schreiben).
- RUN/STOP und Parameter von Funktionsbausteinen gibt es über Modbus nicht – dafür das MQTT- oder JSON-Paket verwenden.

### Fehler und Fragen

Bitte über [GitHub Issues](https://github.com/cieslera/node-red-contrib-easye4-modbus/issues) melden.

## License / Lizenz

MIT – see / siehe [LICENSE](LICENSE). Source of the register map: Eaton online documentation easyE4 (v900),
"Modbus TCP Map" and "easyE4 als Modbus TCP Server".
