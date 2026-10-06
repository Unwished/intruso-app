/*
 * Sistema de Detección de Intrusos IoT - Firmware ESP32-S3 CAM
 * ------------------------------------------------------------
 * - Modo STA (se conecta a router/hotspot) para tener internet (NTP + correo)
 * - Stream MJPEG en  http://IP:81/stream
 * - API REST en      http://IP/...
 * - Detección con sensor PIR
 * - Franjas horarias + modo manual "Fuera de casa" (persisten en flash)
 * - Alerta por correo con foto adjunta (tarea FreeRTOS separada)
 *
 * Librerías (Gestor de librerías de Arduino IDE):
 *   - ArduinoJson (v7.x) de Benoit Blanchon
 *   - ESP Mail Client (v3.x) de Mobizt
 *
 * Placa en Arduino IDE
 *   ESP32-CAM (AI Thinker):
 *     Board: "AI Thinker ESP32-CAM"
 *     Partition Scheme: "Huge APP (3MB No OTA/1MB SPIFFS)"
 *     (PSRAM ya viene activada en esa placa)
 *   ESP32-S3:
 *     Board: "ESP32S3 Dev Module", PSRAM: "OPI PSRAM",
 *     Partition: "Huge APP", USB CDC On Boot: "Enabled"
 */

#include <WiFi.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <ESP_Mail_Client.h>
#include "esp_camera.h"
#include "esp_http_server.h"
#include "esp_timer.h"

// ===================== CONFIGURACIÓN DEL USUARIO =====================
// --- Wi-Fi (router o hotspot del celular, 2.4 GHz) ---
const char* WIFI_SSID = "FO";
const char* WIFI_PASS = "UnwishedL";

// --- Cuenta Gmail REMITENTE (con verificación en 2 pasos + contraseña de aplicación) ---
const char* SMTP_HOST  = "smtp.gmail.com";
const int   SMTP_PORT  = 465;
const char* SMTP_USER  = "tu_cuenta@gmail.com";
const char* SMTP_PASS  = "xxxx xxxx xxxx xxxx";   // contraseña de aplicación (16 letras)

// --- Destinatario por defecto (se puede cambiar desde la app con POST /config) ---
const char* DEFAULT_EMAIL_TO = "propietario@gmail.com";

// --- Placa: deja SOLO UNA de estas dos lineas activa ---
//#define BOARD_AI_THINKER        // ESP32-CAM clasica (sin USB): la que tienes
#define BOARD_FREENOVE_S3     // ESP32-S3 WROOM CAM

// --- Zona horaria Colombia (UTC-5, sin horario de verano) ---
#define TZ_INFO "<-05>5"

// --- Limite de fotogramas por segundo del video (menos FPS = menos calor) ---
#define STREAM_MAX_FPS 12

// --- Ajustes para bajar el calor ---
#define CAM_XCLK_HZ   20000000          // reloj de la camara: 20 MHz = video fluido. Si necesitas menos calor, prueba 10000000
#define WIFI_TX_POWER WIFI_POWER_11dBm  // potencia del WiFi (hotspot cerca). Si pierde senal, usa WIFI_POWER_15dBm

#if defined(BOARD_AI_THINKER)
  #define PIR_PIN         13    // Libre en la ESP32-CAM (no uses la SD)
  #define PWDN_GPIO_NUM   32
  #define RESET_GPIO_NUM  -1
  #define XCLK_GPIO_NUM    0
  #define SIOD_GPIO_NUM   26
  #define SIOC_GPIO_NUM   27
  #define Y9_GPIO_NUM     35
  #define Y8_GPIO_NUM     34
  #define Y7_GPIO_NUM     39
  #define Y6_GPIO_NUM     36
  #define Y5_GPIO_NUM     21
  #define Y4_GPIO_NUM     19
  #define Y3_GPIO_NUM     18
  #define Y2_GPIO_NUM      5
  #define VSYNC_GPIO_NUM  25
  #define HREF_GPIO_NUM   23
  #define PCLK_GPIO_NUM   22
