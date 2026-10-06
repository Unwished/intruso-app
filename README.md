# Sistema de Detección de Intrusos IoT (ESP32-S3 CAM + App móvil)

Parcial segundo corte – Desarrollo Móvil.
Autor: Santiago Álvarez Maffiold

Sistema ciberfísico: una ESP32-S3 CAM transmite video MJPEG por Wi-Fi, un backend en el PC gestiona armado, horarios, detección de movimiento y alertas por correo con foto, y una app móvil (React Native + Expo) permite ver el video y configurar todo.

## Arquitectura

```
                  Hotspot Wi-Fi del celular (red local, 2.4 GHz)
 ┌──────────────────┐        ┌──────────────────────┐        ┌───────────────────┐
 │ ESP32-S3 CAM     │  HTTP  │ PC: backend Node.js  │  HTTP  │ App (Expo / RN)   │
 │ - captura JPEG   │◄──────►│ - armado y horarios  │◄──────►│ - video en vivo   │
 │ - /stream (MJPEG)│        │ - detección imagen   │        │ - armar/desarmar  │
 │ - /status, /capture        │ - correo con foto    │        │ - horarios/ajustes│
 │ - lectura PIR    │        └──────────────────────┘        └───────────────────┘
 └────────┬─────────┘                                                  ▲
          └────────────── video MJPEG directo (puerto 81) ─────────────┘
```

- El **celular** da el hotspot (y los datos para el correo); la placa y el PC se conectan a él.
- El **video** va directo de la placa a la app (menor latencia). El resto del tráfico pasa por el backend.
- Arquitectura con PC como servidor acordada con el docente.

## Mapa requisito → código

| Requisito del enunciado | Dónde está |
|---|---|
| **M1** Servidor y stream MJPEG a tasa constante | `firmware/intruso_esp32/intruso_esp32.ino`: `initCamera()`, `streamHandler()` (puerto 81, `STREAM_MAX_FPS`, doble búfer en PSRAM, `CAMERA_GRAB_LATEST`) |
| **M1** Detección local (sensor PIR) | `intruso_esp32.ino`: lectura del PIR por flanco ascendente en `loop()`; el estado sale por `GET /status` |
| **M1** Procesamiento básico de imagen | `backend/server.js`: `signature()` y `changedPct()` (diferencia de fotogramas sobre una cuadrícula 64×48 en grises) |
| **M2** Visor con baja latencia y reconexión automática | `app/src/components/MjpegViewer.js` (reintento cada 2 s) y `app/src/screens/LiveScreen.js` (estado de servidor y cámara cada 2 s) |
| **M2** Foreground Service y notificación persistente | **Pendiente** (requiere *development build*; Expo Go no lo soporta) |
| **M3** Franjas horarias y modo "Fuera de casa" | `app/src/screens/ScheduleScreen.js` y `backend/server.js`: `inSchedule()`, `isArmed()` (franjas que cruzan medianoche incluidas) |
| **M3** Correo con foto y marca temporal | `backend/server.js`: `sendAlert()` (nodemailer + Gmail, foto adjunta, hora de Colombia, *cooldown* anti-spam) |

El firmware también incluye horarios con NTP y envío de correo propios como respaldo, pero el flujo principal usa el backend.

## Estado actual

| Parte | Estado |
|---|---|
| Cámara y stream MJPEG desde la ESP32-S3 | Funcionando |
| Video en la app | Funcionando |
| Correo de prueba desde el backend | Funcionando |
| Armado, detección y correo con foto | Implementado, en pruebas |
| Franjas horarias | Implementado, en pruebas |
| Sensor PIR | Código listo; falta conectar el sensor |
| Foreground Service | Pendiente |
| Enfriamiento de la placa | Mitigado por software (12 FPS, CPU a 160 MHz, capturas solo si está armado); falta ventilador |

## Cómo ejecutarlo

**1. Firmware** (Arduino IDE, placa `ESP32S3 Dev Module`, PSRAM `OPI PSRAM`, Partition `Huge APP`)
- Librerías: *ArduinoJson* v7 y *ESP Mail Client*.
- Editar en el `.ino`: `WIFI_SSID` y `WIFI_PASS` (hotspot 2.4 GHz). Cargar y leer la IP en el Monitor Serie (115200).

**2. Backend** (Node.js ≥ 18)
```
cd backend
npm install
copy .env.example .env      # completar SMTP_USER, SMTP_PASS (contraseña de aplicación), EMAIL_TO, ESP_HOST
node server.js
```
`sim-esp.js` es un simulador de la placa para desarrollo sin hardware (`ESP_HOST=localhost:8081`).

**3. App** (Expo Go)
```
cd app
npm install
npx expo start
```
En *Ajustes*: dirección del backend (IP del PC) y IP de la ESP32.

## API del backend

| Endpoint | Función |
|---|---|
| `GET /status` | Armado, movimiento, estado de la cámara, último evento, correos enviados, `streamUrl` |
| `POST /arm` · `POST /disarm` | Modo "Fuera de casa" |
| `GET/POST /schedule` | Franjas `{"enabled":true,"slots":[{"days":[0..6],"start":"22:00","end":"06:00"}]}` |
| `GET/POST /config` | Correo destino, cooldown, sensibilidad, uso del PIR, IP de la placa |
| `POST /testmail` | Correo de prueba |
| `GET /events`, `GET /lastphoto` | Historial y última foto |

API de la placa: `GET :81/stream`, `GET /capture`, `GET /status`.

## Decisiones de diseño

- **Dos servidores HTTP en la placa** (API en el 80, video en el 81): un cliente de video no bloquea los comandos.
- **Latencia y calor:** doble búfer en PSRAM, `CAMERA_GRAB_LATEST` (siempre el fotograma más nuevo), límite de FPS, CPU a 160 MHz, cierre de sockets viejos (`lru_purge_enable`).
- **Detección:** flanco ascendente (un evento por movimiento), 2 lecturas consecutivas sobre el umbral para filtrar ruido, *cooldown* entre correos.
- **Backend:** *polling* con `setTimeout` recursivo (evita solapar peticiones); solo pide fotos a la placa cuando el sistema está armado.
- **Seguridad:** credenciales fuera del repositorio (`.env`, ignorado por git); Gmail con contraseña de aplicación.

## Limitaciones conocidas

- El PC es un punto único de falla: si se apaga o suspende, no hay vigilancia automática.
- Sin datos móviles en el hotspot no hay correo.
- La detección por imagen corre en el PC; la detección local en la placa depende del sensor PIR.
- Las direcciones IP las asigna el hotspot y pueden cambiar; se actualizan desde *Ajustes*.
