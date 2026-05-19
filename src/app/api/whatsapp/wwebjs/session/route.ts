import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { destroySession, getOrCreateSession, getSession } from '@/lib/whatsapp/wwebjs-manager'

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

  // In-memory session exists — return it directly
  const inMemory = getSession(user.id)
  if (inMemory) {
    return NextResponse.json({
      status: inMemory.status,
      phone: inMemory.status === 'connected' ? (inMemory.client.info?.wid?.user ?? null) : null,
    })
  }

  // No in-memory session — check DB
  const { data } = await supabase
    .from('whatsappweb_sessions')
    .select('status, phone')
    .eq('user_id', user.id)
    .maybeSingle()

  // If DB says connected, restore the session now (re-registers all listeners)
  if (data?.status === 'connected') {
    getOrCreateSession(user.id).catch((err) =>
      console.error('[wwebjs/session] restore failed:', err),
    )
  }

  return NextResponse.json({
    status: data?.status ?? 'disconnected',
    phone: data?.phone ?? null,
  })
}

export async function DELETE() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await destroySession(user.id)
  return NextResponse.json({ success: true })
}
