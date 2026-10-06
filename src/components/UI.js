// Piezas visuales reutilizables
import React from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet } from 'react-native';
import { C } from '../theme';

export const Card = ({ children, style }) => <View style={[s.card, style]}>{children}</View>;

export const H = ({ children }) => <Text style={s.h}>{children}</Text>;

export function Btn({ title, onPress, kind = 'primary', disabled, style }) {
  const bg = { primary: C.accent, danger: C.bad, ok: C.ok, ghost: 'transparent' }[kind];
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
      style={[s.btn, { backgroundColor: bg, opacity: disabled ? 0.5 : 1 },
        kind === 'ghost' && { borderWidth: 1, borderColor: C.border }, style]}
    >
      <Text style={s.btnText}>{title}</Text>
    </TouchableOpacity>
  );
}

export function Field({ label, hint, ...props }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        placeholderTextColor={C.muted}
        autoCapitalize="none"
        autoCorrect={false}
        style={s.input}
        {...props}
      />
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
  );
}

export const Dot = ({ color }) => <View style={[s.dot, { backgroundColor: color }]} />;

const s = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 14, marginBottom: 12 },
  h: { color: C.text, fontSize: 20, fontWeight: '700', marginBottom: 10 },
  btn: { paddingVertical: 14, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  label: { color: C.muted, fontSize: 13, marginBottom: 4 },
  input: { backgroundColor: C.bg, color: C.text, borderRadius: 10, borderWidth: 1, borderColor: C.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  hint: { color: C.muted, fontSize: 12, marginTop: 4 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 6 },
});
