import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const DOCTOR_PHONE    = process.env.DOCTOR_PHONE; // e.g. "18091234567" (no + or spaces)

// In-memory conversation store: phoneNumber -> messages[]
// Fine for low-volume use; restart clears all sessions (patients just start over)
const conversations = new Map();

const SYSTEM_PROMPT = `Eres Valentina, la recepcionista virtual del consultorio de la Dra. Paola Hatton, Neumóloga Pediatra en Santo Domingo, República Dominicana.

Tu único objetivo es ayudar a los pacientes a agendar una cita. Para completar el agendamiento necesitas obtener los siguientes datos, uno por uno:
1. Nombre completo del paciente (si es un niño, el nombre del niño)
2. Edad del paciente
3. Motivo de la consulta (síntomas, diagnóstico previo, etc.)
4. Número de teléfono de contacto
5. Día y hora preferida para la cita

Cuando tengas TODOS los datos y el paciente haya confirmado que son correctos, incluye al FINAL de tu mensaje exactamente este bloque (con los marcadores):
<<<CITA>>>
{
  "nombre": "nombre del paciente",
  "edad": "edad",
  "motivo": "motivo",
  "telefono": "teléfono de contacto",
  "fecha_hora": "preferencia de día y hora"
}
<<<FIN>>>

Reglas importantes:
- Responde SIEMPRE en español, de forma cálida, breve y profesional
- Mantén cada respuesta en máximo 2-3 oraciones cortas (WhatsApp, no un email)
- Si alguien menciona una emergencia respiratoria, diles urgentemente que vayan al centro de urgencias más cercano — el consultorio NO atiende urgencias vitales
- No inventes horarios disponibles; di que la Dra. confirmará la disponibilidad
- Si el usuario escribe "reiniciar" o "nueva cita", empieza el proceso desde cero amablemente
- Saluda solo en el primer mensaje de cada conversación`;

// ── Webhook verification (GET) ────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── Receive messages (POST) ───────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately — Meta requires fast response

  try {
    const body    = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const from = message.from;           // Patient's phone number
    const text = message.text.body.trim();

    console.log(`[${from}] Patient: ${text}`);

    // Handle "reiniciar" keyword
    if (/^(reiniciar|nueva cita|restart)/i.test(text)) {
      conversations.delete(from);
    }

    // Get or initialize conversation history
    if (!conversations.has(from)) {
      conversations.set(from, []);
    }
    const history = conversations.get(from);
    history.push({ role: 'user', content: text });

    // Ask Claude
    const response = await anthropic.messages.create({
      model:      'claude-opus-4-8',
      max_tokens: 400,
      system:     SYSTEM_PROMPT,
      messages:   history,
    });

    const reply = response.content[0].text;
    history.push({ role: 'assistant', content: reply });
    console.log(`[${from}] Bot: ${reply.slice(0, 120)}...`);

    // Check if appointment data is complete
    const match = reply.match(/<<<CITA>>>([\s\S]*?)<<<FIN>>>/);
    if (match) {
      try {
        const cita = JSON.parse(match[1].trim());

        // Notify the doctor via WhatsApp
        const doctorMsg =
          `🏥 *Nueva solicitud de cita*\n\n` +
          `👤 *Paciente:* ${cita.nombre}\n` +
          `🎂 *Edad:* ${cita.edad}\n` +
          `📋 *Motivo:* ${cita.motivo}\n` +
          `📱 *Tel. contacto:* ${cita.telefono}\n` +
          `📅 *Preferencia:* ${cita.fecha_hora}\n` +
          `💬 *WhatsApp paciente:* wa.me/${from}`;

        await sendWhatsApp(DOCTOR_PHONE, doctorMsg);
        console.log(`Appointment summary sent to doctor (${DOCTOR_PHONE})`);

        // Clear conversation so next message starts fresh
        conversations.delete(from);
      } catch (e) {
        console.error('Failed to parse appointment JSON:', e.message);
      }
    }

    // Send reply to patient, stripping the internal JSON block
    const cleanReply = reply.replace(/<<<CITA>>>[\s\S]*?<<<FIN>>>/g, '').trim();
    await sendWhatsApp(from, cleanReply);

  } catch (err) {
    console.error('Error handling message:', err.message);
  }
});

// ── Send a WhatsApp text message ──────────────────────────────────────────────
async function sendWhatsApp(to, text) {
  const url = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`WhatsApp send error (${res.status}):`, err);
  }
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.send('WhatsApp Agent running ✓'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`WhatsApp agent listening on port ${PORT}`));
