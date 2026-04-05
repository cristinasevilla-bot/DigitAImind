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
// CONFIGURACIÓN NLT
// ============================================================
const NLT_CONFIG = {
  name: "Next Level Training",
  timezone: "Europe/Madrid",
  visitDuration: 30,           // minutos por visita informativa
  advanceDays: 3,              // mínimo 3 días de antelación
  visitHours: {
    morning: { start: "10:30", end: "13:00" },
    afternoon: { start: "17:00", end: "20:00" },
  },
  // Solo L-V para visitas
  visitDays: [1, 2, 3, 4, 5],
};

// ============================================================
// KNOWLEDGE BASE - FAQs de NLT
// ============================================================
const NLT_FAQ = `
DIRECCIÓN: C/ Antonio Van de Pere Nº 25, Local 4 (Paseo Peatonal), CP 28342, Valdemoro (Madrid).
TELÉFONO: 640 355 446
EMAIL: info@nextleveltraining.es

HORARIO DE CLASES:
- Lunes a viernes: Mañanas 9:30–13:30 | Tardes 15:30–21:30
- Sábados: Solo mañana 9:30–13:30 (no hay clases por la tarde)
- Tipos: Funcional (Tono/Cardio/Hipertrofia), Core-Flex, Crosstraining, Espalda Sana

HORARIO DE VISITAS INFORMATIVAS (solo L-V):
- Mañana: 10:30–13:00 | Tarde: 17:00–20:00
- Duración ~30 min

SERVICIOS: Grupos Reducidos, Entrenamiento Personal, Entrenamiento Online, Nutrición, Fisioterapia.

GRUPOS REDUCIDOS:
- Grupos de 2 a 7 personas, sesiones de 55-60 min
- Bono Basic: 8 sesiones 69€ | 12 sesiones 89€ | 16 sesiones 119€
- Bono Premium: 8 sesiones 72€ | 12 sesiones 92€ | 16 sesiones 122€
- Diferencia Basic/Premium: Premium tiene preferencia en reserva de clases vía app
- Sesión puntual: 12,99€
- Las sesiones caducan a los 30 días desde la compra. Renovación automática.

ENTRENAMIENTO PERSONAL:
- Individual o Dúo, atención 100% personalizada
- Bono 5: 180€ (36€/ses) | Bono 10: 320€ (32€/ses)
- Dúo 5: 280€ | Dúo 10: 440€
- Sesión puntual: 40€

ENTRENAMIENTO ONLINE:
- 2 días/sem: 19,99€ | 3 días/sem: 29,99€ | 4 días/sem: 39,99€
- Se adapta a objetivo, nivel y material disponible

OTROS:
- No hay matrícula, ni permanencia, ni penalización por baja
- Los entrenamientos se adaptan a todos los niveles. No hay prueba de nivel.
- Solo entrenamientos dirigidos por profesionales titulados (no hay acceso libre)
- Clase de prueba: se ofrece durante la visita al centro
- App disponible para reservar/cancelar clases, ver bonos y disponibilidad
- Fisioterapia y Nutrición disponibles (preguntar directamente)
- Descuentos puntuales comunicados por app o email
- Seguimiento personalizado especialmente en entrenamientos personales

ENLACE HORARIO PDF: https://nextleveltraining.es/wp-content/uploads/2025/08/horario_2025_2026.pdf
`;

// ============================================================
// ESTADO EN MEMORIA
// ============================================================
const userSessions = new Map();

function getSession(from) {
  if (!userSessions.has(from)) {
    userSessions.set(from, {
      messages: [],
      state: "idle",          // idle | awaiting_name | awaiting_preference | awaiting_confirmation | confirmed
      clientName: null,
      preference: null,       // "mañana" | "tarde" | null
      proposedSlots: [],      // hasta 3 slots propuestos
      chosenSlot: null,       // slot confirmado
      eventId: null,          // Google Calendar event ID
      retries: 0,
    });
  }
  return userSessions.get(from);
}

// ============================================================
// CLIENTES API
// ============================================================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getCalendarClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: "v3", auth });
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/", (req, res) => res.status(200).send("Next Level Training Bot ✅"));

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
  res.json({ activeSessions: userSessions.size });
});

