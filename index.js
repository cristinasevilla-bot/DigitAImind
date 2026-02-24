import express from "express";
import OpenAI from "openai";
import { google } from "googleapis";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ============================================================
// CONFIGURACIÓN DEL NEGOCIO (personalizable por cliente)
// ============================================================
const BUSINESS_CONFIG = {
  name: process.env.BUSINESS_NAME || "Mi Negocio",
  services: (process.env.BUSINESS_SERVICES || "consulta,cita,reserva").split(","),
  slotDuration: Number(process.env.SLOT_DURATION_MINUTES) || 30,
  advanceDays: Number(process.env.ADVANCE_DAYS) || 1,
  workingHours: {
    start: process.env.WORKING_HOURS_START || "09:00",
    end: process.env.WORKING_HOURS_END || "20:00",
  },
  workingDays: (process.env.WORKING_DAYS || "1,2,3,4,5").split(",").map(Number),
  timezone: process.env.TIMEZONE || "Europe/Madrid",
};

// ============================================================
// ESTADO EN MEMORIA
// ============================================================
const userSessions = new Map();

// ============================================================
// CLIENTES API
// ============================================================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getCalendarClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  console.log("🔑 Google credentials check:", {
    clientId: clientId ? `✅ (${clientId.slice(0, 10)}...)` : "❌ MISSING",
    clientSecret: clientSecret ? `✅ (${clientSecret.slice(0, 6)}...)` : "❌ MISSING",
    redirectUri: redirectUri ? `✅ ${redirectUri}` : "❌ MISSING",
    refreshToken: refreshToken ? `✅ (${refreshToken.slice(0, 10)}...)` : "❌ MISSING",
  });

  const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: "v3", auth });
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/", (req, res) => res.status(200).send(`${BUSINESS_CONFIG.name} Bot ✅`));

// ============================================================
// DASHBOARD ADMIN
// ============================================================
app.get("/admin", (req, res) => {
  try {
    const html = readFileSync(join(__dirname, "dashboard.html"), "utf8");
    res.send(html);
  } catch {
    res.status(404).send("Dashboard no encontrado");
  }
});

app.get("/admin/stats", (req, res) => {
  res.json({
    activeSessions: userSessions.size,
    bookingsToday: null,
    bookingsWeek: null,
  });
});

app.get("/admin/bookings", async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const startOfDay = new Date(`${today}T00:00:00`);
    const endOfDay = new Date(`${today}T23:59:59`);

    const response = await getCalendarClient().events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const bookings = (response.data.items || []).map(e => ({
      time: new Date(e.start.dateTime).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }),
      clientName: e.summary?.split(" - ")[1]?.split(" (")[0] || "Cliente",
      service: e.summary?.split(" - ")[0] || e.summary,
      eventId: e.id,
    }));

    res.json({ bookings, weekTotal: null });
  } catch (e) {
    console.error("Admin bookings error:", e.message);
    res.json({ bookings: [], weekTotal: null });
  }
});

// ============================================================
// GOOGLE OAUTH - OBTENER REFRESH TOKEN
// ============================================================
app.get("/auth/google", (req, res) => {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/auth/callback`
  );
  const url = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"],
  });
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send("Error: no code received");

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/auth/callback`
  );

  const { tokens } = await auth.getToken(code);
  console.log("🎉 TOKENS OBTENIDOS:", JSON.stringify(tokens, null, 2));

  res.send(`
    <h2>✅ Autorización completada</h2>
    <p>Copia este Refresh Token y ponlo en Render como <strong>GOOGLE_REFRESH_TOKEN</strong>:</p>
    <textarea rows="4" cols="80">${tokens.refresh_token || "No se generó refresh token - vuelve a intentarlo"}</textarea>
  `);
});

// ============================================================
// ENDPOINT DE TESTING
// ============================================================
app.post("/test", async (req, res) => {
  const { from = "admin-test", message } = req.body;
  if (!message) return res.status(400).json({ error: "Falta el campo message" });

  // Interceptar la respuesta del bot para devolverla al dashboard
  const originalSend = sendWhatsAppMessage;
  let botReply = null;

  // Sobrescribir temporalmente para capturar la respuesta
  const tempSend = async (to, text) => {
    botReply = text;
    console.log(`📤 [TEST - para ${to}]: ${text}`);
  };

  // Ejecutar con función interceptada y esperar respuesta
  try {
    await handleMessageWithSend(from, message, tempSend);
  } catch (e) {
    console.error("Test error:", e.message);
  }

  res.json({ status: "ok", reply: botReply || "Sin respuesta del bot — revisa los logs" });
});

