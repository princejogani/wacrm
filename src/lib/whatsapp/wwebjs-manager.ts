/**
 * whatsapp-web.js client manager.
 */

import { Client, LocalAuth } from 'whatsapp-web.js'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import { processInboundMessage } from '@/lib/whatsapp/inbound-processor'

export type WWebStatus = 'disconnected' | 'pending' | 'connected'

export interface WWebSession {
  client: Client
  status: WWebStatus
  qr: string | null
  listeners: Set<(event: string, data: string) => void>
}

const g = globalThis as typeof globalThis & {
  _wwebSessions?: Map<string, WWebSession>
  _wwebjsBootstrapped?: boolean
  _wwebjsRecentlyProcessed?: Set<string>
  _ackPollers?: Map<string, ReturnType<typeof setInterval>>
}

if (!g._wwebSessions) g._wwebSessions = new Map()
if (!g._wwebjsRecentlyProcessed) g._wwebjsRecentlyProcessed = new Set()
if (!g._ackPollers) g._ackPollers = new Map()

const sessions = g._wwebSessions
const recentlyProcessed = g._wwebjsRecentlyProcessed
const ackPollers = g._ackPollers

function adminSupabase() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

function markProcessed(id: string) {
  recentlyProcessed.add(id)
  setTimeout(() => recentlyProcessed.delete(id), 60_000)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleInboundDM(userId: string, msg: any) {
  const msgId: string = msg.id?.id
  if (!msgId || recentlyProcessed.has(msgId)) return
  markProcessed(msgId)

  console.log(`[wwebjs] inbound from=${msg.from} body="${String(msg.body ?? '').slice(0, 60)}"`)

  try {
    const contact = await msg.getContact()

    // Final guard: verify this is actually a DM chat, not a group
    // (catches edge cases where isGroupMsg flag isn't set)
    try {
      const chat = await msg.getChat()
      if (chat.isGroup) {
        console.log(`[wwebjs] skipping group message from chat: ${chat.name}`)
        return
      }
    } catch { /* if getChat fails, proceed */ }

    // For @lid contacts, contact.number is the internal lid id, not the phone.
    // The real phone is in contact.id._serialized when it ends with @c.us,
    // or we can get it from the chat id which always uses the real number.
    let rawPhone: string
    const contactSerialized: string = contact.id?._serialized ?? ''
    if (contactSerialized.endsWith('@c.us')) {
      // Standard contact — extract digits before @c.us
      rawPhone = contactSerialized.replace('@c.us', '')
    } else {
      // @lid contact — get the real phone from the chat
      try {
        const chat = await msg.getChat()
        const chatId: string = chat.id?._serialized ?? ''
        rawPhone = chatId.replace(/@\w+$/, '')
      } catch {
        // Last resort: use contact.number (may be lid but better than nothing)
        rawPhone = contact.number || contactSerialized.replace(/@\w+$/, '')
      }
    }

    console.log(`[wwebjs] resolved phone: ${rawPhone} (from=${msg.from})`)
    await processInboundMessage(userId, {
      from: rawPhone,
      senderName: contact.pushname || contact.name || undefined,
      text: msg.body || undefined,
      contentType: 'text',
      externalId: msgId,
      timestamp: new Date((msg.timestamp as number) * 1000).toISOString(),
    })
    console.log(`[wwebjs] saved: phone=+${rawPhone}`)
  } catch (err) {
    console.error('[wwebjs] inbound processing failed:', err)
  }
}

async function persistStatus(userId: string, status: WWebStatus, phone?: string) {
  await adminSupabase().from('whatsappweb_sessions').upsert(
    {
      user_id: userId,
      status,
      phone: phone ?? null,
      connected_at: status === 'connected' ? new Date().toISOString() : null,
    },
    { onConflict: 'user_id' },
  )
}

export async function getOrCreateSession(userId: string): Promise<WWebSession> {
  // Already exists — return as-is, listeners were registered at creation time
  // and survive because we never call removeAllListeners on an active client
  if (sessions.has(userId)) return sessions.get(userId)!

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  })

  const session: WWebSession = {
    client,
    status: 'pending',
    qr: null,
    listeners: new Set(),
  }
  sessions.set(userId, session)

  // Register all listeners ONCE at creation — never removed
  client.on('qr', (qr) => {
    session.qr = qr
    session.status = 'pending'
    broadcastToSSE(session, 'qr', qr)
  })

  client.on('ready', async () => {
    session.status = 'connected'
    session.qr = null
    const phone = client.info?.wid?.user ?? undefined
    console.log(`[wwebjs] ready: userId=${userId} phone=${phone}`)
    broadcastToSSE(session, 'ready', phone ?? '')
    await persistStatus(userId, 'connected', phone)
    startAckPoller(userId, client)
  })

  client.on('authenticated', () => {
    session.status = 'connected'
    broadcastToSSE(session, 'authenticated', '')
  })

  client.on('auth_failure', async () => {
    session.status = 'disconnected'
    broadcastToSSE(session, 'auth_failure', '')
    sessions.delete(userId)
    stopAckPoller(userId)
    await persistStatus(userId, 'disconnected')
  })

  client.on('disconnected', async () => {
    session.status = 'disconnected'
    broadcastToSSE(session, 'disconnected', '')
    sessions.delete(userId)
    stopAckPoller(userId)
    await persistStatus(userId, 'disconnected')
  })

  client.on('message_ack', async (msg, ack) => {
    if (!msg.fromMe) return
    await applyAck(msg.id.id, ack)
  })

  client.on('message', async (msg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = msg as any
    console.log(`[wwebjs] message event: from=${m.from} isGroupMsg=${m.isGroupMsg} fromMe=${m.fromMe}`)
    if (m.fromMe) return
    if (m.isGroupMsg) return
    const from = m.from as string
    if (from.endsWith('@g.us') || from.endsWith('@broadcast')) return
    await handleInboundDM(userId, m)
  })

  client.on('message_create', async (msg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = msg as any
    if (m.fromMe) return
    if (m.isGroupMsg) return
    const from = m.from as string
    if (from.endsWith('@g.us') || from.endsWith('@broadcast')) return
    await handleInboundDM(userId, m)
  })

  client.initialize().catch(console.error)

  return session
}