#elif defined(BOARD_FREENOVE_S3)
  #define PIR_PIN         14
  #define PWDN_GPIO_NUM   -1
  #define RESET_GPIO_NUM  -1
  #define XCLK_GPIO_NUM   15
  #define SIOD_GPIO_NUM    4
  #define SIOC_GPIO_NUM    5
  #define Y9_GPIO_NUM     16
  #define Y8_GPIO_NUM     17
  #define Y7_GPIO_NUM     18
  #define Y6_GPIO_NUM     12
  #define Y5_GPIO_NUM     10
  #define Y4_GPIO_NUM      8
  #define Y3_GPIO_NUM      9
  #define Y2_GPIO_NUM     11
  #define VSYNC_GPIO_NUM   6
  #define HREF_GPIO_NUM    7
  #define PCLK_GPIO_NUM   13
#endif
// =====================================================================

// ---------------- Estado global ----------------
Preferences prefs;

struct Slot {
  uint8_t  daysMask;   // bit0 = domingo ... bit6 = sábado
  uint16_t startMin;   // minutos desde 00:00
  uint16_t endMin;
};
#define MAX_SLOTS 8
Slot slots[MAX_SLOTS];
int  slotCount = 0;

volatile bool manualArmed     = false;  // modo "Fuera de casa" manual
volatile bool scheduleEnabled = false;  // franjas activadas
String   emailTo;
uint32_t cooldownSec = 60;              // mínimo entre correos

volatile bool     motionNow       = false;
volatile uint32_t lastEventEpoch  = 0;
volatile uint32_t emailsSent      = 0;
volatile bool     lastEmailOk     = false;
unsigned long     lastAlertMs     = 0;
bool              alertedOnce     = false;

httpd_handle_t apiServer    = NULL;
httpd_handle_t streamServer = NULL;
TaskHandle_t   mailTaskHandle = NULL;

// ---------------- Utilidades de tiempo ----------------
bool timeSynced() {
  time_t now; time(&now);
  return now > 1700000000;   // si es menor, NTP aún no sincronizó
}

bool inScheduleNow() {
  if (!scheduleEnabled || !timeSynced()) return false;
  time_t now; time(&now);
  struct tm t; localtime_r(&now, &t);
  int minutes = t.tm_hour * 60 + t.tm_min;
  int day = t.tm_wday;               // 0 = domingo
  int prev = (day + 6) % 7;
  for (int i = 0; i < slotCount; i++) {
    Slot& s = slots[i];
    if (s.startMin <= s.endMin) {
      if ((s.daysMask & (1 << day)) && minutes >= s.startMin && minutes < s.endMin) return true;
    } else {  // franja nocturna que cruza medianoche (ej. 22:00 -> 06:00)
      if ((s.daysMask & (1 << day)) && minutes >= s.startMin) return true;
      if ((s.daysMask & (1 << prev)) && minutes < s.endMin) return true;
    }
  }
  return false;
}

bool systemArmed() { return manualArmed || inScheduleNow(); }

// ---------------- Horarios: parseo y persistencia ----------------
static int parseHHMM(const char* s) {
  int h = 0, m = 0;
  if (sscanf(s, "%d:%d", &h, &m) != 2) return -1;
  if (h < 0 || h > 23 || m < 0 || m > 59) return -1;
  return h * 60 + m;
}

// Formato: {"enabled":true,"slots":[{"days":[0,1,2],"start":"22:00","end":"06:00"}]}
bool applyScheduleJson(const String& json) {
  JsonDocument doc;
  if (deserializeJson(doc, json)) return false;
  Slot tmp[MAX_SLOTS];
  int n = 0;
  for (JsonObject o : doc["slots"].as<JsonArray>()) {
    if (n >= MAX_SLOTS) break;
    int st = parseHHMM(o["start"] | "");
    int en = parseHHMM(o["end"] | "");
    if (st < 0 || en < 0) return false;
    uint8_t mask = 0;
    for (int d : o["days"].as<JsonArray>()) if (d >= 0 && d <= 6) mask |= (1 << d);
    tmp[n++] = { mask, (uint16_t)st, (uint16_t)en };
  }
  memcpy(slots, tmp, sizeof(Slot) * n);
  slotCount = n;
  scheduleEnabled = doc["enabled"] | false;
  return true;
}

// ---------------- Cámara ----------------
bool initCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer   = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;  c.pin_d1 = Y3_GPIO_NUM;  c.pin_d2 = Y4_GPIO_NUM;  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;  c.pin_d5 = Y7_GPIO_NUM;  c.pin_d6 = Y8_GPIO_NUM;  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;  c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM; c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM; c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM;  c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = CAM_XCLK_HZ;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size   = FRAMESIZE_VGA;        // 640x480: buen balance latencia/calidad
  c.jpeg_quality = 12;                   // 10 (mejor) - 63 (peor)
  c.fb_count     = 2;                    // doble búfer: captura mientras se transmite
  c.fb_location  = CAMERA_FB_IN_PSRAM;
  c.grab_mode    = CAMERA_GRAB_LATEST;   // siempre el fotograma más reciente (menor latencia)

  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) {
    Serial.printf("ERROR cámara 0x%x\n", err);
    return false;
  }
  return true;
}

