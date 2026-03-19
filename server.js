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
let WEBHOOK_URL = process.env.WEBHOOK_URL ?? ''
const DEFAULT_AUTH_DIR = path.join(__dirname, '.wauth')
const REQUESTED_AUTH_DIR = process.env.AUTH_DIR ?? DEFAULT_AUTH_DIR

const logger = pino({ level: 'warn' })

function ensureWritableDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
  const probeFile = path.join(dirPath, '.zena-write-test')
  fs.writeFileSync(probeFile, String(Date.now()))
  fs.rmSync(probeFile, { force: true })
}

function resolveAuthDir() {
  try {
    ensureWritableDir(REQUESTED_AUTH_DIR)
    return { effectiveAuthDir: REQUESTED_AUTH_DIR, usedFallback: false }
  } catch (err) {
    if (REQUESTED_AUTH_DIR !== DEFAULT_AUTH_DIR) {
      console.warn(`[baileys] AUTH_DIR não gravável (${REQUESTED_AUTH_DIR}). Usando fallback local ${DEFAULT_AUTH_DIR}.`, err)
      ensureWritableDir(DEFAULT_AUTH_DIR)
      return { effectiveAuthDir: DEFAULT_AUTH_DIR, usedFallback: true }
    }
    throw err
  }
}

const { effectiveAuthDir: AUTH_DIR, usedFallback: authDirFallback } = resolveAuthDir()

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

// ── Session state (multi-session) ─────────────────────────────────────────────
const sessions = new Map() // name -> { name, sock, status, currentQR, reconnectScheduled, authDir }

function normalizeSessionName(value) {
  const raw = String(value ?? 'default').trim()
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
  return safe || 'default'
}

function resolveSessionAuthDir(sessionName) {
  // Compatibilidade com sessão legada (default no diretório raiz).
  return sessionName === 'default' ? AUTH_DIR : path.join(AUTH_DIR, sessionName)
}

function getSessionState(sessionName) {
  const normalized = normalizeSessionName(sessionName)
  let state = sessions.get(normalized)
  if (!state) {
    state = {
      name: normalized,
      sock: null,
      status: 'STOPPED',       // STOPPED | STARTING | SCAN_QR_CODE | WORKING
      currentQR: null,
      reconnectScheduled: false,
      authDir: resolveSessionAuthDir(normalized),
    }
    sessions.set(normalized, state)
  }
  return state
}

function extractBodyAndMentions(message) {
  const nestedMessage = message?.ephemeralMessage?.message
    ?? message?.viewOnceMessage?.message
    ?? message?.viewOnceMessageV2?.message
    ?? message?.viewOnceMessageV2Extension?.message
    ?? message

  const body = nestedMessage?.conversation
    ?? nestedMessage?.extendedTextMessage?.text
    ?? nestedMessage?.imageMessage?.caption
    ?? nestedMessage?.videoMessage?.caption
    ?? nestedMessage?.documentWithCaptionMessage?.message?.documentMessage?.caption
    ?? ''

  const contextInfo = nestedMessage?.extendedTextMessage?.contextInfo
    ?? nestedMessage?.imageMessage?.contextInfo
    ?? nestedMessage?.videoMessage?.contextInfo
    ?? null

  const mentions = Array.isArray(contextInfo?.mentionedJid) ? contextInfo.mentionedJid : []
  const messageType = nestedMessage ? Object.keys(nestedMessage)[0] ?? 'unknown' : 'unknown'

  return { body, mentions, contextInfo, messageType, hasMessageContent: Boolean(message) }
}

async function postWebhookWithRetry(payload) {
  if (!WEBHOOK_URL) return
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8_000)
    try {
      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(API_KEY ? { 'x-api-key': API_KEY } : {}) },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      if (response.ok) return
      console.warn(`[baileys] webhook ${response.status} on attempt ${attempt}`)
    } catch (err) {
      console.warn('[baileys] webhook send failed', { attempt, error: String(err) })
    } finally {
      clearTimeout(timeout)
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 350 * attempt))
    }
  }
}

