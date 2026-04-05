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
  visitDuration: 30,
  advanceDays: 3,
  visitHours: {
    morning: { start: "10:30", end: "13:00" },
    afternoon: { start: "17:00", end: "20:00" },
  },
  visitDays: [1, 2, 3, 4, 5],
};

// ============================================================
// KNOWLEDGE BASE
// ============================================================
const NLT_FAQ = `
DIRECCIÓN: C/ Antonio Van de Pere Nº 25, Local 4 (Paseo Peatonal), CP 28342, Valdemoro (Madrid).
TELÉFONO: 640 355 446
EMAIL: info@nextleveltraining.es

HORARIO DE CLASES:
- Lunes a viernes: Mañanas 9:30-13:30 | Tardes 15:30-21:30
- Sábados: Solo mañana 9:30-13:30 (no hay clases por la tarde)
- Tipos: Funcional (Tono/Cardio/Hipertrofia), Core-Flex, Crosstraining, Espalda Sana

HORARIO DE VISITAS INFORMATIVAS (solo L-V):
- Mañana: 10:30-13:00 | Tarde: 17:00-20:00
- Duración aprox. 30 min

SERVICIOS: Grupos Reducidos, Entrenamiento Personal, Entrenamiento Online, Nutrición, Fisioterapia.

GRUPOS REDUCIDOS:
- Grupos de 2 a 7 personas, sesiones de 55-60 min
- Bono Basic: 8 ses 69€ | 12 ses 89€ | 16 ses 119€
- Bono Premium: 8 ses 72€ | 12 ses 92€ | 16 ses 122€
- Diferencia: Premium tiene preferencia en reserva via app
- Sesión puntual: 12,99€ | Sesiones caducan a 30 días, renovación automática

ENTRENAMIENTO PERSONAL:
- Individual o Dúo, 100% personalizado
- Bono 5: 180€ | Bono 10: 320€ | Dúo 5: 280€ | Dúo 10: 440€ | Puntual: 40€

ENTRENAMIENTO ONLINE:
- 2 días/sem: 19,99€ | 3 días/sem: 29,99€ | 4 días/sem: 39,99€

OTROS:
- Sin matrícula, sin permanencia, sin penalización por baja
- Se adapta a todos los niveles, sin prueba de nivel
- Solo entrenamientos dirigidos (no acceso libre)
- Clase de prueba: se ofrece durante la visita al centro
- App para reservar/cancelar, ver bonos y disponibilidad
- Fisioterapia y Nutrición disponibles
- Seguimiento personalizado en entrenamientos personales

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
      state: "idle",
      clientName: null,
      preference: null,
      proposedSlots: [],
      chosenSlot: null,
      eventId: null,
      retries: 0,
      lastFAQOfferedBooking: false,
      lastFAQTopic: null,
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
    await handleMessageWithSend(from, message, async (to, text, extra) => { botReply = text; });
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
      // Botones interactivos — capturar ID (op_1, op_2, op_3) o título
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

  // Clasificar intención
  const classification = await classifyIntent(userMessage, session);
  console.log(`🔍 [${from}] Route:${classification.route} Intent:${classification.intent}`);

  const { route, intent, nombre_detectado, propuesta_aceptada, propuesta_elegida,
          preferencia_horaria, human_handoff } = classification;

  // Guardar nombre si se detectó
  if (nombre_detectado && !session.clientName) {
    session.clientName = nombre_detectado;
  }

  // ── Human handoff ──────────────────────────────────────────
  if (human_handoff) {
    await sendFn(from,
      "Entendido 😊 Te pongo en contacto con el equipo.\n\n" +
      "📞 640 355 446\n" +
      "✉️ info@nextleveltraining.es\n\n" +
      "En horario L-V 10:30-13:00 y 17:00-20:00 te atenderán encantados."
    );
    session.state = "idle";
    return;
  }

  // ── ROUTE 0: Nombre ────────────────────────────────────────
  if (route === 0 && intent === "nombre_detectado") {
    const wasAwaitingName = session.state === "awaiting_name";
    if (wasAwaitingName) {
      await continueBookingFlow(from, session, sendFn);
    } else {
      session.state = "idle";
      await sendFn(from,
        `¡Hola, ${session.clientName}! 👋 ¿En qué puedo ayudarte?\n\n` +
        "📅 Reservar una visita al centro\n" +
        "❓ Preguntas sobre horarios, precios o clases"
      );
    }
    return;
  }

  // ── ROUTE 7: Saludo ────────────────────────────────────────
  if (route === 7) {
    const greeting = session.clientName
      ? `¡Hola de nuevo, ${session.clientName}! 👋`
      : "¡Hola! Bienvenido/a a *Next Level Training* 💪";
    await sendFn(from,
      `${greeting}\n\n` +
      "¿En qué puedo ayudarte?\n\n" +
      "📅 Reservar visita al centro\n" +
      "❓ Preguntas sobre horarios, precios o clases\n" +
      "🗓️ Modificar o cancelar una visita"
    );
    return;
  }

  // ── ROUTE 4: FAQ ───────────────────────────────────────────
  if (route === 4) {
    // Intención de visitar → arrancar reserva directamente
    const visitKeywords = ["ver las instalaciones", "conocer el centro", "visitar el",
                           "ver el gimnasio", "conocer el gimnasio", "pasar a ver",
                           "pasarme por", "ir a ver", "ver las insta"];
    if (visitKeywords.some(kw => userMessage.toLowerCase().includes(kw))) {
      await startBookingFlow(from, session, sendFn, preferencia_horaria);
      return;
    }
    await answerFAQ(userMessage, sendFn, from);
    return;
  }

  // ── ROUTE 5: Despedida ─────────────────────────────────────
  if (route === 5) {
    const name = session.clientName ? `, ${session.clientName}` : "";
    await sendFn(from, `¡Hasta pronto${name}! 👋 Si necesitas algo, aquí estaré 💪`);
    session.state = "idle";
    return;
  }

  // ── ROUTE 3: Cancelar ─────────────────────────────────────
  if (route === 3) {
    await handleCancellation(from, session, sendFn);
    return;
  }

  // ── ROUTE 1: Agendar / Modificar ──────────────────────────
  if (route === 1) {
    if (intent === "modificar_cita" && session.eventId) {
      await cancelEventById(session.eventId);
      session.eventId = null;
      session.state = "idle";
      session.proposedSlots = [];
      session.chosenSlot = null;
      await sendFn(from,
        "He cancelado tu visita anterior 📅\n\n" +
        "Vamos a buscar un nuevo horario. ¿Prefieres *mañana* (10:30-13:00) o *tarde* (17:00-20:00)?"
      );
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
        await sendFn(from,
          "Entiendo que no te encajan 😊\n\n" +
          "Contáctanos directamente:\n" +
          "📞 640 355 446\n" +
          "✉️ info@nextleveltraining.es"
        );
        session.state = "idle";
      } else {
        session.proposedSlots = [];
        await sendFn(from, "Sin problema 😊 ¿Prefieres *mañana* (10:30-13:00) o *tarde* (17:00-20:00)?");
        session.state = "awaiting_preference";
      }
    } else {
      await sendFn(from, "Por favor, pulsa uno de los botones para confirmar tu visita 😊");
    }
    return;
  }

  // ── Estado activo: awaiting_name ──────────────────────────
  if (session.state === "awaiting_name") {
    const words = userMessage.trim().split(/\s+/);
    if (words.length >= 1 && words.length <= 4) {
      session.clientName = userMessage.trim();
      await continueBookingFlow(from, session, sendFn);
    } else {
      await sendFn(from, "¿Cómo te llamas? Solo necesito tu nombre 😊");
    }
    return;
  }

  // ── Estado activo: awaiting_preference ────────────────────
  if (session.state === "awaiting_preference") {
    const msg = userMessage.toLowerCase();
    let pref = null;
    if (msg.includes("ma") && !msg.includes("tarde")) pref = "mañana";
    if (msg.includes("tarde")) pref = "tarde";
    if (pref) {
      session.preference = pref;
      await proposeSlots(from, session, sendFn);
    } else {
      await sendFn(from, "¿Prefieres venir por la *mañana* (10:30-13:00) o por la *tarde* (17:00-20:00)? 😊");
    }
    return;
  }

  // ── Estado activo: awaiting_confirmation ──────────────────
  if (session.state === "awaiting_confirmation") {
    // Detectar op_1/op_2/op_3 (botones) o número en texto
    const btnMatch = userMessage.match(/^op_([123])$/i);
    const numMatch = userMessage.match(/\b([123])\b/);
    const choice = btnMatch ? parseInt(btnMatch[1]) : (numMatch ? parseInt(numMatch[1]) : null);

    if (choice) {
      await confirmBooking(from, session, choice, sendFn);
    } else if (userMessage.toLowerCase().includes("ninguna") || userMessage.toLowerCase().includes("otra")) {
      session.proposedSlots = [];
      await sendFn(from, "Sin problema 😊 ¿Prefieres *mañana* o *tarde*?");
      session.state = "awaiting_preference";
    } else {
      await sendFn(from, "Por favor, pulsa uno de los botones para elegir tu horario 😊");
    }
    return;
  }

  // ── "Sí" tras oferta de reserva del FAQ ───────────────────
  if (session.lastFAQOfferedBooking) {
    session.lastFAQOfferedBooking = false;
    const affirmative = ["si", "sí", "vale", "ok", "claro", "por favor", "quiero", "me apunto", "reserva", "adelante"];
    if (affirmative.some(a => userMessage.toLowerCase().includes(a))) {
      await startBookingFlow(from, session, sendFn, preferencia_horaria);
      return;
    }
  }

  // ── Sin intención clara ────────────────────────────────────
  await sendFn(from,
    "Puedo ayudarte con:\n\n" +
    "📅 *Reservar una visita* al centro\n" +
    "❓ *Preguntas* sobre horarios, precios o clases\n" +
    "🗓️ *Modificar o cancelar* tu visita\n\n" +
    "¿Qué necesitas? 😊"
  );
}

// ============================================================
// FLUJO DE AGENDADO
// ============================================================
async function startBookingFlow(from, session, sendFn, preferencia_horaria = null) {
  session.lastFAQOfferedBooking = false;

  if (!session.clientName) {
    session.state = "awaiting_name";
    await sendFn(from,
      "¡Genial! Vamos a reservar tu visita a *Next Level Training* 💪\n\n" +
      "¿Cómo te llamas?"
    );
    return;
  }

  if (preferencia_horaria) {
    session.preference = preferencia_horaria;
    await proposeSlots(from, session, sendFn);
  } else {
    session.state = "awaiting_preference";
    await sendFn(from,
      `¡Perfecto, ${session.clientName}! 🙌\n\n` +
      "¿Prefieres venir por la *mañana* (10:30-13:00) o por la *tarde* (17:00-20:00)?"
    );
  }
}

async function continueBookingFlow(from, session, sendFn) {
  if (session.preference) {
    await proposeSlots(from, session, sendFn);
  } else {
    session.state = "awaiting_preference";
    await sendFn(from,
      `¡Encantado/a, ${session.clientName}! 🙌\n\n` +
      "¿Prefieres venir por la *mañana* (10:30-13:00) o por la *tarde* (17:00-20:00)?"
    );
  }
}

async function proposeSlots(from, session, sendFn) {
  const slots = await getAvailableSlots(session.preference);

  if (slots.length === 0) {
    await sendFn(from,
      `No hay huecos disponibles por la ${session.preference} en los próximos días 😔\n\n` +
      "¿Pruebo con la otra franja horaria?"
    );
    session.state = "awaiting_preference";
    return;
  }

  const proposed = slots.slice(0, 3);
  session.proposedSlots = proposed;
  session.state = "awaiting_confirmation";
  session.retries = 0;

  // Enviar con botones interactivos de WhatsApp
  const buttons = proposed.map((s, i) => ({
    type: "reply",
    reply: {
      id: `op_${i + 1}`,
      title: formatSlotButton(s),   // máx 20 chars
    },
  }));

  const bodyText =
    `Estos son los huecos disponibles por la ${session.preference} 📅\n\n` +
    proposed.map((s, i) => `*${i + 1}.* ${formatSlotLabel(s)}`).join("\n") +
    "\n\nElige el que mejor te venga 👇";

  await sendWhatsAppButtons(from, bodyText, buttons, sendFn);
}

async function confirmBooking(from, session, choice, sendFn) {
  const slot = session.proposedSlots[choice - 1];
  if (!slot) {
    await sendFn(from, "Opción no válida. Por favor elige una de las opciones 😊");
    return;
  }

  session.chosenSlot = slot;
  const result = await createVisitEvent(slot, session.clientName, from);

  if (result.success) {
    session.eventId = result.eventId;
    session.state = "confirmed";
    await sendFn(from,
      `✅ ¡Visita confirmada, ${session.clientName}!\n\n` +
      `📅 ${formatSlotLabel(slot)}\n` +
      "📍 C/ Antonio Van de Pere Nº 25, Local 4 — Valdemoro\n" +
      "⏱️ Duración aprox. 30 min\n\n" +
      "¡Te esperamos con ganas! 💪 Si necesitas cambiar algo, solo escríbeme."
    );
  } else {
    await sendFn(from,
      "Ha habido un problema al reservar 😔\n\n" +
      "Por favor contáctanos:\n📞 640 355 446"
    );
  }
}

// ============================================================
// CANCELACIÓN
// ============================================================
async function handleCancellation(from, session, sendFn) {
  if (!session.eventId) {
    await sendFn(from,
      "No tengo ninguna visita registrada para ti 🤔\n\n" +
      "Si crees que es un error:\n📞 640 355 446"
    );
    return;
  }

  const result = await cancelEventById(session.eventId);
  if (result.success) {
    session.eventId = null;
    session.state = "idle";
    session.chosenSlot = null;
    await sendFn(from,
      "✅ Tu visita ha sido cancelada correctamente.\n\n" +
      "Cuando quieras reservar de nuevo, aquí estaré 😊"
    );
  } else {
    await sendFn(from,
      "No he podido cancelar la visita 😔\n\n" +
      "Por favor contáctanos:\n📞 640 355 446"
    );
  }
}

// ============================================================
// FAQ CON IA — respuesta corta + oferta de más detalle
// ============================================================
async function answerFAQ(userMessage, sendFn, from) {
  const session = getSession(from);

  // Temas donde al final ofrecemos reservar visita
  const bookingHintTopics = [
    "clase de prueba", "prueba", "precio", "bono", "coste", "cuanto",
    "servicios", "entrenamiento personal", "grupos reducidos", "grupos",
    "clases", "horario", "tipos de clase",
  ];
  const msgLower = userMessage.toLowerCase();
  const shouldOfferBooking = bookingHintTopics.some(kw => msgLower.includes(kw));

  const offerLine = shouldOfferBooking
    ? "\n\nAl terminar pregunta: '¿Quieres que te reserve una visita para verlo en persona? 😊'"
    : "";

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Eres el asistente de WhatsApp de Next Level Training (NLT).\n\n" +
            "INFORMACIÓN DISPONIBLE:\n" + NLT_FAQ + "\n\n" +
            "REGLAS DE FORMATO (MUY IMPORTANTES):\n" +
            "- Máximo 3-4 líneas en tu primera respuesta. Sé muy conciso.\n" +
            "- Usa emojis como separadores visuales, no markdown con ** ni -.\n" +
            "- Al final de tu respuesta SIEMPRE añade: '¿Quieres más detalles sobre algo concreto? 😊'\n" +
            "- EXCEPCIÓN: si preguntan dirección, solo da la dirección sin más.\n" +
            "- Si piden precios en general, pregunta solo entre: Grupos, Personal u Online.\n" +
            "- Si piden horario en PDF, comparte el enlace.\n" +
            "- Clase de prueba: se ofrece durante la visita. NO digas que llamen.\n" +
            "- Nunca inventes datos que no estén en la información.\n" +
            "- NO sugieras llamar para reservar visita, el bot lo gestiona." +
            offerLine,
        },
        { role: "user", content: userMessage },
      ],
    });

    const reply = response.choices[0].message.content;
    await sendFn(from, reply);

    if (shouldOfferBooking) {
      session.lastFAQOfferedBooking = true;
    }

  } catch (e) {
    console.error("FAQ error:", e.message);
    await sendFn(from,
      "Puedo ayudarte con:\n\n" +
      "📍 Dirección y contacto\n" +
      "🕘 Horarios de clases\n" +
      "💶 Precios y bonos\n" +
      "🏋️ Tipos de entrenamientos\n\n" +
      "¿Sobre qué quieres saber más?"
    );
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
    human_handoff: false,
  };

  try {
    const contextInfo =
      `Estado: ${session.state}\n` +
      `Nombre guardado: ${session.clientName || "ninguno"}\n` +
      `Tiene cita: ${session.eventId ? "sí" : "no"}\n` +
      `Slots propuestos: ${session.proposedSlots.length > 0
        ? session.proposedSlots.map((s, i) => `${i + 1}. ${formatSlotLabel(s)}`).join(", ")
        : "ninguno"}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Eres un clasificador de intenciones. Devuelve SOLO JSON válido, sin texto adicional.\n\n" +
            "CONTEXTO DEL CLIENTE:\n" + contextInfo + "\n\n" +
            "FORMATO DE SALIDA:\n" +
            '{"route":0,"intent":"","nombre_detectado":null,"propuesta_aceptada":null,"propuesta_elegida":null,"preferencia_horaria":null,"human_handoff":false}\n\n' +
            "RUTAS:\n" +
            "0 = El cliente da su nombre (solo si no hay nombre guardado o lo corrige)\n" +
            "1 = Quiere agendar o modificar una visita\n" +
            "2 = Acepta o rechaza propuesta de horario (también si mensaje es op_1/op_2/op_3)\n" +
            "3 = Quiere cancelar su visita\n" +
            "4 = Pregunta frecuente (precios, horarios, servicios, dirección, clases...)\n" +
            "5 = Despedida\n" +
            "6 = Pide atención humana → human_handoff: true\n" +
            "7 = Saludo sin intención clara\n\n" +
            "INTENTS VÁLIDOS: agendar_cita, modificar_cita, cancelar_cita, pregunta_frecuente, saludo, despedida, transferencia_humana, sin_intencion_clara, nombre_detectado\n\n" +
            "REGLAS:\n" +
            "- op_1/op_2/op_3 → route=2, propuesta_aceptada=true, propuesta_elegida=1/2/3\n" +
            "- Si estado=awaiting_preference y mensaje es mañana/tarde → route=1, preferencia_horaria=mañana/tarde\n" +
            "- Si estado=awaiting_confirmation y mensaje es 1/2/3 → route=2, propuesta_aceptada=true, propuesta_elegida=número\n" +
            "- Si propuesta_aceptada=true, propuesta_elegida NUNCA puede ser null\n" +
            "- preferencia_horaria: solo 'mañana', 'tarde' o null\n" +
            "- Prioridad: humano > cancelar > aceptar/rechazar > agendar > FAQ > saludo",
        },
        { role: "user", content: userMessage },
      ],
    });

    const raw = response.choices[0].message.content.trim().replace(/```json|```/g, "").trim();
    return JSON.parse(raw);
  } catch (e) {
    console.error("Classify error:", e.message);
    return defaultResponse;
  }
}

