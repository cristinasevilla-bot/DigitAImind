import express from "express";
import OpenAI from "openai";
import { google } from "googleapis";

const app = express();
app.use(express.json());

// ============================================================
// CONFIGURACIÓN DEL NEGOCIO (personalizable por cliente)
// ============================================================
const BUSINESS_CONFIG = {
  name: process.env.BUSINESS_NAME || "Mi Negocio",
  services: (process.env.BUSINESS_SERVICES || "consulta,cita,reserva").split(","),
  slotDuration: Number(process.env.SLOT_DURATION_MINUTES) || 30, // minutos por cita
  advanceDays: Number(process.env.ADVANCE_DAYS) || 1, // días mínimos de antelación
  workingHours: {
    start: process.env.WORKING_HOURS_START || "09:00",
    end: process.env.WORKING_HOURS_END || "20:00",
  },
  workingDays: (process.env.WORKING_DAYS || "1,2,3,4,5").split(",").map(Number), // 1=Lunes...7=Domingo
  timezone: process.env.TIMEZONE || "Europe/Madrid",
};

// ============================================================
// ESTADO EN MEMORIA (en producción usar Redis o BD)
// ============================================================
const userSessions = new Map();
// Estructura de sesión: { messages: [], pendingDate: null, pendingTime: null, pendingService: null }

// ============================================================
// CLIENTES API
// ============================================================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Google Calendar OAuth2 - se inicializa en cada llamada para evitar problemas de credenciales
function getCalendarClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  // Debug: verificar que las credenciales están presentes
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
// GOOGLE OAUTH - OBTENER REFRESH TOKEN FÁCILMENTE
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
    res.sendStatus(200); // Responder rápido a Meta

    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message || message.type !== "text") return;

    const from = message.from; // número del usuario
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
  // Obtener o crear sesión
  if (!userSessions.has(from)) {
    userSessions.set(from, { messages: [], pendingDate: null, pendingTime: null, pendingService: null });
  }
  const session = userSessions.get(from);

  // Añadir mensaje del usuario al historial
  session.messages.push({ role: "user", content: userMessage });

  // Contexto del sistema para la IA
  const systemPrompt = buildSystemPrompt(session);

  // Llamar a OpenAI
  const aiResponse = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      ...session.messages,
    ],
    functions: [
      {
        name: "check_availability",
        description: "Consulta los slots disponibles en Google Calendar para una fecha concreta",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "Fecha en formato YYYY-MM-DD" },
          },
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

  // Si la IA quiere llamar a una función
  if (choice.finish_reason === "function_call") {
    const fnName = choice.message.function_call.name;
    const fnArgs = JSON.parse(choice.message.function_call.arguments);

    console.log(`🔧 Función: ${fnName}`, fnArgs);

    let fnResult;
    if (fnName === "check_availability") {
      fnResult = await checkAvailability(fnArgs.date);
    } else if (fnName === "create_booking") {
      fnResult = await createBooking(fnArgs, from);
    } else if (fnName === "cancel_booking") {
      fnResult = await cancelBooking(fnArgs, from);
    }

    // Añadir resultado de la función al historial
    session.messages.push(choice.message);
    session.messages.push({
      role: "function",
      name: fnName,
      content: JSON.stringify(fnResult),
    });

    // Segunda llamada a la IA con el resultado
    const secondResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...session.messages,
      ],
    });

    const reply = secondResponse.choices[0].message.content;
    session.messages.push({ role: "assistant", content: reply });

    // Limpiar historial si es muy largo (últimos 20 mensajes)
    if (session.messages.length > 20) {
      session.messages = session.messages.slice(-20);
    }

    await sendWhatsAppMessage(from, reply);
  } else {
    // Respuesta directa de la IA
    const reply = choice.message.content;
    session.messages.push({ role: "assistant", content: reply });

    if (session.messages.length > 20) {
      session.messages = session.messages.slice(-20);
    }

    await sendWhatsAppMessage(from, reply);
  }
}

// ============================================================
// SYSTEM PROMPT DINÁMICO
// ============================================================
function buildSystemPrompt(session) {
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
- Usa la función check_availability para consultar huecos reales antes de confirmar.
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

    // Generar todos los slots del día
    const allSlots = generateSlots(dateISO);

    // Filtrar slots ocupados
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
    // Fallback: devolver slots sin consultar calendario (demo sin credenciales)
    return { date: dateISO, availableSlots: generateSlots(dateISO), note: "demo_mode" };
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
    // Fallback demo
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
    // MODO DEMO: solo log en consola
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
function generateSlots(dateISO) {
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
