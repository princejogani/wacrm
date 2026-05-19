/**
 * Automation-side sender.
 * Delegates to unified-sender so automations work whether the user
 * has Meta Cloud API or whatsapp-web.js connected.
 */

import { unifiedSend } from '@/lib/whatsapp/unified-sender'
import { supabaseAdmin } from './admin-client'

interface SendTextArgs {
  userId: string
  conversationId: string
  contactId: string
  text: string
}

interface SendTemplateArgs {
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  params?: string[]
}

export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
  // Scope check — engine uses service-role client, so we verify the
  // contact belongs to the user before sending.
  const db = supabaseAdmin()
  const { data: contact, error } = await db
    .from('contacts')
    .select('id')
    .eq('id', args.contactId)
    .eq('user_id', args.userId)
    .maybeSingle()
  if (error || !contact) throw new Error('contact not found for this user')

  const result = await unifiedSend({
    userId: args.userId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    kind: 'text',
    text: args.text,
  })
  return { whatsapp_message_id: result.messageId }
}

export async function engineSendTemplate(args: SendTemplateArgs): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()
  const { data: contact, error } = await db
    .from('contacts')
    .select('id')
    .eq('id', args.contactId)
    .eq('user_id', args.userId)
    .maybeSingle()
  if (error || !contact) throw new Error('contact not found for this user')

  const result = await unifiedSend({
    userId: args.userId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    kind: 'template',
    templateName: args.templateName,
    language: args.language,
    params: args.params,
  })
  return { whatsapp_message_id: result.messageId }
}