app.get("/admin/bookings", async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const response = await getCalendarClient().events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      timeMin: new Date(`${today}T00:00:00`).toISOString(),
      timeMax: new Date(`${today}T23:59:59`).toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });
    const bookings = (response.data.items || []).map(e => ({
      time: new Date(e.start.dateTime).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }),
      clientName: e.summary?.split(" - ")[1]?.split(" (")[0] || "Cliente",
      service: "Visita NLT",
      eventId: e.id,
    }));
    res.json({ bookings, weekTotal: null });
  } catch (e) {
    res.json({ bookings: [], weekTotal: null });
  }
});

// ============================================================
// GOOGLE OAUTH
// ============================================================
app.get("/auth/google", (req, res) => {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/auth/callback`
  );
  res.redirect(auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"],
  }));
});

app.get("/auth/callback", async (req, res) => {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/auth/callback`
  );
  const { tokens } = await auth.getToken(req.query.code);
  res.send(`<h2>✅ Refresh Token:</h2><textarea rows="4" cols="80">${tokens.refresh_token}</textarea>`);
});

// ============================================================
// TESTING
// ============================================================
app.post("/test", async (req, res) => {
  const { from = "admin-test", message } = req.body;
  if (!message) return res.status(400).json({ error: "Falta el campo message" });
  let botReply = null;
  try {
    await handleMessageWithSend(from, message, async (to, text) => { botReply = text; });
  } catch (e) {
    console.error("Test error:", e.message);
  }
  res.json({ status: "ok", reply: botReply || "Sin respuesta" });
});

app.post("/test/reset", (req, res) => {
  const { from = "admin-test" } = req.body;
  userSessions.delete(from);
  res.json({ status: "ok" });
});

// ============================================================
// WHATSAPP WEBHOOK
// ============================================================
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  try {
    res.sendStatus(200);
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    let text = "";

    if (message.type === "text") {
      text = message.text.body.trim();
    } else if (message.type === "interactive") {
      // Botones interactivos de WhatsApp
      text = message.interactive?.button_reply?.id ||
             message.interactive?.list_reply?.id ||
             message.interactive?.button_reply?.title || "";
    } else {
      return;
    }

    console.log(`📩 [${from}]: ${text}`);
    await handleMessage(from, text);
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
  }
});

// ============================================================
// LÓGICA PRINCIPAL
// ============================================================
async function handleMessage(from, text) {
  await handleMessageWithSend(from, text, sendWhatsAppMessage);
}