// ---------------- Servidor HTTP: helpers ----------------
static void setCors(httpd_req_t* req) {
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
}

static esp_err_t sendJson(httpd_req_t* req, const String& body, const char* status = "200 OK") {
  httpd_resp_set_status(req, status);
  httpd_resp_set_type(req, "application/json");
  setCors(req);
  return httpd_resp_send(req, body.c_str(), body.length());
}

static bool readBody(httpd_req_t* req, String& out) {
  size_t len = req->content_len;
  if (len == 0) { out = ""; return true; }
  if (len > 2048) return false;
  char buf[2049];
  size_t got = 0;
  while (got < len) {
    int r = httpd_req_recv(req, buf + got, len - got);
    if (r <= 0) return false;
    got += r;
  }
  buf[got] = 0;
  out = String(buf);
  return true;
}

// ---------------- Handlers ----------------
#define PART_BOUNDARY "frame123456789"
static const char* STREAM_CT       = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
static const char* STREAM_PART     = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static esp_err_t streamHandler(httpd_req_t* req) {
  httpd_resp_set_type(req, STREAM_CT);
  setCors(req);
  char part[64];
  int failures = 0;
  const int64_t frameUs = 1000000LL / STREAM_MAX_FPS;
  while (true) {
    int64_t startUs = esp_timer_get_time();
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
      if (++failures > 10) return ESP_FAIL;
      vTaskDelay(20 / portTICK_PERIOD_MS);
      continue;
    }
    failures = 0;
    size_t hlen = snprintf(part, sizeof(part), STREAM_PART, (unsigned)fb->len);
    esp_err_t res = httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY));
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, part, hlen);
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char*)fb->buf, fb->len);
    esp_camera_fb_return(fb);
    if (res != ESP_OK) break;      // el cliente se desconectó -> liberar el hilo
    int64_t usedUs = esp_timer_get_time() - startUs;      // limitar FPS: descansar el resto del tiempo
    if (usedUs < frameUs) vTaskDelay(pdMS_TO_TICKS((frameUs - usedUs) / 1000));
    else vTaskDelay(1);
  }
  return ESP_OK;
}

static esp_err_t captureHandler(httpd_req_t* req) {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) return httpd_resp_send_500(req);
  httpd_resp_set_type(req, "image/jpeg");
  setCors(req);
  esp_err_t res = httpd_resp_send(req, (const char*)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  return res;
}

static esp_err_t statusHandler(httpd_req_t* req) {
  JsonDocument d;
  time_t now; time(&now);
  d["armed"]           = systemArmed();
  d["manualArmed"]     = (bool)manualArmed;
  d["scheduleEnabled"] = (bool)scheduleEnabled;
  d["inSchedule"]      = inScheduleNow();
  d["motion"]          = (bool)motionNow;
  d["lastEvent"]       = (uint32_t)lastEventEpoch;   // epoch UTC, 0 = ninguno
  d["emailsSent"]      = (uint32_t)emailsSent;
  d["lastEmailOk"]     = (bool)lastEmailOk;
  d["timeSynced"]      = timeSynced();
  d["time"]            = (uint32_t)now;
  d["rssi"]            = WiFi.RSSI();
  d["ip"]              = WiFi.localIP().toString();
  d["uptime"]          = (uint32_t)(millis() / 1000);
  String out; serializeJson(d, out);
  return sendJson(req, out);
}

static esp_err_t armHandler(httpd_req_t* req) {
  manualArmed = true;
  prefs.putBool("armed", true);
  return sendJson(req, "{\"ok\":true,\"manualArmed\":true}");
}

static esp_err_t disarmHandler(httpd_req_t* req) {
  manualArmed = false;
  prefs.putBool("armed", false);
  return sendJson(req, "{\"ok\":true,\"manualArmed\":false}");
}

static esp_err_t scheduleGetHandler(httpd_req_t* req) {
  String raw = prefs.getString("sched", "{\"enabled\":false,\"slots\":[]}");
  return sendJson(req, raw);
}

