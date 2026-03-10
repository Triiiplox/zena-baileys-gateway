/**
 * Zena Baileys Gateway
 * Microserviço leve (sem Chrome) que expõe a mesma API do WAHA.
 * Usa @whiskeysockets/baileys — conecta ao WhatsApp via WebSocket direto.
 *
 * Endpoints compatíveis com o provider waha.ts do app:
 *   GET  /api/version
 *   GET  /api/sessions/default
 *   POST /api/sessions/start          { name }
 *   POST /api/sessions/stop           { name }
 *   GET  /api/default/auth/qr?format=image
 *   POST /api/sendText                { session, chatId, text }
 *   GET  /health
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import express from 'express'
import qrcode from 'qrcode'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import pino from 'pino'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())

// ── Config ────────────────────────────────────────────────────────────────────
const API_KEY     = process.env.API_KEY ?? process.env.WHATSAPP_API_KEY ?? ''
const PORT        = Number(process.env.PORT ?? 3000)
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? ''
const AUTH_DIR    = process.env.AUTH_DIR ?? path.join(__dirname, '.wauth')

const logger = pino({ level: 'warn' })

fs.mkdirSync(AUTH_DIR, { recursive: true })

// ── Health (sem auth — necessário para Render health check) ───────────────────
app.get('/health', (_req, res) => res.json({ ok: true }))
app.get('/ping', (_req, res) => res.send('pong'))

// ── Auth middleware ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (!API_KEY) return next()
  const provided = req.headers['x-api-key'] ?? String(req.headers['authorization'] ?? '').replace('Bearer ', '')
  if (provided !== API_KEY) return res.status(401).json({ error: 'Unauthorized' })
  next()
})

// ── Session state ─────────────────────────────────────────────────────────────
let sock = null
let sessionStatus = 'STOPPED'  // STOPPED | STARTING | SCAN_QR_CODE | WORKING
let currentQR = null            // base64 data URL
let reconnectScheduled = false

// ── Core: start/stop ──────────────────────────────────────────────────────────
async function startSession() {
  if (sock) { try { sock.end() } catch {} sock = null }

  sessionStatus = 'STARTING'
  currentQR = null
  console.log('[baileys] Iniciando sessão...')

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    browser: ['Zena', 'Chrome', '10.0'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 30_000,
    keepAliveIntervalMs: 25_000,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      sessionStatus = 'SCAN_QR_CODE'
      currentQR = await qrcode.toDataURL(qr)
      console.log('[baileys] QR code gerado — aguardando scan')
    }

    if (connection === 'open') {
      sessionStatus = 'WORKING'
      currentQR = null
      reconnectScheduled = false
      console.log('[baileys] Conectado ao WhatsApp!')
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      const loggedOut = code === DisconnectReason.loggedOut

      console.log(`[baileys] Conexão fechada. Código: ${code}. LoggedOut: ${loggedOut}`)

      if (loggedOut) {
        // Apaga credenciais e para
        fs.rmSync(AUTH_DIR, { recursive: true, force: true })
        fs.mkdirSync(AUTH_DIR, { recursive: true })
        sessionStatus = 'STOPPED'
        sock = null
      } else if (!reconnectScheduled) {
        // Reconecta automaticamente
        reconnectScheduled = true
        sessionStatus = 'STARTING'
        setTimeout(async () => { reconnectScheduled = false; await startSession() }, 5000)
      }
    }
  })

  // Forward mensagens recebidas para o webhook do app
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (!WEBHOOK_URL || type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      try {
        await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({
            event: 'message',
            session: 'default',
            payload: {
              id: { id: msg.key.id },
              from: msg.key.remoteJid,
              body: msg.message?.conversation
                ?? msg.message?.extendedTextMessage?.text
                ?? '',
              timestamp: msg.messageTimestamp,
            },
          }),
        })
      } catch { /* webhook falhou silenciosamente */ }
    }
  })
}

async function stopSession() {
  if (sock) { try { sock.end() } catch {} sock = null }
  sessionStatus = 'STOPPED'
  currentQR = null
  console.log('[baileys] Sessão encerrada')
}

// ── API Routes (compatível com waha.ts) ───────────────────────────────────────

// Versão
app.get('/api/version', (_req, res) =>
  res.json({ version: '1.0.0', engine: 'BAILEYS', tier: 'CORE', browser: 'none' }))

// Status da sessão — GET /api/sessions/:session
app.get('/api/sessions/:session', (req, res) => {
  res.json({ name: req.params.session, status: sessionStatus, me: null })
})

// Start — POST /api/sessions/start
app.post('/api/sessions/start', async (_req, res) => {
  if (sessionStatus === 'WORKING') {
    return res.status(201).json({ name: 'default', status: 'WORKING' })
  }
  if (sessionStatus === 'SCAN_QR_CODE' || sessionStatus === 'STARTING') {
    return res.status(201).json({ name: 'default', status: sessionStatus })
  }
  startSession().catch((e) => console.error('[baileys] Erro ao iniciar:', e))
  res.status(201).json({ name: 'default', status: 'STARTING' })
})

// Stop — POST /api/sessions/stop
app.post('/api/sessions/stop', async (_req, res) => {
  await stopSession()
  res.json({ name: 'default', status: 'STOPPED' })
})

// QR Code — GET /api/:session/auth/qr
app.get('/api/:session/auth/qr', (req, res) => {
  if (sessionStatus !== 'SCAN_QR_CODE' || !currentQR) {
    return res.status(422).json({
      error: 'Session status is not as expected. Try again later or restart the session',
      session: req.params.session,
      status: sessionStatus,
      expected: ['SCAN_QR_CODE'],
    })
  }

  const format = req.query.format
  if (format === 'image') {
    const base64 = currentQR.replace(/^data:image\/\w+;base64,/, '')
    const buf = Buffer.from(base64, 'base64')
    res.set('Content-Type', 'image/png')
    return res.send(buf)
  }
  res.json({ value: currentQR })
})

// Enviar mensagem — POST /api/sendText
app.post('/api/sendText', async (req, res) => {
  const { chatId, text } = req.body
  if (!sock || sessionStatus !== 'WORKING') {
    return res.status(422).json({ error: 'Sessão não conectada' })
  }
  try {
    const jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`
    await sock.sendMessage(jid, { text })
    res.json({ ok: true })
  } catch (err) {
    console.error('[baileys] Erro ao enviar:', err)
    res.status(500).json({ error: String(err) })
  }
})

// ── Inicialização ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[baileys] Gateway rodando na porta ${PORT}`)

  // Auto-start se já tiver credenciais salvas
  const credFile = path.join(AUTH_DIR, 'creds.json')
  if (fs.existsSync(credFile)) {
    console.log('[baileys] Credenciais encontradas → conectando automaticamente...')
    startSession().catch((e) => console.error('[baileys] Erro no auto-start:', e))
  }
})