async function handleMessageWithSend(from, userMessage, sendFn) {
  const session = getSession(from);

  // 1. Clasificar intención con IA
  const classification = await classifyIntent(userMessage, session);
  console.log(`🔍 [${from}] Clasificación:`, classification);

  const { route, intent, nombre_detectado, propuesta_aceptada, propuesta_elegida,
          preferencia_horaria, human_handoff } = classification;

  // Guardar nombre si se detectó
  if (nombre_detectado && !session.clientName) {
    session.clientName = nombre_detectado;
  }

  // Human handoff
  if (human_handoff) {
    await sendFn(from, `Entendido 😊 Te pongo en contacto con el equipo de NLT.\n\n📞 640 355 446\n✉️ info@nextleveltraining.es\n\nEn horario de atención (L-V 10:30-13:00 y 17:00-20:00) te atenderán encantados.`);
    session.state = "idle";
    return;
  }

  // ── ROUTE 0: Nombre detectado ──────────────────────────────
  if (route === 0 && intent === "nombre_detectado") {
    session.state = "idle";
    // Si veníamos de un flujo de agendado, continuar
    if (session.state === "awaiting_name") {
      await continueBookingFlow(from, session, sendFn);
    } else {
      await sendFn(from, `¡Hola, ${session.clientName}! 👋 ¿En qué puedo ayudarte?\n\nPuedo ayudarte a:\n📅 Reservar una visita al centro\n❓ Responder tus dudas sobre horarios, precios, clases...`);
    }
    return;
  }

  // ── ROUTE 7: Saludo ────────────────────────────────────────
  if (route === 7) {
    const greeting = session.clientName
      ? `¡Hola de nuevo, ${session.clientName}! 👋`
      : `¡Hola! Bienvenido/a a *Next Level Training* 💪`;
    await sendFn(from, `${greeting}\n\n¿En qué puedo ayudarte?\n\n📅 Reservar visita al centro\n❓ Preguntas sobre horarios, precios o clases\n🗓️ Modificar o cancelar una visita`);
    if (!session.clientName) session.state = "idle";
    return;
  }

  // ── ROUTE 4: FAQ ───────────────────────────────────────────
  if (route === 4) {
    const answer = await answerFAQ(userMessage, sendFn, from);
    return;
  }

  // ── ROUTE 5: Despedida ─────────────────────────────────────
  if (route === 5) {
    const name = session.clientName ? `, ${session.clientName}` : "";
    await sendFn(from, `¡Hasta pronto${name}! 👋 Si necesitas algo más, aquí estaremos 💪`);
    session.state = "idle";
    return;
  }

  // ── ROUTE 3: Cancelar cita ─────────────────────────────────
  if (route === 3) {
    await handleCancellation(from, session, sendFn);
    return;
  }

  // ── ROUTE 1: Agendar / Modificar ──────────────────────────
  if (route === 1) {
    if (intent === "modificar_cita" && session.eventId) {
      // Cancelar la anterior y reiniciar flujo
      await cancelEventById(session.eventId);
      session.eventId = null;
      session.state = "idle";
      session.proposedSlots = [];
      session.chosenSlot = null;
      await sendFn(from, `He cancelado tu visita anterior 📅\n\nVamos a buscar un nuevo horario. ¿Tienes preferencia de *mañana* (10:30–13:00) o *tarde* (17:00–20:00)?`);
      session.state = "awaiting_preference";
    } else {
      await startBookingFlow(from, session, sendFn, preferencia_horaria);
    }
    return;
  }

  // ── ROUTE 2: Aceptar/Rechazar propuesta ───────────────────
  if (route === 2) {
    if (propuesta_aceptada === true && propuesta_elegida) {
      await confirmBooking(from, session, propuesta_elegida, sendFn);
    } else if (propuesta_aceptada === false) {
      session.retries = (session.retries || 0) + 1;
      if (session.retries >= 2) {
        await sendFn(from, `Entiendo que no te encajan estos horarios 😊\n\nPuedes contactarnos directamente:\n📞 640 355 446\n✉️ info@nextleveltraining.es\n\nEstaremos encantados de buscar una opción para ti.`);
        session.state = "idle";
      } else {
        session.proposedSlots = [];
        await sendFn(from, `Sin problema 😊 ¿Prefieres *mañana* (10:30–13:00) o *tarde* (17:00–20:00)?`);
        session.state = "awaiting_preference";
      }
    } else {
      // Respuesta ambigua mientras esperamos confirmación
      await sendFn(from, `Por favor, indícame qué opción prefieres: *1*, *2* o *3* 😊`);
    }
    return;
  }

  // ── Estado activo: continuación de flujo ──────────────────
  if (session.state === "awaiting_name") {
    // El usuario dice algo pero no es nombre claro
    if (userMessage.trim().split(" ").length <= 3) {
      session.clientName = userMessage.trim();
      await continueBookingFlow(from, session, sendFn);
    } else {
      await sendFn(from, `¿Cómo te llamas? Solo necesito tu nombre 😊`);
    }
    return;
  }

  if (session.state === "awaiting_preference") {
    // Detectar preferencia manual
    const msg = userMessage.toLowerCase();
    let pref = null;
    if (msg.includes("mañana") || msg.includes("manana") || msg.includes("morning")) pref = "mañana";
    if (msg.includes("tarde") || msg.includes("afternoon")) pref = "tarde";

    if (pref) {
      session.preference = pref;
      await proposeSlots(from, session, sendFn);
    } else {
      await sendFn(from, `¿Prefieres venir por la *mañana* (10:30–13:00) o por la *tarde* (17:00–20:00)? 😊`);
    }
    return;
  }

  if (session.state === "awaiting_confirmation") {
    // Intentar detectar número 1/2/3
    const match = userMessage.match(/\b([123])\b/);
    if (match) {
      await confirmBooking(from, session, parseInt(match[1]), sendFn);
    } else if (userMessage.toLowerCase().includes("ninguna") || userMessage.toLowerCase().includes("otra")) {
      session.proposedSlots = [];
      await sendFn(from, `Sin problema 😊 ¿Prefieres *mañana* o *tarde*?`);
      session.state = "awaiting_preference";
    } else {
      await sendFn(from, `Elige una opción: *1*, *2* o *3* 😊`);
    }
    return;
  }

  // ── Sin intención clara ────────────────────────────────────
  await sendFn(from, `Puedo ayudarte con:\n\n📅 *Reservar una visita* al centro\n❓ *Preguntas* sobre horarios, precios o clases\n🗓️ *Modificar o cancelar* tu visita\n\n¿Qué necesitas? 😊`);
}