static esp_err_t schedulePostHandler(httpd_req_t* req) {
  String body;
  if (!readBody(req, body) || !applyScheduleJson(body))
    return sendJson(req, "{\"ok\":false,\"error\":\"JSON invalido\"}", "400 Bad Request");
  prefs.putString("sched", body);
  return sendJson(req, "{\"ok\":true}");
}

static esp_err_t configGetHandler(httpd_req_t* req) {
  JsonDocument d;
  d["emailTo"]     = emailTo;
  d["cooldownSec"] = cooldownSec;
  String out; serializeJson(d, out);
  return sendJson(req, out);
}

static esp_err_t configPostHandler(httpd_req_t* req) {
  String body; JsonDocument d;
  if (!readBody(req, body) || deserializeJson(d, body))
    return sendJson(req, "{\"ok\":false,\"error\":\"JSON invalido\"}", "400 Bad Request");
  if (d["emailTo"].is<const char*>()) {
    String e = d["emailTo"].as<String>();
    if (e.indexOf('@') < 1) return sendJson(req, "{\"ok\":false,\"error\":\"correo invalido\"}", "400 Bad Request");
    emailTo = e; prefs.putString("emailTo", e);
  }
  if (d["cooldownSec"].is<int>()) {
    cooldownSec = constrain((int)d["cooldownSec"], 10, 3600);
    prefs.putUInt("cooldown", cooldownSec);
  }
  return sendJson(req, "{\"ok\":true}");
}

static esp_err_t testMailHandler(httpd_req_t* req) {   // fuerza un correo de prueba
  lastEventEpoch = timeSynced() ? time(NULL) : 0;
  if (mailTaskHandle) xTaskNotifyGive(mailTaskHandle);
  return sendJson(req, "{\"ok\":true,\"queued\":true}");
}

void startServers() {
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.server_port      = 80;
  cfg.max_uri_handlers = 16;
  cfg.stack_size       = 8192;
  cfg.lru_purge_enable = true;   // si se llenan los sockets, cierra el mas viejo (evita que la placa se "cuelgue")
  cfg.recv_wait_timeout = 5;
  cfg.send_wait_timeout = 5;

  httpd_uri_t routes[] = {
    {"/capture",  HTTP_GET,  captureHandler,      NULL},
    {"/status",   HTTP_GET,  statusHandler,       NULL},
    {"/arm",      HTTP_POST, armHandler,          NULL},
    {"/disarm",   HTTP_POST, disarmHandler,       NULL},
    {"/schedule", HTTP_GET,  scheduleGetHandler,  NULL},
    {"/schedule", HTTP_POST, schedulePostHandler, NULL},
    {"/config",   HTTP_GET,  configGetHandler,    NULL},
    {"/config",   HTTP_POST, configPostHandler,   NULL},
    {"/testmail", HTTP_POST, testMailHandler,     NULL},
  };
  if (httpd_start(&apiServer, &cfg) == ESP_OK) {
    for (auto& r : routes) httpd_register_uri_handler(apiServer, &r);
  }

  // Servidor aparte para el stream: un cliente de video no bloquea la API
  httpd_config_t scfg = HTTPD_DEFAULT_CONFIG();
  scfg.server_port = 81;
  scfg.ctrl_port  += 1;
  scfg.lru_purge_enable = true;
  httpd_uri_t streamUri = {"/stream", HTTP_GET, streamHandler, NULL};
  if (httpd_start(&streamServer, &scfg) == ESP_OK) {
    httpd_register_uri_handler(streamServer, &streamUri);
  }
}

// ---------------- Correo (tarea independiente) ----------------
SMTPSession smtp;