// ── Core: start/stop ──────────────────────────────────────────────────────────
async function startSession(name = 'default') {
  const session = getSessionState(name)
  if (session.sock) { try { session.sock.end() } catch {} session.sock = null }

  ensureWritableDir(session.authDir)
  session.status = 'STARTING'
  session.currentQR = null
  console.log(`[baileys] Iniciando sessão ${session.name}...`)

  const { state, saveCreds } = await useMultiFileAuthState(session.authDir)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
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
  session.sock = sock

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds()
    } catch (err) {
      console.error('[baileys] saveCreds failed', err)
    }
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      session.status = 'SCAN_QR_CODE'
      session.currentQR = await qrcode.toDataURL(qr)
      console.log(`[baileys] QR code gerado (${session.name}) — aguardando scan`)
    }

    if (connection === 'open') {
      session.status = 'WORKING'
      session.currentQR = null
      session.reconnectScheduled = false
      console.log(`[baileys] Conectado ao WhatsApp (${session.name})`)
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      const loggedOut = code === DisconnectReason.loggedOut

      console.log(`[baileys] Conexão fechada (${session.name}). Código: ${code}. LoggedOut: ${loggedOut}`)

      if (loggedOut) {
        // Apaga credenciais e para
        wipeAuthState(session.name)
        session.status = 'STOPPED'
        session.sock = null
      } else if (!session.reconnectScheduled) {
        // Reconecta automaticamente
        session.reconnectScheduled = true
        session.status = 'STARTING'
        setTimeout(async () => {
          session.reconnectScheduled = false
          await startSession(session.name)
        }, 5000)
      }
    }
  })

  // Forward mensagens recebidas para o webhook do app
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (!WEBHOOK_URL || (type !== 'notify' && type !== 'append')) return
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      const { body, mentions, contextInfo, messageType, hasMessageContent } = extractBodyAndMentions(msg.message)
      try {
        await postWebhookWithRetry({
          event: 'message',
          session: session.name,
          payload: {
            id: { id: msg.key.id },
            from: msg.key.remoteJid,
            participant: msg.key.participant ?? null,
            body,
            timestamp: msg.messageTimestamp,
            mentions,
            contextInfo,
            messageMetadata: {
              messageType,
              hasMessageContent,
            },
          },
        })
      } catch { /* webhook falhou silenciosamente */ }
    }
  })
}

async function stopSession(name = 'default') {
  const session = getSessionState(name)
  if (session.sock) { try { session.sock.end() } catch {} session.sock = null }
  session.status = 'STOPPED'
  session.currentQR = null
  console.log(`[baileys] Sessão encerrada (${session.name})`)
}

function wipeAuthState(name = 'default') {
  const session = getSessionState(name)
  if (session.name === 'default') {
    // Mantém subpastas de outras sessões familiares.
    for (const entry of fs.readdirSync(AUTH_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) continue
      fs.rmSync(path.join(AUTH_DIR, entry.name), { force: true })
    }
    ensureWritableDir(AUTH_DIR)
    return
  }
  fs.rmSync(session.authDir, { recursive: true, force: true })
  ensureWritableDir(session.authDir)
}

// ── API Routes (compatível com waha.ts) ───────────────────────────────────────

// Diagnóstico — GET /api/diagnostic
app.get('/api/diagnostic', (_req, res) => {
  const sessionList = []
  for (const [name, s] of sessions.entries()) {
    sessionList.push({ name, status: s.status, hasSocket: Boolean(s.sock) })
  }
  res.json({
    version: '1.1.0',
    engine: 'BAILEYS',
    webhookUrl: WEBHOOK_URL || '(not configured)',
    sessions: sessionList,
    authDir: AUTH_DIR,
  })
})

// Configurar webhook em runtime — POST /api/webhook/configure { url }
app.post('/api/webhook/configure', (req, res) => {
  const url = String(req.body?.url ?? '').trim()
  if (!url) return res.status(400).json({ error: 'url is required' })
  WEBHOOK_URL = url
  console.log(`[baileys] WEBHOOK_URL atualizado para: ${url}`)
  res.json({ ok: true, webhookUrl: WEBHOOK_URL })
})

// Versão
app.get('/api/version', (_req, res) =>
  res.json({ version: '1.1.0', engine: 'BAILEYS', tier: 'CORE', browser: 'none' }))

// Status da sessão — GET /api/sessions/:session
app.get('/api/sessions/:session', (req, res) => {
  const name = normalizeSessionName(req.params.session)
  const session = getSessionState(name)
  res.json({ name, status: session.status, me: null })
})

// Start — POST /api/sessions/start
app.post('/api/sessions/start', async (req, res) => {
  const name = normalizeSessionName(req.body?.name ?? req.body?.session ?? 'default')
  const session = getSessionState(name)
  if (session.status === 'WORKING') {
    return res.status(201).json({ name, status: 'WORKING' })
  }
  if (session.status === 'SCAN_QR_CODE' || session.status === 'STARTING') {
    return res.status(201).json({ name, status: session.status })
  }
  startSession(name).catch((e) => console.error('[baileys] Erro ao iniciar:', e))
  res.status(201).json({ name, status: 'STARTING' })
})