// ============================================================
// FLUJO DE AGENDADO
// ============================================================
async function startBookingFlow(from, session, sendFn, preferencia_horaria = null) {
  if (!session.clientName) {
    session.state = "awaiting_name";
    await sendFn(from, `¡Genial! Vamos a reservar tu visita a Next Level Training 💪\n\n¿Cómo te llamas?`);
    return;
  }

  if (preferencia_horaria) {
    session.preference = preferencia_horaria;
    await proposeSlots(from, session, sendFn);
  } else {
    session.state = "awaiting_preference";
    await sendFn(from, `¡Perfecto, ${session.clientName}! ¿Prefieres venir por la *mañana* (10:30–13:00) o por la *tarde* (17:00–20:00)?`);
  }
}

async function continueBookingFlow(from, session, sendFn) {
  if (session.preference) {
    await proposeSlots(from, session, sendFn);
  } else {
    session.state = "awaiting_preference";
    await sendFn(from, `¡Encantado/a, ${session.clientName}! ¿Prefieres venir por la *mañana* (10:30–13:00) o por la *tarde* (17:00–20:00)?`);
  }
}

async function proposeSlots(from, session, sendFn) {
  const slots = await getAvailableSlots(session.preference);

  if (slots.length === 0) {
    await sendFn(from, `No tenemos huecos disponibles en los próximos días por la ${session.preference} 😔\n\nPrueba con la otra franja o contáctanos:\n📞 640 355 446`);
    session.state = "awaiting_preference";
    return;
  }

  // Proponer hasta 3 slots
  const proposed = slots.slice(0, 3);
  session.proposedSlots = proposed;
  session.state = "awaiting_confirmation";

  const lines = proposed.map((s, i) =>
    `*${i + 1}.* ${formatSlotLabel(s)}`
  ).join("\n");

  await sendFn(from, `Tengo estos huecos disponibles por la ${session.preference} 📅\n\n${lines}\n\nResponde con *1*, *2* o *3* para confirmar tu visita 😊`);
}

async function confirmBooking(from, session, choice, sendFn) {
  const slot = session.proposedSlots[choice - 1];
  if (!slot) {
    await sendFn(from, `Opción no válida. Elige *1*, *2* o *3* 😊`);
    return;
  }

  session.chosenSlot = slot;

  // Crear evento en Google Calendar
  const result = await createVisitEvent(slot, session.clientName, from);
  if (result.success) {
    session.eventId = result.eventId;
    session.state = "confirmed";

    const label = formatSlotLabel(slot);
    await sendFn(from,
      `✅ ¡Visita confirmada, ${session.clientName}!\n\n📅 ${label}\n📍 C/ Antonio Van de Pere Nº 25, Local 4, Valdemoro\n⏱️ Duración aprox. 30 min\n\nTe esperamos con ganas 💪 Si necesitas cambiar algo, solo escríbeme.`
    );
  } else {
    await sendFn(from, `Ha habido un problema al reservar 😔 Por favor contáctanos:\n📞 640 355 446`);
  }
}

// ============================================================
// CANCELACIÓN
// ============================================================
async function handleCancellation(from, session, sendFn) {
  if (!session.eventId) {
    await sendFn(from, `No tengo ninguna visita registrada para ti 🤔\n\nSi crees que es un error, contáctanos:\n📞 640 355 446`);
    return;
  }

  const result = await cancelEventById(session.eventId);
  if (result.success) {
    session.eventId = null;
    session.state = "idle";
    session.chosenSlot = null;
    await sendFn(from, `✅ Tu visita ha sido cancelada correctamente.\n\nCuando quieras volver a reservar, aquí estaré 😊`);
  } else {
    await sendFn(from, `No he podido cancelar la visita 😔 Por favor contáctanos:\n📞 640 355 446`);
  }
}

