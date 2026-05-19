/**
 * Unified WhatsApp sender.
 *
 * Priority:
 *   1. Meta Cloud API  — if whatsapp_config row exists and is connected
 *   2. whatsapp-web.js — if a wwebjs session is connected in memory
 *
 * Both paths write the sent message to the DB and update the conversation,
 * so the inbox and automations work identically regardless of which
 * transport was used.
 */

import { sendTextMessage, sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { getSession } from '@/lib/whatsapp/wwebjs-manager'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'

function adminDb() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export type SendKind = 'text' | 'template'

export interface UnifiedSendArgs {
  userId: string
  conversationId: string
  contactId: string
  kind: SendKind
  // text
  text?: string
  // template
  templateName?: string
  language?: string
  params?: string[]
}

export interface UnifiedSendResult {
  messageId: string
  transport: 'meta' | 'wwebjs'
}

export async function unifiedSend(args: UnifiedSendArgs): Promise<UnifiedSendResult> {
  const db = adminDb()

  // Resolve contact phone
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', args.contactId)
    .eq('user_id', args.userId)
    .maybeSingle()
  if (contactErr || !contact?.phone) throw new Error('contact not found')

  // ── Try Meta first ────────────────────────────────────────────────
  const { data: metaConfig } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('user_id', args.userId)
    .eq('status', 'connected')
    .maybeSingle()

  if (metaConfig) {
    try {
      const accessToken = decrypt(metaConfig.access_token)
      const sanitized = sanitizePhoneForMeta(contact.phone)
      if (!isValidE164(sanitized)) throw new Error(`invalid phone: ${contact.phone}`)

      const variants = phoneVariants(sanitized)
      let waMessageId = ''
      let lastError: unknown = null

      for (const variant of variants) {
        try {
          if (args.kind === 'template') {
            const r = await sendTemplateMessage({
              phoneNumberId: metaConfig.phone_number_id,
              accessToken,
              to: variant,
              templateName: args.templateName!,
              language: args.language,
              params: args.params,
            })
            waMessageId = r.messageId
          } else {
            const r = await sendTextMessage({
              phoneNumberId: metaConfig.phone_number_id,
              accessToken,
              to: variant,
              text: args.text!,
            })
            waMessageId = r.messageId
          }
          lastError = null
          break
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (!isRecipientNotAllowedError(msg)) throw err
          lastError = err
        }
      }
      if (lastError) throw lastError

      await persistSentMessage(db, args, waMessageId, 'meta')
      return { messageId: waMessageId, transport: 'meta' }
    } catch (err) {
      console.warn('[unified-send] Meta failed, trying wwebjs:', err instanceof Error ? err.message : err)
    }
  }

  // ── Fall back to whatsapp-web.js ──────────────────────────────────
  const session = getSession(args.userId)
  if (!session || session.status !== 'connected') {
    throw new Error(
      'No WhatsApp connection available. Connect via Meta API or scan the QR code in Settings.',
    )
  }

  if (args.kind === 'template') {
    throw new Error(
      'Template messages require a Meta Business API connection. Connect Meta or use a plain text message.',
    )
  }

  // Strip non-digits to build wwebjs chatId — wwebjs expects digits only, no +
  const phone = contact.phone.replace(/\D/g, '')
  if (!phone) throw new Error(`Cannot send: contact has no valid phone number`)
  const chatId = `${phone}@c.us`

  let wwebMsg
  try {
    wwebMsg = await session.client.sendMessage(chatId, args.text!)
  } catch (err) {
    throw new Error(`wwebjs send failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const msgId = wwebMsg?.id?.id
  if (!msgId) throw new Error('wwebjs returned no message id')

  await persistSentMessage(db, args, msgId, 'wwebjs')
  return { messageId: msgId, transport: 'wwebjs' }
}

async function persistSentMessage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  args: UnifiedSendArgs,
  messageId: string,
  transport: 'meta' | 'wwebjs',
) {
  const contentType = args.kind === 'template' ? 'template' : 'text'
  await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'agent',
    content_type: contentType,
    content_text: args.kind === 'text' ? args.text : null,
    template_name: args.kind === 'template' ? args.templateName : null,
    message_id: messageId,
    status: 'sent',
  })

  await db
    .from('conversations')
    .update({
      last_message_text:
        args.kind === 'template' ? `[template:${args.templateName}]` : args.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  if (transport === 'wwebjs') {
    // Mark wwebjs session as the active transport for this user
    console.info(`[unified-send] sent via wwebjs for user ${args.userId}`)
  }
}