// Stop — POST /api/sessions/stop
app.post('/api/sessions/stop', async (req, res) => {
  const name = normalizeSessionName(req.body?.name ?? req.body?.session ?? 'default')
  await stopSession(name)
  res.json({ name, status: 'STOPPED' })
})

// Reparo remoto de sessão: limpa auth e para sessão
app.post('/api/sessions/wipe-auth', async (req, res) => {
  const name = normalizeSessionName(req.body?.name ?? req.body?.session ?? 'default')
  await stopSession(name)
  wipeAuthState(name)
  const session = getSessionState(name)
  res.json({ ok: true, name, status: 'STOPPED', authDir: session.authDir })
})

// Reparo remoto de sessão: stop + start
app.post('/api/sessions/restart', async (req, res) => {
  const name = normalizeSessionName(req.body?.name ?? req.body?.session ?? 'default')
  await stopSession(name)
  startSession(name).catch((e) => console.error('[baileys] Erro ao reiniciar:', e))
  res.json({ ok: true, name, status: 'STARTING' })
})

// QR Code — GET /api/:session/auth/qr
app.get('/api/:session/auth/qr', (req, res) => {
  const name = normalizeSessionName(req.params.session)
  const session = getSessionState(name)
  if (session.status !== 'SCAN_QR_CODE' || !session.currentQR) {
    return res.status(422).json({
      error: 'Session status is not as expected. Try again later or restart the session',
      session: name,
      status: session.status,
      expected: ['SCAN_QR_CODE'],
    })
  }

  const format = req.query.format
  if (format === 'image') {
    const base64 = session.currentQR.replace(/^data:image\/\w+;base64,/, '')
    const buf = Buffer.from(base64, 'base64')
    res.set('Content-Type', 'image/png')
    return res.send(buf)
  }
  res.json({ value: session.currentQR })
})

// Listar grupos da sessão — GET /api/:session/groups
app.get('/api/:session/groups', async (req, res) => {
  const name = normalizeSessionName(req.params.session)
  const session = getSessionState(name)
  if (!session.sock || session.status !== 'WORKING') {
    return res.status(422).json({ error: 'Sessão não conectada', session: name, status: session.status })
  }
  try {
    const participating = await session.sock.groupFetchAllParticipating()
    const groups = Object.keys(participating ?? {})
      .filter((jid) => typeof jid === 'string' && jid.endsWith('@g.us'))
      .sort()
    return res.json({ session: name, groups })
  } catch (err) {
    console.error('[baileys] Erro ao listar grupos:', err)
    return res.status(500).json({ error: String(err) })
  }
})

// Enviar mensagem — POST /api/sendText
app.post('/api/sendText', async (req, res) => {
  const sessionName = normalizeSessionName(req.body?.session ?? 'default')
  const { chatId, text } = req.body
  const session = getSessionState(sessionName)
  if (!session.sock || session.status !== 'WORKING') {
    return res.status(422).json({ error: 'Sessão não conectada' })
  }
  try {
    const jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`
    await session.sock.sendMessage(jid, { text })
    res.json({ ok: true, session: sessionName })
  } catch (err) {
    console.error('[baileys] Erro ao enviar:', err)
    res.status(500).json({ error: String(err) })
  }
})

// ── Inicialização ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `[baileys] Gateway rodando na porta ${PORT} (AUTH_DIR=${AUTH_DIR}, requested=${REQUESTED_AUTH_DIR}, fallback=${authDirFallback})`
  )

  // Auto-start das sessões com credenciais salvas
  const defaultCredFile = path.join(resolveSessionAuthDir('default'), 'creds.json')
  if (fs.existsSync(defaultCredFile)) {
    console.log('[baileys] Credenciais default encontradas → conectando automaticamente...')
    startSession('default').catch((e) => console.error('[baileys] Erro no auto-start default:', e))
  }

  const entries = fs.readdirSync(AUTH_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sessionName = normalizeSessionName(entry.name)
    if (!sessionName || sessionName === 'default') continue
    const credFile = path.join(resolveSessionAuthDir(sessionName), 'creds.json')
    if (!fs.existsSync(credFile)) continue
    console.log(`[baileys] Credenciais encontradas para ${sessionName} → conectando automaticamente...`)
    startSession(sessionName).catch((e) => console.error(`[baileys] Erro no auto-start ${sessionName}:`, e))
  }
})
