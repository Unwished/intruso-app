// Pantalla "Ajustes": dirección del servidor, cámara, correo y sensibilidad
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, Switch, Alert } from 'react-native';
import { C } from '../theme';
import { request, normalize, saveBaseUrl } from '../api';
import { Card, H, Btn, Field } from '../components/UI';

export default function SettingsScreen({ base, onBaseSaved }) {
  const [url, setUrl] = useState(base);
  const [espHost, setEspHost] = useState('');
  const [emailTo, setEmailTo] = useState('');
  const [cooldown, setCooldown] = useState('60');
  const [sens, setSens] = useState('3');
  const [usePir, setUsePir] = useState(true);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!base) return;
    (async () => {
      try {
        const c = await request(base, '/config');
        setEspHost(c.espHost); setEmailTo(c.emailTo);
        setCooldown(String(c.cooldownSec)); setSens(String(c.sensitivity)); setUsePir(!!c.usePir);
      } catch (e) { setMsg('No se pudo cargar la configuración: ' + e.message); }
    })();
  }, [base]);

  const testConn = async () => {
    const n = normalize(url);
    try { await request(n, '/status'); Alert.alert('✔ Conectado', 'El servidor respondió correctamente.'); }
    catch (e) { Alert.alert('✖ Sin conexión', e.message + '\n\nRevisa la IP, que el backend esté corriendo y el firewall.'); }
  };

  const saveUrl = async () => {
    const n = normalize(url);
    await saveBaseUrl(n);
    setUrl(n);
    onBaseSaved(n);
    setMsg('✔ Dirección guardada');
  };

  const saveCfg = async () => {
    try {
      await request(base, '/config', 'POST', {
        espHost, emailTo,
        cooldownSec: Number(cooldown), sensitivity: Number(sens), usePir,
      });
      setMsg('✔ Ajustes guardados en el servidor');
    } catch (e) { setMsg('✖ No se guardó: ' + e.message); }
  };

  const testMail = async () => {
    setMsg('Enviando correo de prueba…');
    try { await request(base, '/testmail', 'POST'); setMsg('✔ Correo de prueba enviado'); }
    catch (e) { setMsg('✖ Falló el correo: ' + e.message); }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
      <H>Ajustes</H>

      <Card>
        <Text style={{ color: C.text, fontWeight: '700', marginBottom: 8 }}>1. Servidor (tu PC)</Text>
        <Field label="Dirección del backend" value={url} onChangeText={setUrl}
          placeholder="192.168.43.10" keyboardType="url"
          hint="IP del PC en el hotspot. El puerto 3000 se agrega solo." />
        <Btn kind="ghost" title="Probar conexión" onPress={testConn} style={{ marginBottom: 8 }} />
        <Btn title="Guardar dirección" onPress={saveUrl} />
      </Card>

      {base ? (
        <Card>
          <Text style={{ color: C.text, fontWeight: '700', marginBottom: 8 }}>2. Cámara y alertas</Text>
          <Field label="IP del ESP32" value={espHost} onChangeText={setEspHost}
            placeholder="192.168.43.50" hint="Aparece en el Monitor Serie del Arduino al encender la placa." />
          <Field label="Correo que recibe las alertas" value={emailTo} onChangeText={setEmailTo}
            placeholder="propietario@gmail.com" keyboardType="email-address" />
          <Field label="Segundos mínimos entre correos" value={cooldown} onChangeText={setCooldown} keyboardType="numeric" />
          <Field label="Sensibilidad de imagen (%)" value={sens} onChangeText={setSens} keyboardType="numeric"
            hint="Más bajo = más sensible. Prueba entre 2 y 10." />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <Text style={{ color: C.text, fontSize: 16 }}>Usar sensor PIR</Text>
            <Switch value={usePir} onValueChange={setUsePir} trackColor={{ true: C.ok }} />
          </View>
          <Btn title="Guardar ajustes" onPress={saveCfg} style={{ marginBottom: 8 }} />
          <Btn kind="ghost" title="Enviar correo de prueba" onPress={testMail} />
        </Card>
      ) : null}

      {msg ? <Text style={{ color: msg.startsWith('✔') ? C.ok : C.warn }}>{msg}</Text> : null}
    </ScrollView>
  );
}
