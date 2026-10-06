// Pantalla "En vivo": video + estado del sistema + botón "Fuera de casa"
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Alert } from 'react-native';
import { C } from '../theme';
import { request } from '../api';
import { Card, Btn, Dot } from '../components/UI';
import MjpegViewer from '../components/MjpegViewer';

// Si el backend dice "localhost", el celular no lo entiende: usamos la IP del PC
function fixHost(streamUrl, base) {
  try {
    const host = base.match(/^https?:\/\/([^/:]+)/)[1];
    return streamUrl.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)/, `$1${host}`);
  } catch { return streamUrl; }
}

const fmt = (sec) => (sec ? new Date(sec * 1000).toLocaleString('es-CO') : 'Ninguno todavía');

export default function LiveScreen({ base }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [videoKey, setVideoKey] = useState(0);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const s = await request(base, '/status');
      if (alive.current) { setStatus(s); setError(null); }
    } catch (e) {
      if (alive.current) setError(e.message);
    }
  }, [base]);

  // Consulta el estado cada 2 segundos mientras la pantalla esté abierta
  useEffect(() => {
    alive.current = true;
    load();
    const id = setInterval(load, 2000);
    return () => { alive.current = false; clearInterval(id); };
  }, [load]);

  const toggleArm = async () => {
    setBusy(true);
    try {
      await request(base, status.manualArmed ? '/disarm' : '/arm', 'POST');
      await load();
    } catch (e) {
      Alert.alert('No se pudo cambiar el modo', e.message);
    } finally { setBusy(false); }
  };

  const serverOk = !error && status;
  const camOk = serverOk && status.espOnline;

  let reason = 'Desactivado';
  if (status) {
    if (status.manualArmed) reason = 'Modo "Fuera de casa" activado';
    else if (status.inSchedule) reason = 'Activo por franja horaria';
    else if (status.scheduleEnabled) reason = 'Fuera de franja horaria';
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      {/* ---- Video ---- */}
      <View style={s.video}>
        {camOk ? (
          <MjpegViewer key={videoKey} url={fixHost(status.streamUrl, base)} />
        ) : (
          <View style={s.center}>
            <Text style={s.bigMsg}>{serverOk ? 'Cámara desconectada' : 'Sin conexión con el servidor'}</Text>
            <Text style={s.small}>Reconectando automáticamente…</Text>
          </View>
        )}
      </View>

      {/* ---- Conexiones ---- */}
      <View style={s.row}>
        <View style={s.chip}><Dot color={serverOk ? C.ok : C.bad} /><Text style={s.chipT}>Servidor</Text></View>
        <View style={s.chip}><Dot color={camOk ? C.ok : C.bad} /><Text style={s.chipT}>Cámara</Text></View>
        <View style={s.chip}><Dot color={status?.motion ? C.warn : C.muted} /><Text style={s.chipT}>{status?.motion ? 'Movimiento' : 'Sin movimiento'}</Text></View>
      </View>

      {error && <Card><Text style={{ color: C.bad }}>⚠ {error}. Revisa la dirección del servidor en Ajustes.</Text></Card>}

      {/* ---- Estado de armado ---- */}
      {status && (
        <Card style={{ borderColor: status.armed ? C.ok : C.border }}>
          <Text style={[s.state, { color: status.armed ? C.ok : C.muted }]}>
            {status.armed ? '🛡 SISTEMA ARMADO' : '○ SISTEMA DESARMADO'}
          </Text>
          <Text style={s.small}>{reason}</Text>
          <Btn
            style={{ marginTop: 14 }}
            kind={status.manualArmed ? 'danger' : 'ok'}
            disabled={busy}
            title={status.manualArmed ? 'Desactivar "Fuera de casa"' : 'Activar "Fuera de casa"'}
            onPress={toggleArm}
          />
        </Card>
      )}

      {/* ---- Último evento ---- */}
      {status && (
        <Card>
          <Text style={s.label}>Último movimiento con alerta</Text>
          <Text style={s.value}>{fmt(status.lastEvent)}</Text>
          <Text style={[s.label, { marginTop: 10 }]}>Correos enviados</Text>
          <Text style={s.value}>
            {status.emailsSent}
            {status.lastEmailOk === false ? '   (último intento falló)' : ''}
          </Text>
          {status.lastError ? <Text style={{ color: C.bad, marginTop: 6, fontSize: 12 }}>{status.lastError}</Text> : null}
        </Card>
      )}

      <Btn kind="ghost" title="Reconectar video" onPress={() => setVideoKey((k) => k + 1)} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  video: { aspectRatio: 4 / 3, backgroundColor: '#000', borderRadius: 14, overflow: 'hidden', marginBottom: 12, borderWidth: 1, borderColor: C.border },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  bigMsg: { color: C.text, fontSize: 18, fontWeight: '700', marginBottom: 6 },
  small: { color: C.muted, fontSize: 13 },
  row: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12 },
  chip: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8, marginBottom: 6, borderWidth: 1, borderColor: C.border },
  chipT: { color: C.text, fontSize: 13 },
  state: { fontSize: 22, fontWeight: '800', marginBottom: 4 },
  label: { color: C.muted, fontSize: 13 },
  value: { color: C.text, fontSize: 17, fontWeight: '600' },
});