app.post("/test/reset", (req, res) => {
  const { from = "admin-test" } = req.body;
  userSessions.delete(from);
  res.json({ status: "ok" });
});

// ============================================================
// WHATSAPP WEBHOOK VERIFICATION
// ============================================================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("Webhook verificado ✅");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ============================================================
// WHATSAPP WEBHOOK - RECIBE MENSAJES
// ============================================================
app.post("/webhook", async (req, res) => {
  try {
    res.sendStatus(200);

    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message || message.type !== "text") return;

    const from = message.from;
    const text = message.text.body.trim();

    console.log(`📩 [${from}]: ${text}`);
    await handleMessage(from, text);
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
  }
});

// ============================================================
// LÓGICA PRINCIPAL - MANEJO DE MENSAJES CON IA
// ============================================================
async function handleMessage(from, userMessage) {
  await handleMessageWithSend(from, userMessage, sendWhatsAppMessage);
}

async function handleMessageWithSend(from, userMessage, sendFn) {
  if (!userSessions.has(from)) {
    userSessions.set(from, { messages: [], pendingDate: null, pendingTime: null, pendingService: null });
  }
  const session = userSessions.get(from);
  session.messages.push({ role: "user", content: userMessage });

  const systemPrompt = buildSystemPrompt();

  const aiResponse = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: systemPrompt }, ...session.messages],
    functions: [
      {
        name: "check_availability",
        description: "Consulta los slots disponibles en Google Calendar para una fecha concreta",
        parameters: {
          type: "object",
          properties: { date: { type: "string", description: "Fecha en formato YYYY-MM-DD" } },
          required: ["date"],
        },
      },
      {
        name: "create_booking",
        description: "Crea una reserva en Google Calendar",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "Fecha en formato YYYY-MM-DD" },
            time: { type: "string", description: "Hora en formato HH:MM" },
            service: { type: "string", description: "Tipo de servicio o cita" },
            clientName: { type: "string", description: "Nombre del cliente si lo ha proporcionado" },
          },
          required: ["date", "time", "service"],
        },
      },
      {
        name: "cancel_booking",
        description: "Cancela una reserva existente",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "Fecha de la reserva en formato YYYY-MM-DD" },
            time: { type: "string", description: "Hora de la reserva en formato HH:MM" },
          },
          required: ["date", "time"],
        },
      },
    ],
    function_call: "auto",
  });

  const choice = aiResponse.choices[0];

  if (choice.finish_reason === "function_call") {
    const fnName = choice.message.function_call.name;
    const fnArgs = JSON.parse(choice.message.function_call.arguments);
    console.log(`🔧 Función: ${fnName}`, fnArgs);

    let fnResult;
    if (fnName === "check_availability") fnResult = await checkAvailability(fnArgs.date);
    else if (fnName === "create_booking") fnResult = await createBooking(fnArgs, from);
    else if (fnName === "cancel_booking") fnResult = await cancelBooking(fnArgs, from);

    session.messages.push(choice.message);
    session.messages.push({ role: "function", name: fnName, content: JSON.stringify(fnResult) });

    const secondResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: systemPrompt }, ...session.messages],
    });

    const reply = secondResponse.choices[0].message.content;
    session.messages.push({ role: "assistant", content: reply });
    if (session.messages.length > 20) session.messages = session.messages.slice(-20);
    await sendFn(from, reply);
  } else {
    const reply = choice.message.content;
    session.messages.push({ role: "assistant", content: reply });
    if (session.messages.length > 20) session.messages = session.messages.slice(-20);
    await sendFn(from, reply);
  }
}

// ============================================================
// SYSTEM PROMPT
// ============================================================
function buildSystemPrompt() {
  const today = new Date().toLocaleDateString("es-ES", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: BUSINESS_CONFIG.timezone,
  });

  return `Eres el asistente virtual de ${BUSINESS_CONFIG.name}. 
Tu función es ayudar a los clientes a hacer, consultar o cancelar reservas por WhatsApp.

HOY ES: ${today}

SERVICIOS DISPONIBLES: ${BUSINESS_CONFIG.services.join(", ")}
HORARIO: ${BUSINESS_CONFIG.workingHours.start} - ${BUSINESS_CONFIG.workingHours.end}
DURACIÓN DE CADA CITA: ${BUSINESS_CONFIG.slotDuration} minutos
DÍAS DE TRABAJO: Lunes a Viernes (salvo festivos)
ANTELACIÓN MÍNIMA: ${BUSINESS_CONFIG.advanceDays} día(s)

INSTRUCCIONES:
- Sé amable, breve y directo. Usa emojis con moderación.
- Si el usuario quiere reservar, primero pregunta qué servicio y para qué fecha/hora preferirían.
- Usa check_availability para consultar huecos reales antes de confirmar.
- Usa create_booking solo cuando el usuario haya confirmado explícitamente.
- Si necesitas el nombre del cliente para la reserva, pregúntalo.
- Si el usuario quiere cancelar, usa cancel_booking.
- Nunca inventes disponibilidad — siempre consulta primero.
- Responde siempre en español.`;
}

