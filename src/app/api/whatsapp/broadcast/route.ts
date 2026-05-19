import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { getSession } from '@/lib/whatsapp/wwebjs-manager'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

interface BroadcastResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  error?: string
}

interface NewRecipient {
  phone: string
  params?: string[]
  /** Plain text body — used when falling back to wwebjs */
  text?: string
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const limit = checkRateLimit(`broadcast:${user.id}`, RATE_LIMITS.broadcast)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
    } = body

    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params) ? template_params : []
      recipients = phone_numbers.map((phone: string) => ({ phone, params: shared }))
    } else {
      return NextResponse.json(
        { error: 'Provide either `recipients` or `phone_numbers` — must be a non-empty array' },
        { status: 400 },
      )
    }

    if (!template_name) {
      return NextResponse.json({ error: 'template_name is required' }, { status: 400 })
    }

    // ── Determine transport ───────────────────────────────────────────
    const { data: metaConfig } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('user_id', user.id)
      .eq('status', 'connected')
      .maybeSingle()

    const wwebjsSession = getSession(user.id)
    const useWwebjs = !metaConfig && wwebjsSession?.status === 'connected'

    if (!metaConfig && !useWwebjs) {
      return NextResponse.json(
        { error: 'No WhatsApp connection available. Connect via Meta API or scan the QR code.' },
        { status: 400 },
      )
    }

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    if (useWwebjs) {
      for (const recipient of recipients) {
        const messageText = recipient.text != null && recipient.text !== '' ? recipient.text : null
        if (!messageText) {
          results.push({ phone: recipient.phone, status: 'failed', error: 'No message text — template body_text is required for WhatsApp Web broadcasts' })
          failedCount++
          continue
        }
        try {
          const phone = recipient.phone.replace(/\D/g, '')
          const chatId = `${phone}@c.us`
          const msg = await wwebjsSession!.client.sendMessage(chatId, messageText)
          const wwebMsgId = msg.id?.id
          if (!wwebMsgId) {
            results.push({ phone: recipient.phone, status: 'failed', error: 'wwebjs returned no message id' })
            failedCount++
            continue
          }
          results.push({
            phone: recipient.phone,
            status: 'sent',
            whatsapp_message_id: wwebMsgId,
          })
          sentCount++
        } catch (err) {
          const error = err instanceof Error ? err.message : 'Unknown error'
          console.error(`[broadcast/wwebjs] failed to send to ${recipient.phone}:`, error)
          results.push({ phone: recipient.phone, status: 'failed', error })
          failedCount++
        }
      }
    } else {
      // Meta path
      const accessToken = decrypt(metaConfig!.access_token)

      for (const recipient of recipients) {
        const sanitized = sanitizePhoneForMeta(recipient.phone)

        if (!isValidE164(sanitized)) {
          results.push({ phone: recipient.phone, status: 'failed', error: 'Invalid phone number format' })
          failedCount++
          continue
        }

        const variants = phoneVariants(sanitized)
        let sentMessageId: string | null = null
        let lastError: string | null = null

        for (const variant of variants) {
          try {
            const result = await sendTemplateMessage({
              phoneNumberId: metaConfig!.phone_number_id,
              accessToken,
              to: variant,
              templateName: template_name,
              language: template_language || 'en_US',
              params: recipient.params ?? [],
            })
            sentMessageId = result.messageId
            lastError = null
            break
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error'
            if (!isRecipientNotAllowedError(errorMessage)) {
              lastError = errorMessage
              break
            }
            lastError = errorMessage
          }
        }

        if (sentMessageId) {
          results.push({ phone: recipient.phone, status: 'sent', whatsapp_message_id: sentMessageId })
          sentCount++
        } else {
          console.error(`[broadcast/meta] failed to send to ${recipient.phone}:`, lastError)
          results.push({ phone: recipient.phone, status: 'failed', error: lastError || 'Unknown error' })
          failedCount++
        }
      }
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      transport: useWwebjs ? 'wwebjs' : 'meta',
      results,
    })
  } catch (error) {
    console.error('Error in WhatsApp broadcast POST:', error)
    return NextResponse.json({ error: 'Failed to process broadcast' }, { status: 500 })
  }
}