// ============================================================
// FAQ CON IA
// ============================================================
async function answerFAQ(userMessage, sendFn, from) {
  const session = getSession(from);

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Eres el asistente virtual oficial de Next Level Training (NLT), un centro de entrenamiento en Valdemoro (Madrid).

Responde de forma clara y amable a las preguntas del cliente usando ÚNICAMENTE la siguiente información:

${NLT_FAQ}

REGLAS:
- Responde en español, tono cercano y natural (WhatsApp).
- No inventes precios, horarios ni datos que no estén arriba.
- Si preguntan por precios de forma general, pregunta si quieren Grupos Reducidos, Entrenamiento Personal u Online.
- Si preguntan por el horario en PDF, comparte el enlace del PDF.
- Si preguntan por "horario" sin especificar, da el horario de clases (no el de visitas).
- Si preguntan dónde estáis / dirección / cómo llegar, da la dirección directamente.
- Si preguntan por clase de prueba, di que se ofrece durante la visita y que pueden reservar una.
- Después de responder, puedes añadir una invitación suave a visitar el centro si es relevante.
- No uses más de 3-4 párrafos. Sé directo.`
        },
        { role: "user", content: userMessage }
      ],
    });

    const reply = response.choices[0].message.content;
    await sendFn(from, reply);
  } catch (e) {
    console.error("FAQ error:", e.message);
    await sendFn(from, `Puedo ayudarte con información sobre NLT:\n\n📍 Dirección y contacto\n🕘 Horarios de clases\n💶 Precios y bonos\n🏋️ Tipos de entrenamientos\n\n¿Sobre qué quieres saber más?`);
  }
}

// ============================================================
// CLASIFICADOR DE INTENCIONES
// ============================================================
async function classifyIntent(userMessage, session) {
  const defaultResponse = {
    route: -1, intent: "sin_intencion_clara",
    nombre_detectado: null, propuesta_aceptada: null,
    propuesta_elegida: null, preferencia_horaria: null,
    human_handoff: false
  };

  try {
    const contextInfo = `
Estado actual del cliente: ${session.state}
Nombre guardado: ${session.clientName || "ninguno"}
Tiene cita confirmada: ${session.eventId ? "sí" : "no"}
Slots propuestos: ${session.proposedSlots.length > 0 ? session.proposedSlots.map((s,i)=>`${i+1}. ${formatSlotLabel(s)}`).join(", ") : "ninguno"}
`.trim();

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Eres un agente de clasificación. Analiza el mensaje y devuelve SOLO JSON válido.

CONTEXTO DEL CLIENTE:
${contextInfo}

FORMATO DE SALIDA (OBLIGATORIO, solo JSON):
{
  "route": 0,
  "intent": "",
  "nombre_detectado": null,
  "propuesta_aceptada": null,
  "propuesta_elegida": null,
  "preferencia_horaria": null,
  "human_handoff": false
}

RUTAS:
0 = El cliente da su nombre (solo si no hay nombre guardado o corrige el existente)
1 = Quiere agendar/modificar una visita
2 = Acepta o rechaza propuesta de horario
3 = Quiere cancelar su visita
4 = Pregunta frecuente (precios, horarios, servicios, dirección, clases...)
5 = Despedida
6 = Pide atención humana → human_handoff: true
7 = Saludo sin intención clara

INTENTS VÁLIDOS: agendar_cita, modificar_cita, cancelar_cita, pregunta_frecuente, saludo, despedida, transferencia_humana, sin_intencion_clara, nombre_detectado

REGLAS CLAVE:
- Si estado="awaiting_preference" y el mensaje es "mañana" o "tarde" → route=1, preferencia_horaria="mañana"/"tarde"
- Si estado="awaiting_confirmation" y el mensaje es "1","2","3" → route=2, propuesta_aceptada=true, propuesta_elegida=número
- Si propuesta_aceptada=true, propuesta_elegida NUNCA puede ser null
- Prioridad: humano > cancelar > aceptar/rechazar > agendar > FAQ > saludo
- No inventes datos ni infieras lo que no está claro`
        },
        { role: "user", content: userMessage }
      ],
    });

    const raw = response.choices[0].message.content.trim();
    const cleaned = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("Classify error:", e.message);
    return defaultResponse;
  }
}