void sendAlertEmail() {
  // 1) Capturar foto y copiarla a PSRAM para liberar el búfer de cámara enseguida
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { Serial.println("Alerta: sin foto"); lastEmailOk = false; return; }
  size_t   len = fb->len;
  uint8_t* img = (uint8_t*)ps_malloc(len);
  if (img) memcpy(img, fb->buf, len);
  esp_camera_fb_return(fb);
  if (!img) { lastEmailOk = false; return; }

  // 2) Texto con marca temporal exacta
  char ts[40] = "hora no sincronizada";
  if (timeSynced()) {
    time_t now; time(&now);
    struct tm t; localtime_r(&now, &t);
    strftime(ts, sizeof(ts), "%Y-%m-%d %H:%M:%S", &t);
  }
  String to = emailTo;

  Session_Config sc;
  sc.server.host_name = SMTP_HOST;
  sc.server.port      = SMTP_PORT;
  sc.login.email      = SMTP_USER;
  sc.login.password   = SMTP_PASS;
  sc.login.user_domain = "";

  SMTP_Message msg;
  msg.sender.name  = "Sistema Anti-Intrusos";
  msg.sender.email = SMTP_USER;
  msg.subject      = "ALERTA: movimiento detectado";
  msg.addRecipient("Propietario", to.c_str());
  String body = String("Se detecto movimiento sospechoso.\n\nFecha y hora: ") + ts +
                "\nCamara IP: " + WiFi.localIP().toString() + "\n\nVer foto adjunta.";
  msg.text.content = body.c_str();
  msg.text.charSet = "utf-8";

  SMTP_Attachment att;
  att.descr.filename = "intruso.jpg";
  att.descr.mime     = "image/jpeg";
  att.blob.data      = img;
  att.blob.size      = len;
  att.descr.transfer_encoding = Content_Transfer_Encoding::enc_base64;
  msg.addAttachment(att);

  // 3) Enviar
  bool ok = false;
  if (smtp.connect(&sc)) {
    ok = MailClient.sendMail(&smtp, &msg);
    smtp.closeSession();
  }
  if (!ok) Serial.printf("Fallo correo: %s\n", smtp.errorReason().c_str());
  lastEmailOk = ok;
  if (ok) emailsSent++;
  free(img);
  Serial.println(ok ? "Correo enviado" : "Correo NO enviado");
}

void mailTask(void*) {
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);   // duerme hasta que haya alerta
    if (WiFi.status() == WL_CONNECTED) sendAlertEmail();
  }
}

// ---------------- setup / loop ----------------
void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  WiFi.setTxPower(WIFI_TX_POWER);
  Serial.print("Conectando WiFi");
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) { delay(400); Serial.print("."); }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) Serial.printf("IP: %s\n", WiFi.localIP().toString().c_str());
  else Serial.println("Sin WiFi (reintentara en loop)");
}

void setup() {
  setCpuFrequencyMhz(160);   // 160 MHz en vez de 240: menos calor, sobra potencia
  Serial.begin(115200);
  delay(500);
  pinMode(PIR_PIN, INPUT);

  // Restaurar configuración guardada
  prefs.begin("intruso", false);
  manualArmed = prefs.getBool("armed", false);
  emailTo     = prefs.getString("emailTo", DEFAULT_EMAIL_TO);
  cooldownSec = prefs.getUInt("cooldown", 60);
  applyScheduleJson(prefs.getString("sched", "{\"enabled\":false,\"slots\":[]}"));

  if (!initCamera()) { Serial.println("Reiniciando..."); delay(3000); ESP.restart(); }

  connectWifi();
  configTzTime(TZ_INFO, "pool.ntp.org", "time.google.com");   // NTP

  xTaskCreatePinnedToCore(mailTask, "mailTask", 32768, NULL, 1, &mailTaskHandle, 0);
  startServers();
  Serial.printf("Stream: http://%s:81/stream\n", WiFi.localIP().toString().c_str());
  Serial.println("Calentando PIR (HC-SR501 tarda ~30-60 s en estabilizarse)...");
}

void loop() {
  // Reconexión WiFi
  static unsigned long lastWifiCheck = 0;
  if (millis() - lastWifiCheck > 10000) {
    lastWifiCheck = millis();
    if (WiFi.status() != WL_CONNECTED) { Serial.println("WiFi caido, reconectando"); WiFi.reconnect(); }
  }

  // Lectura PIR con detección de flanco ascendente
  static bool prev = false;
  bool cur = digitalRead(PIR_PIN) == HIGH;
  motionNow = cur;
  if (cur && !prev) {
    Serial.println("Movimiento detectado");
    if (systemArmed()) {
      bool cooled = !alertedOnce || (millis() - lastAlertMs > cooldownSec * 1000UL);
      if (cooled) {
        alertedOnce = true;
        lastAlertMs = millis();
        lastEventEpoch = timeSynced() ? (uint32_t)time(NULL) : 0;
        if (mailTaskHandle) xTaskNotifyGive(mailTaskHandle);
        Serial.println("ALERTA disparada -> correo en cola");
      }
    }
  }
  prev = cur;
  delay(50);
}
