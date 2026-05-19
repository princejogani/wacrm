/**
 * POST /api/whatsapp/wwebjs/init
 *
 * Called on app mount (inbox, dashboard). If the user has a connected
 * wwebjs session in the DB but no in-memory client, this restores it
 * so incoming messages are received without requiring a settings visit.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateSession, getSession } from '@/lib/whatsapp/wwebjs-manager'

export const dynamic = 'force-dynamic'

export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Already in memory — nothing to do
  if (getSession(user.id)) {
    return NextResponse.json({ restored: false, reason: 'already_active' })
  }

  const { data } = await supabase
    .from('whatsappweb_sessions')
    .select('status')
    .eq('user_id', user.id)
    .maybeSingle()

  if (data?.status !== 'connected') {
    return NextResponse.json({ restored: false, reason: 'not_connected' })
  }

  // Restore async — don't wait for Puppeteer to fully initialize
  getOrCreateSession(user.id).catch((err) =>
    console.error('[wwebjs/init] restore failed:', err),
  )

  return NextResponse.json({ restored: true })
}
