/**
 * Shared inbound message processor.
 *
 * Called by:
 *   - Meta webhook (POST /api/whatsapp/webhook)
 *   - whatsapp-web.js message listener (wwebjs-manager)
 *
 * Writes contact, conversation, message to Supabase and fires automations.
 */

import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import { normalizePhone, phonesMatch } from '@/lib/whatsapp/phone-utils'
import { runAutomationsForTrigger } from '@/lib/automations/engine'

function adminDb() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export interface InboundMessage {
  /** E.164 or raw phone of the sender */
  from: string
  /** Display name if available */
  senderName?: string
  /** Message text body */
  text?: string
  /** Media URL (already resolved/proxied) */
  mediaUrl?: string
  /** content_type value matching the DB CHECK constraint */
  contentType: 'text' | 'image' | 'document' | 'audio' | 'video' | 'location' | 'template'
  /** External message id (Meta wamid or wwebjs id) */
  externalId: string
  /** ISO timestamp */
  timestamp: string
}

export async function processInboundMessage(userId: string, msg: InboundMessage) {
  const db = adminDb()
  const senderPhone = normalizePhone(msg.from)

  console.log(`[inbound] processing: userId=${userId} phone=${senderPhone} text="${msg.text?.slice(0,40)}"`)

  // ── Find or create contact ────────────────────────────────────────
  const { data: contacts, error: contactsErr } = await db
    .from('contacts')
    .select('*')
    .eq('user_id', userId)

  if (contactsErr) {
    console.error('[inbound] contacts fetch failed:', contactsErr)
    return
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let contactRecord: any = (contacts ?? []).find((c: any) => phonesMatch(c.phone, senderPhone))
  let wasCreated = false

  if (contactRecord) {
    // Update name if we now have one and it's different (or was missing)
    if (msg.senderName && msg.senderName !== contactRecord.name) {
      await db
        .from('contacts')
        .update({ name: msg.senderName, updated_at: new Date().toISOString() })
        .eq('id', contactRecord.id)
      contactRecord.name = msg.senderName
    }
    // Migrate + prefix to digits-only if stored with +
    if (contactRecord.phone && contactRecord.phone.startsWith('+')) {
      const digits = contactRecord.phone.replace(/\D/g, '')
      await db
        .from('contacts')
        .update({ phone: digits, updated_at: new Date().toISOString() })
        .eq('id', contactRecord.id)
      contactRecord.phone = digits
    }
  } else {
    const { data: newContact, error: createErr } = await db
      .from('contacts')
      .insert({ user_id: userId, phone: senderPhone, name: msg.senderName || senderPhone })
      .select()
      .single()
    if (createErr || !newContact) {
      console.error('[inbound] contact create failed:', createErr)
      return
    }
    contactRecord = newContact
    wasCreated = true
  }

  // ── Find or create conversation ───────────────────────────────────
  const { data: existingConv } = await db
    .from('conversations')
    .select('*')
    .eq('user_id', userId)
    .eq('contact_id', contactRecord.id)
    .maybeSingle()

  let conversation = existingConv
  if (!conversation) {
    const { data: newConv, error: convErr } = await db
      .from('conversations')
      .insert({ user_id: userId, contact_id: contactRecord.id })
      .select()
      .single()
    if (convErr || !newConv) {
      console.error('[inbound] conversation create failed:', convErr)
      return
    }
    conversation = newConv
  }

  // ── Check first inbound ───────────────────────────────────────────
  const { count: priorCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInbound = (priorCount ?? 0) === 0

  // ── Insert message ────────────────────────────────────────────────
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: msg.contentType,
    content_text: msg.text ?? null,
    media_url: msg.mediaUrl ?? null,
    message_id: msg.externalId,
    status: 'delivered',
    created_at: msg.timestamp,
  })
  if (msgErr) {
    console.error('[inbound] message insert failed:', msgErr)
    return
  }

  // ── Update conversation ───────────────────────────────────────────
  await db
    .from('conversations')
    .update({
      last_message_text: msg.text || `[${msg.contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  // ── Broadcast reply flag ──────────────────────────────────────────
  try {
    const { data: recs } = await db
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(user_id)')
      .eq('contact_id', contactRecord.id)
      .eq('broadcasts.user_id', userId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)
    if (recs && recs.length > 0) {
      await db
        .from('broadcast_recipients')
        .update({ status: 'replied', replied_at: new Date().toISOString() })
        .eq('id', recs[0].id)
    }
  } catch (err) {
    console.error('[inbound] broadcast reply flag failed:', err)
  }

  // ── Fire automations ──────────────────────────────────────────────
  const triggers: ('new_contact_created' | 'first_inbound_message' | 'new_message_received' | 'keyword_match')[] =
    ['new_message_received', 'keyword_match']
  if (wasCreated) triggers.unshift('new_contact_created')
  if (isFirstInbound) triggers.unshift('first_inbound_message')

  for (const triggerType of triggers) {
    runAutomationsForTrigger({
      userId,
      triggerType,
      contactId: contactRecord.id,
      context: { message_text: msg.text ?? '', conversation_id: conversation.id },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }
}
