import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { unifiedSend } from '@/lib/whatsapp/unified-sender'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

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

    const limit = checkRateLimit(`send:${user.id}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json()
    const { conversation_id, message_type, content_text, template_name, template_params } = body

    if (!conversation_id || !message_type) {
      return NextResponse.json(
        { error: 'conversation_id and message_type are required' },
        { status: 400 },
      )
    }
    if (message_type === 'text' && !content_text) {
      return NextResponse.json({ error: 'content_text is required for text messages' }, { status: 400 })
    }
    if (message_type === 'template' && !template_name) {
      return NextResponse.json({ error: 'template_name is required for template messages' }, { status: 400 })
    }

    // Resolve contact from conversation
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('*, contact:contacts(*)')
      .eq('id', conversation_id)
      .eq('user_id', user.id)
      .single()

    if (convError || !conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }
    if (!conversation.contact?.phone) {
      return NextResponse.json({ error: 'Contact phone number not found' }, { status: 400 })
    }

    try {
      const result = await unifiedSend({
        userId: user.id,
        conversationId: conversation_id,
        contactId: conversation.contact.id,
        kind: message_type === 'template' ? 'template' : 'text',
        text: content_text,
        templateName: template_name,
        params: template_params,
      })

      return NextResponse.json({
        success: true,
        whatsapp_message_id: result.messageId,
        transport: result.transport,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('[whatsapp/send] unified send failed:', message)
      return NextResponse.json({ error: message }, { status: 502 })
    }
  } catch (error) {
    console.error('Error in WhatsApp send POST:', error)
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
  }
}