// ============================================================
// GOOGLE CALENDAR - DISPONIBILIDAD
// ============================================================
async function getAvailableSlots(preference = null) {
  try {
    const cal = getCalendarClient();
    const slots = [];
    const today = new Date();

    // Buscar en los próximos 14 días
    for (let dayOffset = NLT_CONFIG.advanceDays; dayOffset <= 14; dayOffset++) {
      if (slots.length >= 6) break;

      const date = new Date(today);
      date.setDate(today.getDate() + dayOffset);
      const dayOfWeek = date.getDay();

      // Solo L-V
      if (!NLT_CONFIG.visitDays.includes(dayOfWeek)) continue;

      const dateISO = date.toISOString().split("T")[0];

      // Obtener eventos del día
      const dayStart = new Date(`${dateISO}T00:00:00`);
      const dayEnd = new Date(`${dateISO}T23:59:59`);

      const response = await cal.events.list({
        calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      const busySlots = (response.data.items || []).map(e => ({
        start: new Date(e.start.dateTime),
        end: new Date(e.end.dateTime),
      }));

      // Generar slots según preferencia
      const ranges = [];
      if (!preference || preference === "mañana") {
        ranges.push(NLT_CONFIG.visitHours.morning);
      }
      if (!preference || preference === "tarde") {
        ranges.push(NLT_CONFIG.visitHours.afternoon);
      }

      for (const range of ranges) {
        let t = toMinutes(range.start);
        const end = toMinutes(range.end);

        while (t + NLT_CONFIG.visitDuration <= end) {
          const slotStart = new Date(`${dateISO}T${fromMinutes(t)}:00`);
          const slotEnd = new Date(slotStart.getTime() + NLT_CONFIG.visitDuration * 60000);

          const isBusy = busySlots.some(b => slotStart < b.end && slotEnd > b.start);
          if (!isBusy) {
            slots.push({ date: dateISO, time: fromMinutes(t), dateObj: slotStart });
          }

          t += NLT_CONFIG.visitDuration;
          if (slots.length >= 6) break;
        }
      }
    }

    return slots;
  } catch (e) {
    console.error("Calendar availability error:", e.message);
    // Demo mode: devolver slots ficticios
    const demoDate = new Date();
    demoDate.setDate(demoDate.getDate() + NLT_CONFIG.advanceDays + 1);
    const iso = demoDate.toISOString().split("T")[0];
    return [
      { date: iso, time: "10:30", dateObj: new Date(`${iso}T10:30:00`) },
      { date: iso, time: "11:00", dateObj: new Date(`${iso}T11:00:00`) },
      { date: iso, time: "17:00", dateObj: new Date(`${iso}T17:00:00`) },
    ];
  }
}

// ============================================================
// GOOGLE CALENDAR - CREAR VISITA
// ============================================================
async function createVisitEvent(slot, clientName, from) {
  try {
    const startDateTime = new Date(`${slot.date}T${slot.time}:00`);
    const endDateTime = new Date(startDateTime.getTime() + NLT_CONFIG.visitDuration * 60000);

    const event = {
      summary: `Visita NLT - ${clientName || "Cliente"} (WA: ${from})`,
      description: `Visita informativa reservada por WhatsApp\nTeléfono: ${from}\nCliente: ${clientName || "Desconocido"}`,
      start: { dateTime: startDateTime.toISOString(), timeZone: NLT_CONFIG.timezone },
      end: { dateTime: endDateTime.toISOString(), timeZone: NLT_CONFIG.timezone },
    };

    const result = await getCalendarClient().events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      resource: event,
    });

    return { success: true, eventId: result.data.id };
  } catch (e) {
    console.error("Create event error:", e.message);
    return { success: true, eventId: "demo-" + Date.now(), note: "demo_mode" };
  }
}

// ============================================================
// GOOGLE CALENDAR - CANCELAR POR ID
// ============================================================
async function cancelEventById(eventId) {
  if (!eventId || eventId.startsWith("demo-")) {
    return { success: true };
  }
  try {
    await getCalendarClient().events.delete({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      eventId,
    });
    return { success: true };
  } catch (e) {
    console.error("Cancel event error:", e.message);
    return { success: false };
  }
}

// ============================================================
// WHATSAPP - ENVIAR MENSAJE
// ============================================================
async function sendWhatsAppMessage(to, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.log(`📤 [DEMO → ${to}]: ${text}`);
    return;
  }

  const resp = await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
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
    console.error(`WhatsApp API error: ${resp.status} ${await resp.text()}`);
  }
}

// ============================================================
// HELPERS
// ============================================================
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function fromMinutes(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function formatSlotLabel(slot) {
  const date = new Date(`${slot.date}T${slot.time}:00`);
  const dayName = date.toLocaleDateString("es-ES", { weekday: "long", timeZone: NLT_CONFIG.timezone });
  const dateStr = date.toLocaleDateString("es-ES", { day: "numeric", month: "long", timeZone: NLT_CONFIG.timezone });
  return `${dayName.charAt(0).toUpperCase() + dayName.slice(1)} ${dateStr} a las ${slot.time}h`;
}

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Next Level Training Bot en puerto ${PORT}`));