// ============================================================
// GOOGLE CALENDAR - CHECK AVAILABILITY
// ============================================================
async function checkAvailability(dateISO) {
  try {
    const startOfDay = new Date(`${dateISO}T${BUSINESS_CONFIG.workingHours.start}:00`);
    const endOfDay = new Date(`${dateISO}T${BUSINESS_CONFIG.workingHours.end}:00`);

    const response = await getCalendarClient().events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const busySlots = (response.data.items || []).map((e) => ({
      start: e.start.dateTime,
      end: e.end.dateTime,
    }));

    const allSlots = generateSlots();
    const availableSlots = allSlots.filter((slot) => {
      const slotStart = new Date(`${dateISO}T${slot}:00`);
      const slotEnd = new Date(slotStart.getTime() + BUSINESS_CONFIG.slotDuration * 60000);
      return !busySlots.some((busy) => {
        const busyStart = new Date(busy.start);
        const busyEnd = new Date(busy.end);
        return slotStart < busyEnd && slotEnd > busyStart;
      });
    });

    return { date: dateISO, availableSlots, totalSlots: allSlots.length };
  } catch (e) {
    console.error("Google Calendar error:", e.message);
    return { date: dateISO, availableSlots: generateSlots(), note: "demo_mode" };
  }
}

// ============================================================
// GOOGLE CALENDAR - CREATE BOOKING
// ============================================================
async function createBooking({ date, time, service, clientName }, from) {
  try {
    const startDateTime = new Date(`${date}T${time}:00`);
    const endDateTime = new Date(startDateTime.getTime() + BUSINESS_CONFIG.slotDuration * 60000);

    const event = {
      summary: `${service}${clientName ? ` - ${clientName}` : ""} (WhatsApp: ${from})`,
      description: `Reserva realizada por WhatsApp\nTeléfono: ${from}\nServicio: ${service}`,
      start: { dateTime: startDateTime.toISOString(), timeZone: BUSINESS_CONFIG.timezone },
      end: { dateTime: endDateTime.toISOString(), timeZone: BUSINESS_CONFIG.timezone },
    };

    const result = await getCalendarClient().events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      resource: event,
    });

    return { success: true, eventId: result.data.id, date, time, service };
  } catch (e) {
    console.error("Create booking error:", e.message);
    return { success: true, eventId: "demo-" + Date.now(), date, time, service, note: "demo_mode" };
  }
}

// ============================================================
// GOOGLE CALENDAR - CANCEL BOOKING
// ============================================================
async function cancelBooking({ date, time }, from) {
  try {
    const startDateTime = new Date(`${date}T${time}:00`);
    const endDateTime = new Date(startDateTime.getTime() + BUSINESS_CONFIG.slotDuration * 60000);

    const response = await getCalendarClient().events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      timeMin: startDateTime.toISOString(),
      timeMax: endDateTime.toISOString(),
      q: from,
      singleEvents: true,
    });

    const event = response.data.items?.[0];
    if (!event) return { success: false, message: "No se encontró la reserva" };

    await getCalendarClient().events.delete({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      eventId: event.id,
    });

    return { success: true, message: "Reserva cancelada correctamente" };
  } catch (e) {
    console.error("Cancel booking error:", e.message);
    return { success: false, message: "Error al cancelar" };
  }
}

// ============================================================
// WHATSAPP - ENVIAR MENSAJE
// ============================================================
async function sendWhatsAppMessage(to, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.log(`📤 [DEMO - para ${to}]: ${text}`);
    return;
  }

  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`WhatsApp API error: ${resp.status} ${body}`);
  }
}

// ============================================================
// HELPERS - GENERADOR DE SLOTS
// ============================================================
function generateSlots() {
  const slots = [];
  const start = toMinutes(BUSINESS_CONFIG.workingHours.start);
  const end = toMinutes(BUSINESS_CONFIG.workingHours.end);
  let t = start;
  while (t + BUSINESS_CONFIG.slotDuration <= end) {
    slots.push(fromMinutes(t));
    t += BUSINESS_CONFIG.slotDuration;
  }
  return slots;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function fromMinutes(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}`;
}

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 ${BUSINESS_CONFIG.name} Bot escuchando en puerto ${PORT}`));
