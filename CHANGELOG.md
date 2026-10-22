# Changelog

## 1.0.1

- First public version. Config node with *Test connection*, read node (operand, range, list, clock, free registers,
  from message) and write node (operand, clock, free registers, from message). Register map from Eaton's "Modbus TCP
  Map", selectable firmware level (2.40+, 1.40–2.3x, older). One shared connection and queue per controller, no extra
  dependencies. Register numbers are sent to the easyE4 directly (MW1 = address 1001) – the real device works this way,
  not "number − 1" as stated in Eaton's documentation; the other variant can be selected (*Addressing*), and *Test
  connection* detects a wrong setting. Tested on a real easyE4 (reading, writing M/MW/MB/MD, clock) and with an
  easyE4 simulator (30 automatic tests).
  / Erste öffentliche Version. Konfigurationsknoten mit *Verbindung testen*, Lese-Knoten (Operand, Bereich, Liste, Uhr,
  freie Register, aus der Nachricht) und Schreib-Knoten (Operand, Uhr, freie Register, aus der Nachricht).
  Registerbelegung laut Eatons „Modbus TCP Map“, Firmware-Stufe wählbar (ab 2.40, 1.40–2.3x, älter). Eine gemeinsame
  Verbindung und Warteschlange je Steuerung, keine zusätzlichen Abhängigkeiten. Register-Nummern gehen direkt an die
  easyE4 (MW1 = Adresse 1001) – so arbeitet das echte Gerät, nicht „Nummer − 1“ wie in der Eaton-Doku; die andere
  Variante ist wählbar (*Adressierung*), *Verbindung testen* erkennt eine falsche Einstellung. An einer echten easyE4
  getestet (Lesen, Schreiben von M/MW/MB/MD, Uhr) und mit einem easyE4-Simulator (30 automatische Tests).
