/**
 * GET /api/whatsapp/wwebjs/qr
 *
 * Server-Sent Events stream. Emits:
 *   event: qr       data: <raw QR string>
 *   event: ready    data: <phone number>
 *   event: connected data: ""   (already connected, no QR needed)
 *   event: error    data: <message>
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateSession, getSession } from '@/lib/whatsapp/wwebjs-manager'

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: string) {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${data}\n\n`),
        )
      }

      // If already connected in memory, tell the client immediately
      const existing = getSession(user.id)
      if (existing?.status === 'connected') {
        send('connected', existing.client.info?.wid?.user ?? '')
        controller.close()
        return
      }

      // If there's already a pending QR, send it right away
      if (existing?.qr) {
        send('qr', existing.qr)
      }

      const session = await getOrCreateSession(user.id)

      // If QR already available after init
      if (session.qr) send('qr', session.qr)
      if (session.status === 'connected') {
        send('connected', session.client.info?.wid?.user ?? '')
        controller.close()
        return
      }

      function listener(event: string, data: string) {
        send(event, data)
        if (event === 'ready' || event === 'connected' || event === 'auth_failure' || event === 'disconnected') {
          session.listeners.delete(listener)
          controller.close()
        }
      }

      session.listeners.add(listener)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
