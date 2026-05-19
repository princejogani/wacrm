-- WhatsApp Web (whatsapp-web.js) session storage
-- Stores serialized session data so the client can restore without re-scanning QR.

CREATE TABLE IF NOT EXISTS whatsappweb_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_data JSONB,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected', 'pending')),
  phone TEXT,
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

ALTER TABLE whatsappweb_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own wwebjs session" ON whatsappweb_sessions;
CREATE POLICY "Users can manage own wwebjs session" ON whatsappweb_sessions FOR ALL USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON whatsappweb_sessions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsappweb_sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