// ============================================================
// GOOGLE CALENDAR — DISPONIBILIDAD
// ============================================================
async function getAvailableSlots(preference = null) {
  try {
    const cal = getCalendarClient();
    const slots = [];
    const today = new Date();

    for (let dayOffset = NLT_CONFIG.advanceDays; dayOffset <= 21; dayOffset++) {
      if (slots.length >= 6) break;

      const date = new Date(today);
      date.setDate(today.getDate() + dayOffset);
      const dayOfWeek = date.getDay();

      if (!NLT_CONFIG.visitDays.includes(dayOfWeek)) continue;

      const dateISO = date.toISOString().split("T")[0];
      const response = await cal.events.list({
        calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
        timeMin: new Date(`${dateISO}T00:00:00`).toISOString(),
        timeMax: new Date(`${dateISO}T23:59:59`).toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      const busySlots = (response.data.items || []).map(e => ({
        start: new Date(e.start.dateTime),
        end: new Date(e.end.dateTime),
      }));

      const ranges = [];
      if (!preference || preference === "mañana") ranges.push(NLT_CONFIG.visitHours.morning);
      if (!preference || preference === "tarde") ranges.push(NLT_CONFIG.visitHours.afternoon);

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
    // Demo mode
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
// GOOGLE CALENDAR — CREAR VISITA
// ============================================================
async function createVisitEvent(slot, clientName, from) {
  try {
    const startDateTime = new Date(`${slot.date}T${slot.time}:00`);
    const endDateTime = new Date(startDateTime.getTime() + NLT_CONFIG.visitDuration * 60000);
    const result = await getCalendarClient().events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      resource: {
        summary: `Visita NLT - ${clientName || "Cliente"} (WA: ${from})`,
        description: `Visita informativa por WhatsApp\nTeléfono: ${from}`,
        start: { dateTime: startDateTime.toISOString(), timeZone: NLT_CONFIG.timezone },
        end: { dateTime: endDateTime.toISOString(), timeZone: NLT_CONFIG.timezone },
      },
    });
    return { success: true, eventId: result.data.id };
  } catch (e) {
    console.error("Create event error:", e.message);
    return { success: true, eventId: "demo-" + Date.now() };
  }
}

// ============================================================
// GOOGLE CALENDAR — CANCELAR
// ============================================================
async function cancelEventById(eventId) {
  if (!eventId || eventId.startsWith("demo-")) return { success: true };
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
// WHATSAPP — ENVIAR MENSAJE DE TEXTO
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
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!resp.ok) console.error(`WhatsApp API error: ${resp.status} ${await resp.text()}`);
}

// ============================================================
// WHATSAPP — ENVIAR BOTONES INTERACTIVOS
// Fallback a texto si no hay credenciales (modo test)
// ============================================================
async function sendWhatsAppButtons(to, bodyText, buttons, sendFn) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  // En modo test/demo: enviar como texto plano
  if (!token || !phoneNumberId) {
    await sendFn(to, bodyText);
    return;
  }

  const resp = await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: { buttons },
      },
    }),
  });

  if (!resp.ok) {
    console.error(`WhatsApp Buttons API error: ${resp.status} ${await resp.text()}`);
    // Fallback a texto si falla
    await sendFn(to, bodyText);
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
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

// Formato largo para el cuerpo del mensaje
function formatSlotLabel(slot) {
  const date = new Date(`${slot.date}T${slot.time}:00`);
  const dayName = date.toLocaleDateString("es-ES", { weekday: "long", timeZone: NLT_CONFIG.timezone });
  const dateStr = date.toLocaleDateString("es-ES", { day: "numeric", month: "long", timeZone: NLT_CONFIG.timezone });
  return `${dayName.charAt(0).toUpperCase() + dayName.slice(1)} ${dateStr} a las ${slot.time}h`;
}

// Formato corto para botones (máx 20 chars)
function formatSlotButton(slot) {
  const date = new Date(`${slot.date}T${slot.time}:00`);
  const day = date.toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short", timeZone: NLT_CONFIG.timezone });
  return `${day} ${slot.time}`.slice(0, 20);
}

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Next Level Training Bot en puerto ${PORT}`));
