// Pantalla "Horarios": franjas de vigilancia automática
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Switch, StyleSheet, Alert } from 'react-native';
import { C } from '../theme';
import { request } from '../api';
import { Card, H, Btn } from '../components/UI';

const DAYS = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];   // índice 0 = domingo
const pad = (n) => String(n).padStart(2, '0');

// Cambia horas (±1) o minutos (±15) de un "HH:MM"
function shift(t, deltaMin) {
  const [h, m] = t.split(':').map(Number);
  const x = (((h * 60 + m + deltaMin) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(x / 60))}:${pad(x % 60)}`;
}

function TimeStepper({ label, value, onChange }) {
  const [h, m] = value.split(':');
  const Step = ({ t, d }) => (
    <TouchableOpacity style={s.step} onPress={() => onChange(shift(value, d))}>
      <Text style={s.stepT}>{t}</Text>
    </TouchableOpacity>
  );
  return (
    <View style={{ flex: 1 }}>
      <Text style={s.label}>{label}</Text>
      <View style={s.timeRow}>
        <Step t="−" d={-60} /><Text style={s.time}>{h}</Text><Step t="+" d={60} />
        <Text style={s.time}>:</Text>
        <Step t="−" d={-15} /><Text style={s.time}>{m}</Text><Step t="+" d={15} />
      </View>
    </View>
  );
}

export default function ScheduleScreen({ base }) {
  const [enabled, setEnabled] = useState(false);
  const [slots, setSlots] = useState([]);
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!base) { setMsg('Primero configura la dirección del servidor en Ajustes.'); return; }
    (async () => {
      try {
        const d = await request(base, '/schedule');
        setEnabled(!!d.enabled);
        setSlots(d.slots || []);
        setMsg('');
      } catch (e) { setMsg('No se pudo cargar: ' + e.message); }
    })();
  }, [base]);

  const upd = (i, patch) => setSlots((a) => a.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const toggleDay = (i, d) => setSlots((a) => a.map((x, k) => k !== i ? x : {
    ...x, days: x.days.includes(d) ? x.days.filter((y) => y !== d) : [...x.days, d].sort(),
  }));
  const add = () => slots.length < 8 && setSlots((a) => [...a, { days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00' }]);
  const del = (i) => setSlots((a) => a.filter((_, k) => k !== i));

  const save = async () => {
    if (slots.some((x) => x.days.length === 0)) {
      Alert.alert('Falta un día', 'Cada franja debe tener al menos un día marcado.');
      return;
    }
    setSaving(true);
    try {
      await request(base, '/schedule', 'POST', { enabled, slots });
      setMsg('✔ Horario guardado en el servidor');
    } catch (e) { setMsg('✖ No se guardó: ' + e.message); }
    finally { setSaving(false); }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <H>Franjas de vigilancia</H>

      <Card>
        <View style={s.rowBetween}>
          <View style={{ flex: 1, paddingRight: 10 }}>
            <Text style={s.value}>Armar automáticamente</Text>
            <Text style={s.label}>El sistema se activa solo dentro de las franjas.</Text>
          </View>
          <Switch value={enabled} onValueChange={setEnabled} trackColor={{ true: C.ok }} />
        </View>
      </Card>

      {slots.map((sl, i) => (
        <Card key={i}>
          <View style={s.rowBetween}>
            <Text style={s.value}>Franja {i + 1}</Text>
            <TouchableOpacity onPress={() => del(i)}><Text style={{ color: C.bad, fontWeight: '700' }}>Eliminar</Text></TouchableOpacity>
          </View>
          <View style={s.days}>
            {DAYS.map((d, k) => {
              const on = sl.days.includes(k);
              return (
                <TouchableOpacity key={k} onPress={() => toggleDay(i, k)} style={[s.day, on && { backgroundColor: C.accent, borderColor: C.accent }]}>
                  <Text style={{ color: on ? '#fff' : C.muted, fontWeight: '700' }}>{d}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <TimeStepper label="Desde" value={sl.start} onChange={(v) => upd(i, { start: v })} />
          </View>
          <View style={{ height: 10 }} />
          <TimeStepper label="Hasta" value={sl.end} onChange={(v) => upd(i, { end: v })} />
          {sl.start > sl.end && <Text style={[s.label, { marginTop: 8 }]}>🌙 Cruza la medianoche: termina al día siguiente.</Text>}
        </Card>
      ))}

      <Btn kind="ghost" title="+ Agregar franja" onPress={add} style={{ marginBottom: 12 }} />
      <Btn title={saving ? 'Guardando…' : 'Guardar horario'} onPress={save} disabled={saving || !base} />
      {msg ? <Text style={{ color: msg.startsWith('✔') ? C.ok : C.warn, marginTop: 12 }}>{msg}</Text> : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  value: { color: C.text, fontSize: 16, fontWeight: '600' },
  label: { color: C.muted, fontSize: 13, marginBottom: 4 },
  days: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 12 },
  day: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  timeRow: { flexDirection: 'row', alignItems: 'center' },
  time: { color: C.text, fontSize: 22, fontWeight: '700', minWidth: 34, textAlign: 'center' },
  step: { width: 34, height: 34, borderRadius: 8, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  stepT: { color: C.text, fontSize: 20, fontWeight: '700' },
});
