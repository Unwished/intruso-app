// Comunicación con el backend (PC) y guardado de su dirección en el celular
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'backendUrl';

// "192.168.43.10" -> "http://192.168.43.10:3000"
export function normalize(u) {
  let s = (u || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  if (!/:\d+$/.test(s)) s += ':3000';
  return s;
}

export const loadBaseUrl = async () => (await AsyncStorage.getItem(KEY)) || '';
export const saveBaseUrl = async (u) => AsyncStorage.setItem(KEY, normalize(u));

// Petición HTTP con límite de tiempo (si el servidor no responde en 4 s, falla)
export async function request(base, path, method = 'GET', body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('El servidor no responde');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