export function getSession(userId: string): WWebSession | undefined {
  return sessions.get(userId)
}

export async function destroySession(userId: string): Promise<void> {
  stopAckPoller(userId)
  const session = sessions.get(userId)
  if (session) {
    try { await session.client.destroy() } catch { /* ignore */ }
    sessions.delete(userId)
  }
  await persistStatus(userId, 'disconnected')
}

// Bootstrap: restore sessions on module load
async function bootstrapSessions() {
  if (g._wwebjsBootstrapped) return
  g._wwebjsBootstrapped = true

  try {
    const { data: rows } = await adminSupabase()
      .from('whatsappweb_sessions')
      .select('user_id')
      .eq('status', 'connected')

    for (const row of rows ?? []) {
      getOrCreateSession(row.user_id).catch((err) =>
        console.error('[wwebjs] bootstrap restore failed:', err),
      )
    }
  } catch (err) {
    console.error('[wwebjs] bootstrap failed:', err)
  }
}

bootstrapSessions()

// Ack polling
function startAckPoller(userId: string, client: Client) {
  if (ackPollers.has(userId)) return
  const timer = setInterval(() => pollAcks(userId, client), 30_000)
  ackPollers.set(userId, timer)
}

function stopAckPoller(userId: string) {
  const t = ackPollers.get(userId)
  if (t) { clearInterval(t); ackPollers.delete(userId) }
}

async function pollAcks(userId: string, client: Client) {
  try {
    const { data: rows } = await adminSupabase()
      .from('broadcast_recipients')
      .select('id, whatsapp_message_id, status, broadcasts!inner(user_id)')
      .eq('broadcasts.user_id', userId)
      .eq('status', 'sent')
      .not('whatsapp_message_id', 'is', null)
      .limit(20)

    if (!rows?.length) return
    for (const row of rows) {
      try {
        const msg = await client.getMessageById(row.whatsapp_message_id)
        if (msg) await applyAck(row.whatsapp_message_id, msg.ack)
      } catch { /* skip */ }
    }
  } catch (err) {
    console.error('[wwebjs] ack poll failed:', err)
  }
}

async function applyAck(msgId: string, ack: number) {
  let newStatus: string | null = null
  if (ack === -1) newStatus = 'failed'
  else if (ack === 2) newStatus = 'delivered'
  else if (ack >= 3) newStatus = 'read'
  if (!newStatus) return

  const { data: recipient } = await adminSupabase()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', msgId)
    .maybeSingle()

  if (!recipient) return

  const ladder = ['failed', 'pending', 'sent', 'delivered', 'read', 'replied']
  if (ladder.indexOf(newStatus) <= ladder.indexOf(recipient.status)) return

  const now = new Date().toISOString()
  const update: Record<string, string> = { status: newStatus }
  if (newStatus === 'delivered') update.delivered_at = now
  if (newStatus === 'read') update.read_at = now
  if (newStatus === 'failed') update.error_message = 'Delivery failed (wwebjs ack -1)'

  await adminSupabase().from('broadcast_recipients').update(update).eq('id', recipient.id)
}

function broadcastToSSE(session: WWebSession, event: string, data: string) {
  for (const fn of session.listeners) {
    try { fn(event, data) } catch { session.listeners.delete(fn) }
  }
}
