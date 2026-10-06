// Visor de video MJPEG: una página mínima con <img> dentro de un WebView.
// Si falla, reintenta solo cada 2 segundos remontando el WebView.
import React, { useEffect, useRef, useState } from 'react';
import { WebView } from 'react-native-webview';

export default function MjpegViewer({ url }) {
  const [attempt, setAttempt] = useState(0);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const retry = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAttempt((a) => a + 1), 2000);
  };

  const src = `${url}${url.includes('?') ? '&' : '?'}t=${attempt}`;   // evita caché
  const origin = (url.match(/^https?:\/\/[^/]+/) || ['http://localhost'])[0];

  const html = `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#000}
img{width:100%;height:100%;object-fit:contain}</style></head>
<body><img src="${src}" onerror="window.ReactNativeWebView.postMessage('error')"></body></html>`;

  return (
    <WebView
      key={attempt}
      source={{ html, baseUrl: origin }}
      originWhitelist={['*']}
      mixedContentMode="always"
      scrollEnabled={false}
      javaScriptEnabled
      style={{ backgroundColor: '#000' }}
      onMessage={(m) => { if (m.nativeEvent.data === 'error') retry(); }}
      onError={retry}
      onHttpError={retry}
    />
  );
}
