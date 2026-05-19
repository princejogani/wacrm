-- Strip + prefix from contact phone numbers — store as digits only.
-- Idempotent — only updates rows that still have a + prefix.

UPDATE contacts
SET
  phone = regexp_replace(phone, '[^0-9]', '', 'g'),
  updated_at = NOW()
WHERE
  phone IS NOT NULL
  AND phone LIKE '+%';
