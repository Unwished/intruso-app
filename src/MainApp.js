// App principal: barra inferior con 3 pestañas
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, StatusBar, Platform } from 'react-native';
import { C } from './theme';
import { loadBaseUrl } from './api';
import LiveScreen from './screens/LiveScreen';
import ScheduleScreen from './screens/ScheduleScreen';
import SettingsScreen from './screens/SettingsScreen';

const TABS = [
  { id: 'live', label: 'En vivo', icon: '📹' },
  { id: 'sched', label: 'Horarios', icon: '🕒' },
  { id: 'cfg', label: 'Ajustes', icon: '⚙️' },
];

export default function App() {
  const [base, setBase] = useState(null);   // null = todavía cargando
  const [tab, setTab] = useState('live');

  useEffect(() => {
    loadBaseUrl().then((u) => { setBase(u); if (!u) setTab('cfg'); });
  }, []);

  if (base === null) return <View style={s.root} />;

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <View style={{ flex: 1 }}>
        {tab === 'live' && (base ? <LiveScreen base={base} /> : <Text style={s.empty}>Configura el servidor en Ajustes.</Text>)}
        {tab === 'sched' && <ScheduleScreen base={base} />}
        {tab === 'cfg' && <SettingsScreen base={base} onBaseSaved={setBase} />}
      </View>
      <View style={s.bar}>
        {TABS.map((t) => (
          <TouchableOpacity key={t.id} style={s.tab} onPress={() => setTab(t.id)}>
            <Text style={{ fontSize: 22 }}>{t.icon}</Text>
            <Text style={[s.tabT, tab === t.id && { color: C.accent }]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 24) + 4 : 50 },
  bar: { flexDirection: 'row', backgroundColor: C.card, borderTopWidth: 1, borderTopColor: C.border, paddingBottom: 18, paddingTop: 8 },
  tab: { flex: 1, alignItems: 'center' },
  tabT: { color: C.muted, fontSize: 12, marginTop: 2 },
  empty: { color: C.muted, padding: 20 },
});
