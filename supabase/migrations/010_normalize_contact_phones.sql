-- Normalize all existing contact phone numbers to E.164 format (+digits).
-- Idempotent — skips contacts already starting with +.

UPDATE contacts
SET
  phone = '+' || regexp_replace(phone, '[^0-9]', '', 'g'),
  updated_at = NOW()
WHERE
  phone IS NOT NULL
  AND phone != ''
  AND phone NOT LIKE '+%';
