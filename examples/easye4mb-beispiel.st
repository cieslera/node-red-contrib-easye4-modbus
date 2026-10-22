(* ======================================================================
   easyE4 Modbus-TCP Demo  -  ST-Programm zum Node-RED-Beispiel
   "easye4mb-beispiel" aus node-red-contrib-easye4-modbus

   Programmlogik wie im Beispiel von node-red-contrib-easye4-json
   (dort an einer easyE4 mit Firmware 1.44 geprueft).

   Funktion:
   - Q01 (z. B. Lampe) ist an, solange Taster I01 gedrueckt ist oder
     Node-RED M1 ("Fern-Ein") auf 1 setzt.
   - T01 (ansprechverzoegert, Zeitbereich S): Ist Q01 laenger als 5 s an,
     schaltet Q02 ("Meldung"). Die Istzeit steht in MD6 (ms).
   - C01 zaehlt, wie oft Q02 eingeschaltet hat (MD7).
     Erreicht der Zaehler den Grenzwert MW5 aus Node-RED, schaltet Q03.
     M2 aus Node-RED setzt den Zaehler auf 0 (Impuls).
   - MW3 zaehlt die Sekunden seit dem Start (Lebenszeichen), MB3 = Sekunde 0..59.
   - MW7 = MW6 * 2: Node-RED schreibt MW6 und liest das Ergebnis aus MW7.

   Einstellungen in easySoft 8, Ansicht Projekt, Register Modbus-Server:
   - "Modbus TCP Server aktiv" anhaken
   - Freigabe Merker: MW1 bis MW16 (enthaelt M1-M16, MB1-MB32, MD1-MD8)
   - "Freigabe E/As und Uhrendaten lesen" anhaken (fuer I, Q, IA, ID und Uhr)
   - "Merker, Net-Merker nur lesend" NICHT anhaken

   Parametersaetze in easySoft einstellen (in den Bezeichner klicken):
   - T01: Betriebsart "Ansprechverzoegert", Zeitbereich "S"
   - T02: Betriebsart "Blinkend", Zeitbereich "S"
   - C01: Standard

   Merkerbelegung ohne Ueberschneidung (in Klammern das Modbus-Register)
   (M1-M16 = MB1-MB2 = MW1, MB3-MB4 = MW2, MW3-MW10, MD6-MD8 = MW11-MW16)
   Operand  Name                 Node-RED
   M1       Fern_Ein             schreiben (1 = ein, 0 = aus)   (Coil 1001)
   M2       Zaehler_Reset        schreiben (1 = Impuls)         (Coil 1002)
   M4       Grenzwert_erreicht   lesen                          (Coil 1004)
   M5       Takt_1s              nur intern (T02)
   M6       Takt_vorher          nur intern (Flankenerkennung)
   M7       Zaehler_ueber_SH     nur intern (C01 OF)
   MB3      Sekunde              lesen (0 ... 59)               (Reg. 1002 Low)
   MB4      Testwert_Byte        schreiben/lesen                (Reg. 1002 High)
   MW3      Lebenszeichen        lesen (Sekunden seit Start)    (Reg. 1003)
   MW5      Grenzwert            schreiben (0 = aus)            (Reg. 1005)
   MW6      Testwert             schreiben                      (Reg. 1006)
   MW7      Testwert_mal_2       lesen (= MW6 * 2)              (Reg. 1007)
   MD6      T01_Istzeit          lesen (ms)                     (Reg. 1011+1012)
   MD7      Zaehlerstand         lesen                          (Reg. 1013+1014)
   MD8      Testwert_DWord       schreiben/lesen                (Reg. 1015+1016)
   I01      Taster_Ein           Taster am Geraet (Schliesser)  (Input 1)
   Q01      Lampe                Ausgang                        (Coil 1)
   Q02      Meldung_Dauer        Ausgang (Q01 laenger als 5 s)  (Coil 2)
   Q03      Meldung_Grenzwert    Ausgang (Zaehler >= MW5)       (Coil 3)
   ====================================================================== *)

// ---- 1. Lampe: Taster I01 oder Fern-Ein aus Node-RED ----
Q01 := I01 OR M1;

// ---- 2. Zeitrelais T01: Meldung, wenn Q01 laenger als die Sollzeit an ist ----
// I1 = Timerkonstante (5 s). Node-RED liest die Istzeit ueber MD6.
T01 (
    EN := Q01,
    RE := ,
    ST := ,
    I1 := T#5s_0ms,
    I2 := ,
    Q1 => Q02,
    QV => MD6
);

// ---- 3. Zaehler C01: zaehlt die Meldungen Q02, Grenzwert MW5 aus Node-RED ----
C01 (
    EN := ,
    C_ := Q02,
    D_ := ,
    SE := ,
    RE := M2,
    SH := MW5,
    SL := ,
    SV := ,
    OF => M7,
    FB => ,
    CY => ,
    ZE => ,
    QV => MD7
);
M4 := M7 AND (MW5 > 0);         // Grenzwert 0 = Ueberwachung aus
Q03 := M4;

// ---- 4. Lebenszeichen: Sekundentakt aus T02 (blinkend 0,5 s an / 0,5 s aus) ----
T02 (
    EN := TRUE,
    RE := ,
    ST := ,
    I1 := T#500ms,
    I2 := T#500ms,
    Q1 => M5,
    QV =>
);
IF M5 = TRUE AND M6 = FALSE THEN
    IF MW3 >= 65535 THEN
        MW3 := 0;               // Ueberlauf vermeiden (MW ist ohne Vorzeichen)
    ELSE
        MW3 := MW3 + 1;
    END_IF;
END_IF;
M6 := M5;                       // fuer die Flankenerkennung im naechsten Zyklus
MB3 := MW3 MOD 60;              // Sekunde 0 ... 59

// ---- 5. Rechenbeispiel: Node-RED schreibt MW6, liest MW7 ----
IF MW6 > 32767 THEN
    MW7 := 65535;               // MW7 kann hoechstens 65535 aufnehmen
ELSE
    MW7 := MW6 * 2;
END_IF;

// ---- 6. Impuls-Befehle aus Node-RED zuruecksetzen ----
M2 := FALSE;
